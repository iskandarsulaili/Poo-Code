import * as vscode from "vscode"

import { RooCodeEventName, type HistoryItem } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"
import { getModeBySlug } from "../../shared/modes"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { RequirementsVerifier } from "../../services/self-improving/RequirementsVerifier"
import { VerificationEngine } from "../../services/self-improving/VerificationEngine"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void>
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	/** Fix 1: Orchestrator mode slugs — used by wiring verification and deep audit. */
	private static readonly ORCHESTRATOR_SLUGS = [
		"orchestrator",
		"one-shot-orchestrator",
		"kaizen-orchestrator",
		"vigorous-stlc-orchestrator",
	]

	/**
	 * Tracks the last result text per task to guard against duplicate completions.
	 * Unlike a permanent boolean flag, this allows new attempt_completion calls
	 * with different result content (e.g., after user feedback or a new task cycle).
	 * Only exact duplicate result text is blocked.
	 */
	private static lastResults = new Map<string, string>()

	/** Optional requirements verifier for checking user intent fulfillment */
	private requirementsVerifier?: RequirementsVerifier
	/** Optional verification engine for code quality checks */
	private verificationEngine?: VerificationEngine
	/** Tracks consecutive verification failures for lenient mode retry logic */
	private consecutiveVerificationFailures = 0

	// ========================================================================
	// Fix 2+3: Child task file tracking — files modified by delegated children
	// are stored here so the parent's verification can include them.
	// Key: parentTaskId → childTaskId → file paths modified by that child
	// ========================================================================
	private static childTaskFiles = new Map<string, Map<string, string[]>>()
	/** Aggregate file paths from this task and its own child tasks only (no sibling pollution). */
	private aggregateTaskFiles(task: Task): string[] {
		const ownFiles = this.extractToolCallFiles(task.apiConversationHistory)
		const allFiles = new Set(ownFiles)
		// Only include children whose DIRECT parent is this task (parentTaskId)
		// This prevents sibling A's files from leaking into sibling B's aggregate.
		// Fix 1: Snapshot copy for thread safety under concurrent parallel subtasks
		const childrenMap = AttemptCompletionTool.childTaskFiles.get(task.taskId)
		if (childrenMap) {
			const snapshot = new Map(childrenMap)
			for (const [childId, childFiles] of snapshot.entries()) {
				if (childId === '__thoughts__') continue // Skip thought entries
				for (const f of childFiles) allFiles.add(f)
			}
		}
		return [...allFiles]
	}

	/** Fix 2: Expire child task file entries older than 1 hour to prevent leaks. */
	private static expireChildTaskFiles(): void {
		const ONE_HOUR_MS = 3600_000
		const now = Date.now()
		// childTaskFiles Map doesn't store timestamps, so prune on every
		// emitTaskCompleted call instead (which runs after successful completion).
		// This sweep provides a safety net for orphaned entries from aborted tasks.
		// The prune is lightweight — iterate parent keys and check if any children remain.
		for (const parentKey of [...AttemptCompletionTool.childTaskFiles.keys()]) {
			const childrenMap = AttemptCompletionTool.childTaskFiles.get(parentKey)
			if (childrenMap && childrenMap.size === 0) {
				AttemptCompletionTool.childTaskFiles.delete(parentKey)
			}
		}
		// Also sweep verificationFailures (duplicates the 1-hour sweep in checkEscalation)
		for (const [tid, rec] of AttemptCompletionTool.verificationFailures) {
			if (now - rec.lastFailAt > ONE_HOUR_MS) {
				AttemptCompletionTool.verificationFailures.delete(tid)
			}
		}
	}

	/** Fix 1: Prune a child task's files from its parent's map (thread-safe). */
	private static pruneChildFiles(taskId: string): void {
		// Fix 1: Snapshot parent keys for thread safety
		for (const parentKey of [...AttemptCompletionTool.childTaskFiles.keys()]) {
			const childrenMap = AttemptCompletionTool.childTaskFiles.get(parentKey)
			if (childrenMap && childrenMap.has(taskId)) {
				childrenMap.delete(taskId)
				if (childrenMap.size === 0) {
					AttemptCompletionTool.childTaskFiles.delete(parentKey)
				}
				break
			}
		}
	}

	// ========================================================================
	// Fix 4: Cross-call verification failure tracking & escalation
	// ========================================================================
	private static readonly MAX_CONSECUTIVE_FAILURES = 5
	private static verificationFailures = new Map<
		string,
		{ count: number; lastFailAt: number; blockedGates: string[] }
	>()

	/** Record a verification failure for a specific task and gate. */
	private static recordGateFailure(taskId: string, gateName: string): void {
		const existing = AttemptCompletionTool.verificationFailures.get(taskId) ?? {
			count: 0,
			lastFailAt: 0,
			blockedGates: [],
		}
		existing.count++
		existing.lastFailAt = Date.now()
		if (!existing.blockedGates.includes(gateName)) {
			existing.blockedGates.push(gateName)
		}
		AttemptCompletionTool.verificationFailures.set(taskId, existing)
	}

	/** Clear verification failure tracking for a task + prune stale entries. */
	private static clearVerificationFailures(taskId: string): void {
		AttemptCompletionTool.verificationFailures.delete(taskId)
		// Fix 2: Also prune all entries older than 1 hour on any clear operation
		try {
			const ONE_HOUR_MS = 3600_000
			for (const [tid, rec] of AttemptCompletionTool.verificationFailures) {
				if (Date.now() - rec.lastFailAt > ONE_HOUR_MS) {
					AttemptCompletionTool.verificationFailures.delete(tid)
				}
			}
		} catch {
			// Non-blocking
		}
	}

	/**
	 * Snapshot build config at task start (Bug 1 fix).
	 * Called from ClineProvider at task creation time, before the agent works.
	 */
	static async snapshotConfigAtTaskStart(task: Task): Promise<void> {
		const tool = attemptCompletionTool
		const engine = tool.getVerificationEngine()
		if (engine && task.cwd) {
			try {
				await engine.snapshotBuildConfig(task.cwd)
			} catch {
				// Non-blocking — snapshot is optional
			}
		}
	}

	/**
	 * Check if verification escalation is needed for this task.
	 * After MAX_CONSECUTIVE_FAILURES consecutive failures, prompt the user.
	 */
	private async checkEscalation(
		task: Task,
		pushToolResult: (result: string) => void,
	): Promise<boolean> {
		// Fix 2: Auto-expire entries older than 1 hour
		const ONE_HOUR_MS = 3600_000
		for (const [tid, rec] of AttemptCompletionTool.verificationFailures) {
			if (Date.now() - rec.lastFailAt > ONE_HOUR_MS) {
				AttemptCompletionTool.verificationFailures.delete(tid)
			}
		}
		const record = AttemptCompletionTool.verificationFailures.get(task.rootTaskId ?? task.taskId)
		if (!record || record.count < AttemptCompletionTool.MAX_CONSECUTIVE_FAILURES) {
			return false // No escalation needed
		}

		// Escalation threshold reached — ask the user
		const { response } = await task.ask(
			"verification_bypass_prompt",
			`Verification has failed ${record.count} times. Recurring failures: ${record.blockedGates.join(", ")}.\n\nBypass verification and proceed, retry, or cancel?`,
		)

		if (response === "yesButtonClicked") {
			// User approved bypass — clear failures and continue
			AttemptCompletionTool.clearVerificationFailures(task.rootTaskId ?? task.taskId)
			return false // Don't block
		}

		// User wants to retry — push a retry tool result
		pushToolResult("Retrying task after verification failure. Please address the verification issues.")
		return true // Signal that we've handled it (caller should return)
	}

	/**
	 * Set the verifiers used to guard completion.
	 */
	setVerifiers(requirementsVerifier?: RequirementsVerifier, verificationEngine?: VerificationEngine): void {
		this.requirementsVerifier = requirementsVerifier
		this.verificationEngine = verificationEngine
	}

	/** Public accessor for build config snapshot (Bug 1). */
	getVerificationEngine(): VerificationEngine | undefined {
		return this.verificationEngine
	}

	/**
	 * Resets the completion tracking state. Used in tests to prevent
	 * cross-test contamination from the static Map.
	 */
	static reset(): void {
		AttemptCompletionTool.lastResults.clear()
	}

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		// Reset cross-task counter bleed on singleton tool
		this.consecutiveVerificationFailures = 0
		const { result: initialResult } = params
		let result: string = initialResult
		const { handleError, pushToolResult, askFinishSubTaskApproval } = callbacks

		// Guard: block only duplicate result text, not ALL future completions
		const lastResult = AttemptCompletionTool.lastResults.get(task.taskId)
		if (lastResult !== undefined && lastResult === result) {
			pushToolResult(
				formatResponse.toolResult("Task already completed with the same result. No further action needed."),
			)
			return
		}

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			// Accumulate requirements from ALL user messages before verification
			if (this.requirementsVerifier) {
				const userMessages = this.getAllUserMessages(task)
				this.requirementsVerifier.processUserMessages(userMessages)
			}

			// Resolve current mode slug for per-mode verification overrides
			const currentMode = await task.getTaskMode()

			// Compute lenient mode for both Guard 5 and Guard 6
			const lenientModes = task.experiments?.lenientModes ?? ["research"]
			const isLenientMode = lenientModes.includes(currentMode)

			// Resolve verification level once for all gates (Bug 2)
			const vLevel = task.experiments?.verificationLevels?.[currentMode] ?? task.experiments?.verificationLevel ?? "strict"

			// Guard 5: Requirements verification — check user intent is fulfilled
			if (this.requirementsVerifier && !isLenientMode) {
				// Apply verification level to the verifier config
				this.requirementsVerifier.updateConfig({ verificationLevel: vLevel })

				// Bypass mode: skip verification entirely
				if (vLevel !== "bypass") {
					const reqResult = await this.requirementsVerifier.verify()
					const isBlocking = vLevel === "strict" && this.requirementsVerifier.getConfig().mandatory
					if (!reqResult.passed && isBlocking) {
						const errorMsg = `Requirements verification failed:\n${reqResult.summary}\n\nFailed requirements:\n${reqResult.failed.map((r) => `  ❌ ${r.text}`).join("\n")}\n\nPending requirements:\n${reqResult.pending.map((r) => `  ⏳ ${r.text}`).join("\n")}\n\nPlease address these requirements before completing the task.`
						// Don't increment consecutiveMistakeCount — verification has its own counter
						AttemptCompletionTool.recordGateFailure(task.rootTaskId ?? task.taskId, "requirements")
						task.recordToolError("attempt_completion")
						pushToolResult(formatResponse.toolError(errorMsg))
						return
					}
					if (vLevel === "lenient" && !reqResult.passed) {
						this.consecutiveVerificationFailures++
						if (this.consecutiveVerificationFailures >= 3) {
							const bypassResponse = (
								await task.ask(
									"verification_bypass_prompt",
									"Verification has failed 3 consecutive times. Bypass verification and proceed, or retry?",
								)
							).response
							if (bypassResponse === "yesButtonClicked") {
								this.consecutiveVerificationFailures = 0
							} else {
								this.consecutiveVerificationFailures = 0
								return this.execute(params, task, callbacks)
							}
						}
					} else if (reqResult.passed) {
						this.consecutiveVerificationFailures = 0
					}
				}
			}

			// ========================================================================
			// Fix G: Tool error rate check
			// ========================================================================
			if (!isLenientMode) {
				const toolErrors = task.clineMessages.filter(
					(msg) => msg.type === "say" && msg.say === "error" && msg.text?.includes("tool"),
				).length
				if (toolErrors > 5) {
					console.log(
						`[AttemptCompletionTool] ⚠ ${toolErrors} tool error(s) during task — high error rate detected`,
					)
				} else if (toolErrors > 0) {
					console.log(
						`[AttemptCompletionTool] ${toolErrors} tool error(s) during task`,
					)
				}
			}

			// ========================================================================
			// Fix 5: Forward child reasoning thoughts to webview
			// ========================================================================
			if (!isLenientMode) {
				const ownChildren = AttemptCompletionTool.childTaskFiles.get(task.taskId)
				if (ownChildren) {
					const childThoughts = ownChildren.get('__thoughts__') || []
					for (const thought of childThoughts) {
						task.providerRef.deref()?.postMessageToWebview?.({
							type: "parallelSubtaskThought",
							payload: { subtaskId: task.parentTaskId || task.taskId, token: thought },
						})
					}
					// Clear after forwarding so duplicates aren't sent
					ownChildren.delete('__thoughts__')
				}
			}

			// ========================================================================
			// Cross-reference: auto-verify requirements against API conversation history (Fix A)
			// This checks whether files were actually modified in ways that match
			// the extracted requirements, providing concrete evidence.
			// ========================================================================
			if (this.requirementsVerifier && !isLenientMode && vLevel !== "bypass") {
				try {
					// CRITICAL: Pass apiConversationHistory, NOT clineMessages.
					// tool_use blocks with actual file paths live in API history,
					// not in clineMessages (which only contain display text).
					this.requirementsVerifier.autoVerifyFromToolHistory(task.apiConversationHistory, task.cwd)
				} catch (error) {
					// Non-blocking — auto-verification is advisory
					console.error(
						`[AttemptCompletionTool] Error during requirements auto-verification: ${(error as Error)?.message ?? String(error)}`,
					)
				}
			}


			// ========================================================================
			// Fix F: Cross-reference completion claim against actual file changes
			// Check if the result text mentions files that weren't actually modified.
			// Blocking when >50% of claims are unverifiable.
			// ========================================================================
			if (!isLenientMode && result && vLevel !== "bypass") {
				const filePattern = /(?:^|[\/\s])([\w_.-]+\.\w{1,5})\b/g
				const mentionedFiles = [...result.matchAll(filePattern)].map((m) => m[1].toLowerCase())
				if (mentionedFiles.length > 0) {
					const changedForClaim = new Set([
						...this.aggregateTaskFiles(task).map((f) => {
							// Strip leading ./ and directory prefix for matching
							const clean = f.replace(/^\.\//, "").toLowerCase()
							return clean
						}),
					])
					const verified = mentionedFiles.filter(
						(f) => changedForClaim.has(f) || changedForClaim.has(`/${f}`) || [...changedForClaim].some((a) => a.endsWith(`/${f}`) || a === f),
					)
					const unverified = mentionedFiles.filter((f) => !verified.includes(f))

					if (unverified.length > mentionedFiles.length * 0.5) {
						const errorMsg = `Completion result claims changes to ${mentionedFiles.length} file(s), but ${unverified.length}/${mentionedFiles.length} cannot be verified from tool call history:\n` +
							unverified.map((f) => `  ❌ ${f}`).join("\n") +
							`\n\nActually modified files: ${[...changedForClaim].join(", ") || "(none)"}` +
							`\n\nPlease verify these files exist and were correctly modified before completing.`
						task.recordToolError("attempt_completion")
						pushToolResult(formatResponse.toolError(errorMsg))
						return
					}

					if (unverified.length > 0) {
						console.log(
							`[AttemptCompletionTool] \u26a0 ${unverified.length}/${mentionedFiles.length} file claim(s) unverifiable: ${unverified.join(", ")}`,
						)
					}
				}
			}

			// ========================================================================
			// Result substance check
			// ========================================================================
			// Result substance check — reject empty or trivial result text
			// ========================================================================
			if (!isLenientMode && result && vLevel !== "bypass") {
				const stripped = result.replace(/[*_~`#\n\r]/g, "").trim()
				if (stripped.length < 20) {
					const errorMsg = `Completion result is too short (${stripped.length} chars). Please provide a substantive summary of what was implemented.\n\n` +
						`Current result: "${result.slice(0, 100)}"\n\nInclude specific details about what was changed, added, or fixed.`
					task.recordToolError("attempt_completion")
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}

				// Check for evasion language
				const evasionPatterns = [
					/nothing/i, /no changes/i, /did nothing/i, /could not/i,
					/failed/i, /unable to/i, /not implemented/i,
				]
				const evasionMatches = evasionPatterns.filter((p) => p.test(stripped))
				if (evasionMatches.length >= 2 && stripped.length < 80) {
					const errorMsg = `Completion result appears to indicate failure: "${result.slice(0, 120)}"\n\n` +
						`If the task is incomplete, explain what was attempted and what remains. Do not mark the task as complete when work was unsuccessful.`
					task.recordToolError("attempt_completion")
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}
			}

			// Guard 6: Code quality verification (VerificationEngine)
			// Skip verification for lenient modes, bypass mode, and child tasks (parent re-verifies — Fix 1)
			// Default lenient modes: ["research"]
			if (this.verificationEngine && !isLenientMode && vLevel !== "bypass" && !task.parentTaskId) {
				// Set cwd from task context — the directory the agent is working in
				// This replaces the flawed workspace-folder heuristic (detectUserProjectCwd)
				this.verificationEngine.updateConfig({ cwd: task.cwd })
				await this.verificationEngine.applyAutoProfile(task.cwd)
				// Extract tool call file paths (scoped inside verification block, not before)
				const toolCallFilePaths = this.aggregateTaskFiles(task)
				// Pass tool call file paths for file-changes gate scoping
				const verResult = await this.verificationEngine.verify(toolCallFilePaths)
				const strictness = this.verificationEngine.getConfig().strictness || "moderate"

				// Build detailed gate results for display
				const gateDetails = verResult.gates
					.map((g) => {
						if (g.skipped) {
							const skipReason = g.skipReason ? `: ${g.skipReason}` : ""
							return `  ⏭️ ${g.name}: SKIP [${g.strictness}]${skipReason}`
						}
						const icon = g.passed ? "✅" : "❌"
						const warningsNote = g.warnings > 0 ? ` (${g.warnings} warning${g.warnings !== 1 ? "s" : ""})` : ""
						const errorsNote = g.errors > 0 ? ` (${g.errors} error${g.errors !== 1 ? "s" : ""})` : ""
						const passLabel = g.passed ? `PASS [${g.strictness}]` : `FAIL [${g.strictness}]`
						const errorInfo = !g.passed && g.error ? `: ${g.error.slice(0, 200)}` : ""
						return `  ${icon} ${g.name}: ${passLabel} (${g.durationMs}ms)${warningsNote}${errorsNote}${errorInfo}`
					})
					.join("\n")

				if (!verResult.passed && this.verificationEngine.getConfig().mandatory && !verResult.allSkipped) {
					const errorMsg = `Code quality verification failed [${strictness}]:\n${verResult.summary}\n\n${gateDetails}\n\nPlease fix these issues before completing the task.`
					AttemptCompletionTool.recordGateFailure(task.rootTaskId ?? task.taskId, "code-quality")
					task.recordToolError("attempt_completion")
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}

				// Even on pass, show warning counts if any
				// (VerificationEngine already logs details via its own logger)
			}

			// ========================================================================
			// Orchestrator Code Wiring Verification — build/lint/test/typecheck
			// Only runs in orchestrator modes (orchestrator, one-shot-orchestrator,
			// kaizen-orchestrator, vigorous-stlc-orchestrator). Uses a fresh
			// VerificationEngine instance to run build/lint/test/typecheck commands
			// regardless of lenient mode or bypass settings.
			// ========================================================================
			if (AttemptCompletionTool.ORCHESTRATOR_SLUGS.includes(currentMode) && !task.parentTaskId && this.verificationEngine) {
				// Clone config with build/lint/types/tests forced on
				this.verificationEngine.updateConfig({ cwd: task.cwd })
				await this.verificationEngine.applyAutoProfile(task.cwd)
				// Force enable all code quality checks
				const currentConfig = this.verificationEngine.getConfig()
				this.verificationEngine.updateConfig({
					checkBuild: currentConfig.buildCommand ? true : false,
					checkLint: currentConfig.lintCommand ? true : false,
					checkTypes: currentConfig.typeCheckCommand ? true : false,
					checkTests: currentConfig.testCommand ? true : false,
					checkFileChanges: false,
					checkBuildConfigIntegrity: false,
				})
				const codeResult = await this.verificationEngine.verify(this.aggregateTaskFiles(task))
				const codeGates = codeResult.gates.filter((g) =>
					["build", "lint", "type-check", "tests"].includes(g.name),
				)
				const codeFailed = codeGates.filter((g) => !g.passed && !g.skipped)
				if (codeFailed.length > 0) {
					const gateDetails = codeGates
						.map((g) => {
							const icon = g.passed ? "✅" : g.skipped ? "⏭️" : "❌"
							const note = g.passed
								? `PASS (${g.durationMs}ms)`
								: g.skipped
									? `SKIP (${g.skipReason || "not available"})`
									: `FAIL (${g.durationMs}ms)${g.error ? `: ${g.error.slice(0, 200)}` : ""}`
							return `  ${icon} ${g.name}: ${note}`
						})
						.join("\n")
					const errorMsg =
						`[Orchestrator Code Wiring Verification] ${codeFailed.length}/${codeGates.length} gate(s) FAILED.\n\n` +
						`Orchestrator mode requires passing code quality gates before completing.\n\n${gateDetails}` +
						`\n\nPlease fix these issues and retry with attempt_completion.`
					task.recordToolError("attempt_completion")
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}
				// Log passing gates for transparency
				const passCount = codeGates.filter((g) => g.passed).length
				const skipCount = codeGates.filter((g) => g.skipped).length
				if (passCount > 0 || skipCount > 0) {
					console.log(
						`[Orchestrator] Code wiring verification: ${passCount} passed, ${skipCount} skipped`,
					)
				}
			}
			// ========================================================================

			// ========================================================================
			// Orchestrator Deep Code Audit — comprehensive missing-code/flaw/blind-spot check
			// Non-blocking: findings appended to completion result for user review.
			// Only runs after wiring verification passes in orchestrator modes.
			// ========================================================================
			if (AttemptCompletionTool.ORCHESTRATOR_SLUGS.includes(currentMode) && !task.parentTaskId) {
				const auditSections: string[] = []
				auditSections.push("# Deep Code Audit Report")
				auditSections.push("")
				auditSections.push("Generated at completion to surface potential issues for your review.")
				auditSections.push("")

				// 1. Requirements coverage
				if (this.requirementsVerifier) {
					const allReqs = this.requirementsVerifier.getAllRequirements()
					const active = allReqs.filter((r) => r.status !== "superseded")
					const verified = active.filter((r) => r.status === "verified")
					const failed = active.filter((r) => r.status === "failed")
					const pending = active.filter((r) => r.status === "pending")
					auditSections.push("## Requirements Coverage")
					if (allReqs.length === 0) {
						auditSections.push("No requirements were extracted from the task prompt.")
					} else {
						auditSections.push(`**${active.length} active requirements** (${allReqs.length - active.length} superseded)`)
						auditSections.push(`- ✅ Verified: ${verified.length}`)
						auditSections.push(`- ❌ Failed: ${failed.length}`)
						auditSections.push(`- ⏳ Pending: ${pending.length}`)
						if (failed.length > 0) {
							auditSections.push("")
							auditSections.push("**Failed requirements:**")
							for (const r of failed.slice(0, 5)) {
								auditSections.push(`- ❌ \`${r.text.slice(0, 100)}\``)
							}
						}
						if (pending.length > 0) {
							auditSections.push("")
							auditSections.push("**Pending/untested requirements:**")
							for (const r of pending.slice(0, 5)) {
								auditSections.push(`- ⏳ \`${r.text.slice(0, 100)}\``)
							}
						}
					}
					auditSections.push("")
				}

				// 2. File change summary
				const modifiedFiles = this.aggregateTaskFiles(task)
				auditSections.push("## Files Modified")
				if (modifiedFiles.length === 0) {
					auditSections.push("No files were modified during this task (read-only or discovery only).")
				} else {
					auditSections.push(`**${modifiedFiles.length} file(s) changed or created.**`)
					for (const f of modifiedFiles.slice(0, 30)) {
						auditSections.push(`- \`${f}\``)
					}
					if (modifiedFiles.length > 30) {
						auditSections.push(`... and ${modifiedFiles.length - 30} more`)
					}
				}
				auditSections.push("")

				// 3. Stub/TODO scan on modified files
				if (modifiedFiles.length > 0 && task.cwd) {
					const stubPatterns = [
						/\/\/\s+TODO/i,
						/\/\/\s+FIXME/i,
						/\/\/\s+HACK/i,
						/\/\/\s+XXX\b/,
						/throw\s+new\s+Error\(['"]not\s+implemented/i,
						/throw\s+new\s+Error\(['"]unimplemented/i,
						/implement\s+later/i,
					]
					let stubCount = 0
					let stubFiles = new Set<string>()
					try {
						const fs = await import("fs/promises")
						const path = await import("path")
						for (const f of modifiedFiles) {
							const fullPath = path.resolve(task.cwd, f)
							try {
								const content = await fs.readFile(fullPath, "utf-8")
								for (const pat of stubPatterns) {
									if (pat.test(content)) {
										stubCount++
										stubFiles.add(f)
										break
									}
								}
							} catch {
								// file deleted or unreadable
							}
						}
					} catch {
						// fs not available
					}
					auditSections.push("## Stub / TODO Detection")
					if (stubCount === 0) {
						auditSections.push("No TODO, FIXME, or stub patterns detected in modified files.")
					} else {
						auditSections.push(`**${stubCount} file(s)** contain TODO/FIXME/stub patterns:`)
						for (const f of stubFiles) {
							auditSections.push(`- ⚠️ \`${f}\``)
						}
						auditSections.push("")
						auditSections.push("*These are flagged for review — they may indicate unfinished work.*")
					}
					auditSections.push("")
				}

				// 4. Codebase mapping summary (architecture + dead code)
				try {
					const { CodebaseMappingManager } = await import("../../services/codebase-mapping")
					const context = task.providerRef.deref()?.context
					if (context) {
						const service = CodebaseMappingManager.getInstance(context, task.cwd)
						if (service) {
							const graph = await service.getDependencyGraph()
							if (graph && graph.files.size > 0) {
								const totalFiles = graph.files.size
								const totalEdges = graph.edges.length
								auditSections.push("## Architecture Summary (Codebase Mapping)")
								auditSections.push(`- **${totalFiles} files** in the dependency graph`)
								auditSections.push(`- **${totalEdges} dependency edges**`)

								// Dead code
								const deadCode = await service.getDeadCode()
								if (deadCode && deadCode.length > 0) {
									auditSections.push(`- ⚠️ **${deadCode.length} potentially dead symbol(s)** detected (zero references)`)
									const byFile = new Map<string, number>()
									for (const d of deadCode) {
										const fp = d.filePath || "unknown"
										byFile.set(fp, (byFile.get(fp) || 0) + 1)
									}
									for (const [fp, count] of [...byFile.entries()].slice(0, 5)) {
										auditSections.push(`  - \`${fp}\`: ${count} symbol(s)`)
									}
								} else {
									auditSections.push("- ✅ No dead symbols detected")
								}

								// Top hubs
								const tops: Array<{ name: string; score: number }> = []
								for (const [, fn] of graph.files) {
									const fp = (fn as any).filePath || (fn as any).path || ""
									const score = ((fn as any).imports || []).length + ((fn as any).exports || []).length
									if (score > 2) tops.push({ name: fp, score })
								}
								tops.sort((a, b) => b.score - a.score)
								if (tops.length > 0) {
									auditSections.push("")
									auditSections.push("**Top hub files (most connected):**")
									for (const h of tops.slice(0, 5)) {
										auditSections.push(`- \`${h.name}\` (${h.score} connections)`)
									}
								}
								auditSections.push("")
							}
						}
					}
				} catch {
					// codebase mapping not available
				}

				// 5. Verification gates summary
				if (this.verificationEngine) {
					const verStatus = this.verificationEngine.getStatus()
					if (verStatus.lastResult) {
						const lastResult = verStatus.lastResult as any
						auditSections.push("## Verification Gates")
						auditSections.push(`- **Overall:** ${lastResult.passed ? "✅ PASSED" : "❌ FAILED"}`)
						auditSections.push(`- **Gates:** ${lastResult.gates?.length || 0} total`)
						const passed = (lastResult.gates || []).filter((g: any) => g.passed || g.skipped).length
						const total = (lastResult.gates || []).length
						auditSections.push(`- **Passed/Skipped:** ${passed}/${total}`)
						auditSections.push(`- **Strictness:** ${lastResult.strictness || "moderate"}`)
						auditSections.push("")
					}
				}

				// Append audit report to completion result
				const auditReport = auditSections.join("\n")
				if (auditReport.length > 100) {
					result += "\n\n---\n" + auditReport
					console.log("[Orchestrator] Deep code audit appended to completion result (" + auditSections.length + " sections)")
				}
			}

			// ========================================================================
			// Bug 1: Escalation check — after ALL gates have run
			// Prompt user after MAX_CONSECUTIVE_FAILURES consecutive gate failures
			// ========================================================================
			if (!isLenientMode) {
				const shouldExit = await this.checkEscalation(task, pushToolResult)
				if (shouldExit) return
			}

			task.consecutiveMistakeCount = 0

			await task.say("completion_result", result, undefined, false)

			// Check for subtask using parentTaskId (metadata-driven delegation)
			if (task.parentTaskId) {
				// Check if this subtask has already completed and returned to parent
				// to prevent duplicate tool_results when user revisits from history
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					try {
						const { historyItem } = await provider.getTaskWithId(task.taskId)
						const status = historyItem?.status

						if (status === "completed") {
							// Subtask already completed - skip delegation flow entirely
							// Clean up child files (Fix 1)
							AttemptCompletionTool.pruneChildFiles(task.taskId)
							// Fall through to normal completion ask flow below (outside this if block)
							// This shows the user the completion result and waits for acceptance
							// without injecting another tool_result to the parent
						} else if (status === "active") {
							// Normal subtask completion - do delegation
							// Store child tool call files for parent aggregation (Bug 2)
							// Keyed by rootTask/parentTaskId so sibling tasks don't pollute
							try {
								const childFiles = this.extractToolCallFiles(task.apiConversationHistory)
								if (childFiles.length > 0) {
									const parentKey = task.parentTaskId ?? task.rootTaskId ?? task.taskId
									let childrenMap = AttemptCompletionTool.childTaskFiles.get(parentKey)
									if (!childrenMap) {
										childrenMap = new Map()
										AttemptCompletionTool.childTaskFiles.set(parentKey, childrenMap)
									}
									childrenMap.set(task.taskId, childFiles)
									// Fix 3: Extract thought tokens from child's API history
									const childThoughts = AttemptCompletionTool.extractChildThoughts(task)
									if (childThoughts.length > 0) {
										// Fix 2: Forward reasoning thoughts tagged as 'reasoning' type
										for (const thought of childThoughts) {
											task.providerRef.deref()?.postMessageToWebview?.({
												type: "parallelSubtaskThought",
												payload: { subtaskId: task.taskId, token: thought, sourceType: "reasoning" },
											})
										}
										// Also store for parent aggregation (post-hoc forwarding)
										const thoughtEntry = childrenMap.get('__thoughts__') ?? []
										thoughtEntry.push(...childThoughts)
										childrenMap.set('__thoughts__', thoughtEntry)
									}
								}
							} catch {
								// Non-blocking
							}							const delegation = await this.delegateToParent(
								task,
								result,
								provider,
								askFinishSubTaskApproval,
								pushToolResult,
							)
							if (delegation === "delegated") {
								this.emitTaskCompleted(task, result)
							} else {
								// Fix 1: Child didn't complete normally — clean up its files
								AttemptCompletionTool.pruneChildFiles(task.taskId)
							}
							if (delegation !== "continue") return
						} else {
							// Unexpected status (undefined or "delegated") - log error and skip delegation
							// undefined indicates a bug in status persistence during child creation
							// "delegated" would mean this child has its own grandchild pending (shouldn't reach attempt_completion)
							console.error(
								`[AttemptCompletionTool] Unexpected child task status "${status}" for task ${task.taskId}. ` +
									`Expected "active" or "completed". Skipping delegation to prevent data corruption.`,
							)
							// Fall through to normal completion ask flow
						}
					} catch (err) {
						// Clean up child files even on error (Fix 1)
						AttemptCompletionTool.pruneChildFiles(task.taskId)
						// If we can't get the history, log error and skip delegation
						console.error(
							`[AttemptCompletionTool] Failed to get history for task ${task.taskId}: ${(err as Error)?.message ?? String(err)}. ` +
								`Skipping delegation.`,
						)
						// Fall through to normal completion ask flow
					}
				}
			}

			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				AttemptCompletionTool.clearVerificationFailures(task.rootTaskId ?? task.taskId)
				this.emitTaskCompleted(task, result)
				return
			}

			// User provided feedback - reset completion tracking so subsequent
			// attempt_completion calls are not blocked by stale guard state.
			AttemptCompletionTool.lastResults.delete(task.taskId)
			const provider = task.providerRef.deref()
			if (provider?.trustService) {
				provider.trustService.taskCompleted = false
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)

			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			// Fix 3: Clean up child files on abort to prevent memory leak
			AttemptCompletionTool.pruneChildFiles(task.taskId)
			await handleError("inspecting site", error as Error)
		}
	}

	/**
	 * Handles the common delegation flow when a subtask completes.
	 * Returns:
	 * - "delegated" when completion was approved and parent resumed
	 * - "denied" when user denied finishing the subtask
	 * - "continue" when caller should fall through to normal completion ask flow
	 */
	private async delegateToParent(
		task: Task,
		result: string,
		provider: DelegationProvider,
		askFinishSubTaskApproval: () => Promise<boolean>,
		pushToolResult: (result: string) => void,
	): Promise<"delegated" | "denied" | "continue"> {
		const didApprove = await askFinishSubTaskApproval()

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		pushToolResult("")

		await provider.reopenParentFromDelegation({
			parentTaskId: task.parentTaskId!,
			childTaskId: task.taskId,
			completionResultSummary: result,
		})

		return "delegated"
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}

	/** Fix 4: Cache for extractChildThoughts to avoid O(n) re-scan on retries */
	private static thoughtCache = new WeakMap<Task, string[]>()

	/**
	 * Extract reasoning/thought tokens from child task's API conversation history (Fix 3).
	 * Caches results per Task instance so retries don't re-scan full history (Fix 4).
	 */
	private static extractChildThoughts(task: Task): string[] {
		// Fix 4: Return cached result if available
		const cached = AttemptCompletionTool.thoughtCache.get(task)
		if (cached) return cached
		const thoughts: string[] = []
		try {
			for (const msg of task.apiConversationHistory) {
				if (msg.role !== "assistant") continue
				if (!msg.content || typeof msg.content === "string") continue
				// Extract reasoning_content (DeepSeek) or type=reasoning blocks
				const content = msg.content as any[]
				for (const block of content) {
					if (block.type === "reasoning" && block.text) {
						thoughts.push(block.text.slice(0, 200))
					}
				}
				// Also check for reasoning_content at the message level (OpenAI/DeepSeek)
				if ((msg as any).reasoning_content) {
					thoughts.push((msg as any).reasoning_content.slice(0, 200))
				}
			}
		} catch {
			// Non-blocking
		}
		// Fix 4: Cache result so retries don't re-scan full history
		AttemptCompletionTool.thoughtCache.set(task, thoughts)
		return thoughts
	}

	/**
	 * Extract file paths from the agent's tool call history for file-changes gate scoping (Fix H).
	 */
	/** Fix 4: Regex patterns for CLI-created files */
	private static readonly CLI_FILE_PATTERNS = [
		/cat\s+>\s+([\w./-]+)/i,
		/echo\s+['"][^'"]*['"]\s*[>]\s*([\w./-]+)/i,
		/touch\s+([\w./-]+)/i,
		/cp\s+[\w./-]+\s+([\w./-]+)/i,
		/mv\s+[\w./-]+\s+([\w./-]+)/i,
	]

	private extractToolCallFiles(
		apiMessages: Array<{ role: string; content: string | any[] }>,
	): string[] {
		const files = new Set<string>()
		const FILE_WRITE_TOOLS = new Set([
			"write_to_file", "apply_diff", "edit", "search_replace", "edit_file", "patch",
		])

		for (const msg of apiMessages) {
			if (msg.role !== "assistant") continue
			if (!msg.content || typeof msg.content === "string") continue
			for (const block of msg.content) {
				if (block?.type !== "tool_use") continue
				const toolName = (block.name || "").toLowerCase()
				// Fix 4: Detect CLI-created files (execute_command with cat >, echo >, touch)
				if (toolName === "execute_command") {
					const command = block?.input?.command || ""
					if (typeof command === "string") {
						for (const pat of AttemptCompletionTool.CLI_FILE_PATTERNS) {
							const match = command.match(pat)
							if (match && match[1]) files.add(match[1])
						}
					}
				}
				if (!FILE_WRITE_TOOLS.has(toolName)) continue
				const input = block?.input || {}
				if (typeof input.path === "string") files.add(input.path)
				if (typeof input.file_path === "string") files.add(input.file_path)
			}
		}

		return [...files]
	}

	/**
	 * Extract all user messages from the task's conversation history.
	 * Includes the initial task prompt and all user_feedback messages.
	 */
	private getAllUserMessages(task: Task): string[] {
		const messages: string[] = []

		// Get the initial task prompt from metadata
		if (task.metadata?.task) {
			messages.push(task.metadata.task)
		}

		// Get user feedback messages from clineMessages
		const clineMessages = task.clineMessages || []
		for (const msg of clineMessages) {
			if (msg.type === "say" && msg.say === "user_feedback" && msg.text) {
				messages.push(msg.text)
			}
		}

		// Fix 3: Also scan apiConversationHistory for user messages missed by clineMessages
		try {
			const apiHistory = task.apiConversationHistory || []
			for (const msg of apiHistory) {
				if (msg.role === "user" && typeof msg.content === "string" && msg.content.length >= 10) {
					// Deduplicate against what we already have from clineMessages
					if (!messages.some((m) => m === msg.content)) {
						messages.push(msg.content)
					}
				}
			}
		} catch {
			// Non-blocking
		}

		return messages
	}

	private emitTaskCompleted(task: Task, result: string): void {
		// Fix 2: Sweep stale entries before cleanup
		AttemptCompletionTool.expireChildTaskFiles()
		// Clean up child task file tracking to prevent memory leak (Fix B + Bug 5)
		// Prune this task's own child records AND any completed grandchildren
		const ownChildren = AttemptCompletionTool.childTaskFiles.get(task.taskId)
		if (ownChildren) {
			for (const childId of ownChildren.keys()) {
				AttemptCompletionTool.childTaskFiles.delete(childId)
			}
		}
		AttemptCompletionTool.childTaskFiles.delete(task.taskId)

		// Store the result text to guard against duplicate completions
		AttemptCompletionTool.lastResults.set(task.taskId, result)

		// Notify TrustService that task has completed to block auto-approval of subsequent attempt_completion
		const provider = task.providerRef.deref()
		if (provider?.trustService) {
			provider.trustService.taskCompleted = true
		}

		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()

		TelemetryService.instance.captureTaskCompleted(task.taskId)
		task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
