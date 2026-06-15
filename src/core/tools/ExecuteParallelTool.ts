/**
 * Tool for executing multiple commands concurrently across independent sub-projects.
 *
 * Accepts an array of command groups and executes them with configurable concurrency
 * and dependency ordering. Each group can have sequential or parallel commands,
 * dependency ordering via `wait_for`, and per-command error handling policies.
 *
 * ## Flow
 *
 * 1. **Feature-flag check** — if `PARALLEL_EXECUTION` disabled, push fallback result.
 * 2. **Validation** — ensure groups exist, each command is non-empty, pass
 *    `.rooignore` validation.
 * 3. **Approval** — show all commands in a single approval prompt.
 * 4. **Execution** — delegate to {@link ParallelExecutor.executeGroups}.
 * 5. **Formatting** — structured markdown with per-group/command status.
 * 6. **Push result** — via `callbacks.pushToolResult()`.
 *
 * @module
 */

import type { ExecuteParallelParams, AggregatedResult } from "@roo-code/types"

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { ParallelExecutor } from "../orchestration/ParallelExecutor"
import { WorkspaceManager } from "../orchestration/WorkspaceManager"
import { experimentConfigsMap } from "../../shared/experiments"
import { unescapeHtmlEntities } from "../../utils/text-normalization"

// ============================================================================
// Constants
// ============================================================================

/** Maximum line length for output preview in formatted results. */
const OUTPUT_PREVIEW_LINES = 20

/** Maximum characters for output preview per command. */
const OUTPUT_PREVIEW_CHARS = 2000

// ============================================================================
// ExecuteParallelTool
// ============================================================================

/**
 * Tool that the LLM calls to execute multiple commands concurrently.
 *
 * Registered as a singleton in the tool registry. Must be initialized with a
 * {@link WorkspaceManager} instance before first use (called during extension
 * activation).
 *
 * @extends BaseTool<"execute_parallel">
 */
export class ExecuteParallelTool extends BaseTool<"execute_parallel"> {
	readonly name = "execute_parallel" as const

	private executor: ParallelExecutor | undefined

	/**
	 * Initialize the tool with required dependencies.
	 * Called during extension activation after WorkspaceManager is initialized.
	 *
	 * @param workspaceManager - The workspace manager instance for CWD resolution
	 */
	initialize(workspaceManager: WorkspaceManager): void {
		this.executor = new ParallelExecutor({
			maxParallel: undefined, // Use default (os.cpus().length)
			isParallelEnabled: experimentConfigsMap.PARALLEL_EXECUTION.enabled,
		})
	}

	/**
	 * Execute parallel command groups.
	 *
	 * @param params - Typed parameters from `ExecuteParallelParams`
	 * @param task - Task instance with state and API access
	 * @param callbacks - Tool execution callbacks
	 */
	async execute(params: ExecuteParallelParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult, askApproval } = callbacks

