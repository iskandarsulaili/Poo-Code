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

	/**
	 * Set the verifiers used to guard completion.
	 */
	setVerifiers(requirementsVerifier?: RequirementsVerifier, verificationEngine?: VerificationEngine): void {
		this.requirementsVerifier = requirementsVerifier
		this.verificationEngine = verificationEngine
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
		const { result } = params
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

			// Guard 5: Requirements verification — check user intent is fulfilled
			if (this.requirementsVerifier && !isLenientMode) {
				const experiments = task.experiments

				// Per-mode resolution: check verificationLevels[currentMode] first,
				// fall back to verificationLevel, then "strict"
				const verificationLevel =
					experiments?.verificationLevels?.[currentMode] ?? experiments?.verificationLevel ?? "strict"

				// Apply verificationLevel to the verifier config
				this.requirementsVerifier.updateConfig({ verificationLevel })

				// Bypass mode: skip verification entirely
				if (verificationLevel === "bypass") {
				} else {
					const reqResult = await this.requirementsVerifier.verify()
					const isBlocking = verificationLevel === "strict" && this.requirementsVerifier.getConfig().mandatory
					if (!reqResult.passed && isBlocking) {
						const errorMsg = `Requirements verification failed:\n${reqResult.summary}\n\nFailed requirements:\n${reqResult.failed.map((r) => `  ❌ ${r.text}`).join("\n")}\n\nPending requirements:\n${reqResult.pending.map((r) => `  ⏳ ${r.text}`).join("\n")}\n\nPlease address these requirements before completing the task.`
						// Don't increment consecutiveMistakeCount — verification has its own counter
						task.recordToolError("attempt_completion")
						pushToolResult(formatResponse.toolError(errorMsg))
						return
					}
					if (verificationLevel === "lenient" && !reqResult.passed) {
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
			// Cross-reference: auto-verify requirements against API conversation history (Fix A)
			// This checks whether files were actually modified in ways that match
			// the extracted requirements, providing concrete evidence.
			// ========================================================================
			if (this.requirementsVerifier && !isLenientMode) {
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

			// Extract tool call file paths for VerificatonEngine scoping (Fix H)
			const toolCallFilePaths = this.extractToolCallFiles(task.apiConversationHistory)

			// ========================================================================
			// Fix F: Cross-reference completion claim against actual file changes
			// Check if the result text mentions files that weren't actually modified
			// ========================================================================
			if (!isLenientMode && result) {
				const filePattern = /(?:\b|\/)([\w_.-]+\.\w{1,5})\b/g
				const mentionedFiles = [...result.matchAll(filePattern)].map((m) => m[1].toLowerCase())
				if (mentionedFiles.length > 0) {
					const actuallyChanged = new Set([
						...toolCallFilePaths.map((f) => f.toLowerCase()),
					])
					const unverifiedClaims = mentionedFiles.filter(
						(f) => !actuallyChanged.has(f) && !actuallyChanged.has(`/${f}`),
					)
					if (unverifiedClaims.length > 0) {
						console.log(
							`[AttemptCompletionTool] ⚠ Completion result mentions ${unverifiedClaims.length} file(s) not verified as changed: ${unverifiedClaims.join(", ")}`,
						)
					}
				}
			}

			// Guard 6: Code quality verification (VerificationEngine)
			// Skip verification for lenient modes — research tasks and other user-configured modes
			// don't need build/lint/types/tests. Default: ["research"]
			if (this.verificationEngine && !isLenientMode) {
				// Set cwd from task context — the directory the agent is working in
				// This replaces the flawed workspace-folder heuristic (detectUserProjectCwd)
				this.verificationEngine.updateConfig({ cwd: task.cwd })
				await this.verificationEngine.applyAutoProfile(task.cwd)
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
					// Don't increment consecutiveMistakeCount — verification has its own counter
					task.recordToolError("attempt_completion")
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}

				// Even on pass, show warning counts if any
				// (VerificationEngine already logs details via its own logger)
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
							// Fall through to normal completion ask flow below (outside this if block)
							// This shows the user the completion result and waits for acceptance
							// without injecting another tool_result to the parent
						} else if (status === "active") {
							// Normal subtask completion - do delegation
							const delegation = await this.delegateToParent(
								task,
								result,
								provider,
								askFinishSubTaskApproval,
								pushToolResult,
							)
							if (delegation === "delegated") {
								this.emitTaskCompleted(task, result)
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

	/**
	 * Extract file paths from the agent's tool call history for file-changes gate scoping (Fix H).
	 */
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

		return messages
	}

	private emitTaskCompleted(task: Task, result: string): void {
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