		try {
			// ------------------------------------------------------------------
			// 1. Feature-flag check
			// ------------------------------------------------------------------
			if (!experimentConfigsMap.PARALLEL_EXECUTION.enabled) {
				pushToolResult(
					"Parallel execution is disabled via experiment config. Use execute_command sequentially.",
				)
				return
			}

			// ------------------------------------------------------------------
			// 2. Initialization check
			// ------------------------------------------------------------------
			if (!this.executor) {
				pushToolResult(
					"Parallel executor is not initialized. Ensure initialize() is called during extension activation.",
				)
				return
			}

			// ------------------------------------------------------------------
			// 3. Validate params
			// ------------------------------------------------------------------
			const { groups, max_parallel } = params

			if (!groups || groups.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_parallel")
				pushToolResult(await task.sayAndCreateMissingParamError("execute_parallel", "groups"))
				return
			}

			// Validate each command in each group
			const validationErrors: string[] = []
			for (let gi = 0; gi < groups.length; gi++) {
				const group = groups[gi]

				if (!group.id || group.id.trim().length === 0) {
					validationErrors.push(`Group at index ${gi} is missing an 'id'.`)
					continue
				}

				if (!group.commands || group.commands.length === 0) {
					validationErrors.push(`Group "${group.id}" has no commands.`)
					continue
				}

				for (let ci = 0; ci < group.commands.length; ci++) {
					const cmd = group.commands[ci]

					if (!cmd.command || cmd.command.trim().length === 0) {
						validationErrors.push(`Group "${group.id}", command ${ci + 1}: command string is empty.`)
						continue
					}

					// Unescape HTML entities (matches ExecuteCommandTool behavior)
					const canonicalCommand = unescapeHtmlEntities(cmd.command)

					// Validate via RooIgnoreController
					const ignoredPath = task.rooIgnoreController?.validateCommand(canonicalCommand)
					if (ignoredPath) {
						validationErrors.push(
							`Group "${group.id}", command ${ci + 1}: access to "${ignoredPath}" is blocked by .rooignore.`,
						)
					}
				}
			}

			if (validationErrors.length > 0) {
				task.consecutiveMistakeCount++
				pushToolResult(
					`Validation failed for execute_parallel:\n${validationErrors.map((e) => `- ${e}`).join("\n")}`,
				)
				return
			}

			task.consecutiveMistakeCount = 0

			// ------------------------------------------------------------------
			// 4. Approval flow — show all commands in one prompt
			// ------------------------------------------------------------------
			const approvalMessage = this.buildApprovalMessage(groups, max_parallel)
			const didApprove = await askApproval("command", approvalMessage)

			if (!didApprove) {
				return
			}

			// ------------------------------------------------------------------
			// 5. Execute via ParallelExecutor
			// ------------------------------------------------------------------
			const aggregated = await this.executor.executeGroups(groups, {
				concurrency: max_parallel ?? undefined,
			})

			// ------------------------------------------------------------------
			// 6. Format and push result
			// ------------------------------------------------------------------
			const formatted = this.formatResult(aggregated)
			pushToolResult(formatted)
		} catch (error) {
			await handleError("executing parallel command", error as Error)
		}
	}

	// ========================================================================
	// Private: Approval message builder
	// ========================================================================

	/**
	 * Build a human-readable approval message showing all commands.
	 *
	 * @param groups - The command groups to describe
	 * @param maxParallel - Optional concurrency limit
	 * @returns Formatted approval message string
	 */
	private buildApprovalMessage(groups: ExecuteParallelParams["groups"], max_parallel?: number | null): string {
		const parts: string[] = []

		if (groups.length === 1) {
			parts.push("Execute the following command group:")
		} else {
			parts.push(`Execute ${groups.length} command groups:`)
		}

		if (max_parallel) {
			parts.push(`Max parallel groups: ${max_parallel}`)
		}

		parts.push("")

		for (const group of groups) {
			const label = group.id || "unnamed group"
			const mode = group.sequential ? "sequential" : "parallel"
			const deps = group.wait_for && group.wait_for.length > 0 ? ` (after: ${group.wait_for.join(", ")})` : ""
			parts.push(`[${label}] ${mode}${deps}`)

			for (let ci = 0; ci < group.commands.length; ci++) {
				const cmd = group.commands[ci]
				const cwdInfo = cmd.cwd ? ` (cwd: ${cmd.cwd})` : ""
				const timeoutInfo = cmd.timeout ? ` [timeout: ${cmd.timeout}s]` : ""
				parts.push(`  ${ci + 1}. ${cmd.command}${cwdInfo}${timeoutInfo}`)
			}

			if (!group.continue_on_error) {
				parts.push("  → Stop on first failure")
			}
			parts.push("")
		}

		return parts.join("\n")
	}

	// ========================================================================
	// Private: Result formatting
	// ========================================================================

	/**
	 * Format aggregated result into a structured markdown tool response.
	 *
	 * Output format:
	 * ```
	 * ## Parallel Execution Results (N groups, M succeeded, F failed)
	 * Total duration: X.Xs
	 *
	 * ### Group: frontend ✓ (3.2s)
	 * Command 1: npm run build (exit code 0) ✓
	 * [stdout preview truncated]
	 *
	 * ### Group: backend ✗ (8.1s)
	 * Command 1: cargo build (exit code 1) ✗
	 * [error output]
	 * ```
	 *
	 * @param result - The aggregated execution result
	 * @returns Formatted markdown string
	 */
	private formatResult(result: AggregatedResult): string {
		const lines: string[] = []
		const totalGroups = result.groups.length
		const totalDurationS = (result.totalDuration / 1000).toFixed(1)

		// Header
		const headerParts = [`${totalGroups} group${totalGroups !== 1 ? "s" : ""}`]
		if (result.successCount > 0) {
			headerParts.push(`${result.successCount} succeeded`)
		}
		if (result.failedCount > 0) {
			headerParts.push(`${result.failedCount} failed`)
		}
		if (result.skippedCount > 0) {
			headerParts.push(`${result.skippedCount} skipped`)
		}

		lines.push(`## Parallel Execution Results (${headerParts.join(", ")})`)
		lines.push(`Total duration: ${totalDurationS}s`)
		lines.push("")

		// Per-group sections
		for (const group of result.groups) {
			const groupDurationS = (group.totalDuration / 1000).toFixed(1)
			const groupPassed = group.failedCount === 0
			const groupIcon = groupPassed ? "✓" : "✗"

			lines.push(
				`### Group: ${group.id} ${groupIcon} (${groupDurationS}s, ${group.commands.length} command${group.commands.length !== 1 ? "s" : ""})`,
			)
			lines.push("")

			for (let ci = 0; ci < group.commands.length; ci++) {
				const cmd = group.commands[ci]
				const cmdNum = ci + 1
				const cmdPassed = cmd.exitCode === 0 && !cmd.error
				const cmdIcon = cmdPassed ? "✓" : cmd.error?.startsWith("Skipped:") ? "⏭" : "✗"
				const durationMs = cmd.duration
				const durationStr = durationMs > 0 ? ` (${(durationMs / 1000).toFixed(1)}s)` : ""
				const exitCodeStr = cmd.exitCode !== undefined ? `exit code ${cmd.exitCode}` : "no exit code"

				lines.push(`**Command ${cmdNum}:** \`${cmd.command}\` ${cmdIcon}${durationStr}`)
				lines.push(`> Working directory: \`${cmd.cwd}\``)
				lines.push(`> ${exitCodeStr}`)

				if (cmd.error) {
					lines.push(`> Error: ${cmd.error}`)
				}

				// Show output preview
				const stdoutPreview = this.truncateOutput(cmd.stdout)
				const stderrPreview = cmd.stderr ? this.truncateOutput(cmd.stderr) : ""

				if (stdoutPreview) {
					lines.push("")
					lines.push("```")
					lines.push(stdoutPreview)
					lines.push("```")
				}

				if (stderrPreview && stderrPreview !== stdoutPreview) {
					lines.push("")
					lines.push("```")
					lines.push(stderrPreview)
					lines.push("```")
				}

				if (cmd.parsed.errors.length > 0) {
					const errorCount = cmd.parsed.errors.length
					lines.push("")
					lines.push(`> **${errorCount} parsed error${errorCount !== 1 ? "s" : ""}**`)
					const shownErrors = cmd.parsed.errors.slice(0, 5)
					for (const err of shownErrors) {
						const location = err.file ? `${err.file}:${err.line}${err.column ? `:${err.column}` : ""}` : ""
						const code = err.code ? ` [${err.code}]` : ""
						lines.push(`> - ${location}${code}: ${err.message}`)
					}
					if (errorCount > 5) {
						lines.push(`> - ... and ${errorCount - 5} more`)
					}
				}

				lines.push("")
			}
		}

		return lines.join("\n")
	}

	/**
	 * Truncate command output for preview display.
	 * Keeps the first N lines and limits total characters.
	 *
	 * @param output - Raw output to truncate
	 * @returns Truncated preview string (may be empty)
	 */
	private truncateOutput(output: string): string {
		if (!output || output.trim().length === 0) {
			return ""
		}

		let truncated = output.trim()

		if (truncated.length > OUTPUT_PREVIEW_CHARS) {
			truncated = truncated.slice(0, OUTPUT_PREVIEW_CHARS) + "\n... [output truncated]"
		}

		const lines = truncated.split("\n")
		if (lines.length > OUTPUT_PREVIEW_LINES) {
			return (
				lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n") +
				`\n... [${lines.length - OUTPUT_PREVIEW_LINES} more lines]`
			)
		}

		return truncated
	}
}

// ============================================================================
// Singleton export
// ============================================================================

export const executeParallelTool = new ExecuteParallelTool()
