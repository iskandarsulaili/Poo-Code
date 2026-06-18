/**
 * Tool for executing parallel child tasks via the Parallel Subtask Execution System.
 *
 * Accepts an array of child task definitions (each with mode, message, todos, deps,
 * inputFiles, outputFiles, subscribedTopics) and executes them with DAG-based
 * dependency resolution, lock-aware scheduling, and blackboard communication.
 *
 * ## Flow
 * 1. **Feature-flag check** — if `PARALLEL_SUBTASK` disabled, push fallback result.
 * 2. **Validation** — ensure child tasks are valid, deps reference existing IDs.
 * 3. **DAG construction** — build DAG from child task definitions.
 * 4. **Execution** — delegate to {@link ParallelSubtaskOrchestrator.execute}.
 * 5. **Formatting** — structured markdown with per-child-task status.
 * 6. **Push result** — via `callbacks.pushToolResult()`.
 *
 * @module
 */

import type { SubtaskNode } from "@roo-code/types"

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { experimentConfigsMap } from "../../shared/experiments"
import { ParallelSubtaskOrchestrator, StatusCallback, SubtaskExecutor } from "../orchestration/ParallelSubtaskOrchestrator"
import { LockManager } from "../orchestration/LockManager"
import { Blackboard } from "../orchestration/Blackboard"
import { ContextRouter } from "../orchestration/ContextRouter"
import { LogAggregator } from "../orchestration/LogAggregator"
import { compressPrompt } from "../../shared/prompt-compressor"

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for the execute_parallel_child_task tool.
 */
interface ExecuteParallelChildTaskParams {
	tasks: Array<{
		id: string
		mode: string
		message: string
		todos?: string
		deps?: string[]
		inputFiles?: string[]
		outputFiles?: string[]
		subscribedTopics?: string[]
	}>
	maxParallel?: number
}

// ============================================================================
// ExecuteParallelChildTaskTool
// ============================================================================

/**
 * Tool that the LLM calls to execute multiple child tasks in parallel.
 *
 * Each child task is a self-contained unit with its own mode, message, and
 * optional dependencies. The tool builds a DAG from the task definitions
 * and executes them in parallel waves using the ParallelSubtaskOrchestrator.
 *
 * Registered as a singleton in the tool registry. Must be initialized with
 * all dependencies before first use (called during extension activation).
 *
 * @extends BaseTool<"execute_parallel_child_task">
 */
export class ExecuteParallelChildTaskTool extends BaseTool<"execute_parallel_child_task"> {
	readonly name = "execute_parallel_child_task" as const

	private orchestrator: ParallelSubtaskOrchestrator | undefined
	private lockManager: LockManager | undefined
	private blackboard: Blackboard | undefined
	private contextRouter: ContextRouter | undefined
	private logAggregator: LogAggregator | undefined

	/**
	 * Initialize the tool with required dependencies.
	 * Called during extension activation.
	 */
	initialize(): void {
		this.lockManager = new LockManager()
		this.blackboard = new Blackboard(this.lockManager)
		this.contextRouter = new ContextRouter(this.blackboard)
		this.logAggregator = new LogAggregator()

		const maxParallel = experimentConfigsMap.PARALLEL_SUBTASK?.enabled ? 4 : 1
		this.orchestrator = new ParallelSubtaskOrchestrator(
			this.lockManager,
			this.blackboard,
			this.contextRouter,
			this.logAggregator,
			maxParallel,
		)

		console.log("[ExecuteParallelChildTaskTool] Initialized with ParallelSubtaskOrchestrator")
	}

	/**
	 * Execute parallel child tasks.
	 *
	 * @param params - Typed parameters
	 * @param task - Task instance
	 * @param callbacks - Tool execution callbacks
	 */
	async execute(params: ExecuteParallelChildTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			// ------------------------------------------------------------------
			// 1. Feature-flag check
			// ------------------------------------------------------------------
			if (!experimentConfigsMap.PARALLEL_SUBTASK?.enabled) {
				pushToolResult(
					"Parallel child task execution is disabled via experiment config. Use new_task sequentially.",
				)
				return
			}

			// ------------------------------------------------------------------
			// 2. Initialization check
			// ------------------------------------------------------------------
			if (!this.orchestrator) {
				pushToolResult(
					"Parallel child task orchestrator is not initialized. Ensure initialize() is called during extension activation.",
				)
				return
			}

			// ------------------------------------------------------------------
			// 3. Validate params
			// ------------------------------------------------------------------
			const { tasks, maxParallel } = params
	
			if (!Array.isArray(tasks) || tasks.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_parallel_child_task")
				pushToolResult(await task.sayAndCreateMissingParamError("execute_parallel_child_task", "tasks"))
				return
			}

			// Validate each child task
			const validationErrors: string[] = []
			const taskIds = new Set(tasks.map((t) => t.id))

			for (let i = 0; i < tasks.length; i++) {
				const t = tasks[i]

				if (!t.id || t.id.trim().length === 0) {
					validationErrors.push(`Task at index ${i} is missing an 'id'.`)
					continue
				}

				if (!t.mode || t.mode.trim().length === 0) {
					validationErrors.push(`Task "${t.id}" is missing a 'mode'.`)
				}

				if (!t.message || t.message.trim().length === 0) {
					validationErrors.push(`Task "${t.id}" is missing a 'message'.`)
				}

				// Validate deps reference existing task IDs
				if (t.deps) {
					for (const depId of t.deps) {
						if (!taskIds.has(depId)) {
							validationErrors.push(`Task "${t.id}" depends on "${depId}" which is not in the task list.`)
						}
					}
				}
			}

			if (validationErrors.length > 0) {
				task.consecutiveMistakeCount++
				pushToolResult(
					`Validation failed for execute_parallel_child_task:\n${validationErrors.map((e) => `- ${e}`).join("\n")}`,
				)
				return
			}

			task.consecutiveMistakeCount = 0

			// ------------------------------------------------------------------
			// 4. Convert to SubtaskNode[]
			// ------------------------------------------------------------------
			const subtaskNodes: SubtaskNode[] = (tasks as Array<{
				id: string
				mode: string
				message: string
				todos?: string
				deps?: string[]
				inputFiles?: string[]
				outputFiles?: string[]
				subscribedTopics?: string[]
			}>).map((t) => ({
				id: t.id,
				name: t.id,
				mode: t.mode,
				prompt: t.message,
				inputFiles: t.inputFiles ?? [],
				outputFiles: t.outputFiles ?? [],
				deps: t.deps ?? [],
				requiredResources: [],
				subscribedTopics: t.subscribedTopics ?? [],
				publishedTopics: [],
				estimatedTokens: 0,
				timeoutMs: 300_000,
				isCritical: false,
				status: "pending",
				metadata: {
					correlationId: "",
				},
			}))

			// ------------------------------------------------------------------
			// 5. Wire real subtask executor and execute via Orchestrator
			// ------------------------------------------------------------------
			// The executor calls task.startSubtask() which delegates via
			// ClineProvider.delegateParentAndOpenChild() to spawn a real child agent.
			// Subtasks execute sequentially to respect the single-open-task invariant.
			//
			// IMPORTANT: Compress the prompt to prevent overwhelming child agents
			// with full parent context. Long prompts cause consecutive mistakes
			// and streaming failures in child tasks. Uses lossless compression
			// that preserves all content — no truncation.
			const MAX_PROMPT_LENGTH = 8000
			const executor: SubtaskExecutor = async (execParams) => {
				const compressedMessage = compressPrompt(execParams.message, MAX_PROMPT_LENGTH)
				const child = await task.startSubtask(compressedMessage, [], execParams.mode)
				// Wait for the child task to actually complete before marking subtask as done.
				// Without this, the orchestrator marks the subtask "completed" immediately
				// while the child agent hasn't started or finished its work.
				await child.waitForCompletion()
				return { taskId: child.taskId, result: "" }
			}
			this.orchestrator.setSubtaskExecutor(executor)
			// Wire status callback to send live DAG updates to the webview
			const statusCallback: StatusCallback = (dag) => {
				task.providerRef.deref()?.postMessageToWebview({
					type: "parallelSubtaskStatus",
					text: JSON.stringify(dag),
				})
			}
			this.orchestrator.setStatusCallback(statusCallback)
			const dag = await this.orchestrator.execute(subtaskNodes)

			// ------------------------------------------------------------------
			// 6. Format and push result
			// ------------------------------------------------------------------
			const formatted = this.formatResult(dag)
			pushToolResult(formatted)
		} catch (error) {
			await handleError("executing parallel child tasks", error as Error)
		}
	}

	// ========================================================================
	// Private: Result formatting
	// ========================================================================

	/**
	 * Format the DAG execution result into a structured markdown tool response.
	 *
	 * @param dag - The resulting SubtaskDAG
	 * @returns Formatted markdown string
	 */
	private formatResult(dag: import("@roo-code/types").SubtaskDAG): string {
		const lines: string[] = []
		const totalNodes = dag.nodes.size
		const completed = [...dag.nodes.values()].filter((n) => n.status === "completed").length
		const failed = [...dag.nodes.values()].filter((n) => n.status === "failed" || n.status === "timed_out").length
		const skipped = [...dag.nodes.values()].filter((n) => n.status === "skipped" || n.status === "blocked").length

		lines.push(`## Parallel Child Task Execution Results (${dag.status})`)
		lines.push(`Total: ${totalNodes} child task(s), ${completed} completed, ${failed} failed, ${skipped} skipped`)
		lines.push(`Waves: ${dag.waves.length}`)
		lines.push("")

		// Per-wave sections
		for (let wi = 0; wi < dag.waves.length; wi++) {
			const wave = dag.waves[wi]
			lines.push(`### Wave ${wi + 1} (${wave.length} child task(s))`)
			lines.push("")

			for (const node of wave) {
				const statusIcon = this.getStatusIcon(node.status)
				const duration =
					node.metadata.startedAt && node.metadata.completedAt
						? `${node.metadata.completedAt - node.metadata.startedAt}ms`
						: "-"
				const depsStr = node.deps.length > 0 ? ` (after: ${node.deps.join(", ")})` : ""

				lines.push(`**${node.id}** ${statusIcon}${depsStr}`)
				lines.push(`> Mode: ${node.mode}`)
				lines.push(`> Status: ${node.status}`)
				lines.push(`> Duration: ${duration}`)

				if (node.metadata.error) {
					lines.push(`> Error: ${node.metadata.error}`)
				}

				if (node.inputFiles.length > 0) {
					lines.push(`> Input files: ${node.inputFiles.join(", ")}`)
				}

				if (node.outputFiles.length > 0) {
					lines.push(`> Output files: ${node.outputFiles.join(", ")}`)
				}

				lines.push("")
			}
		}

		return lines.join("\n")
	}

	/**
	 * Get a status icon for a child task status.
	 */
	private getStatusIcon(status: string): string {
		switch (status) {
			case "completed":
				return "✓"
			case "failed":
			case "timed_out":
				return "✗"
			case "running":
				return "⟳"
			case "pending":
			case "ready":
				return "○"
			case "blocked":
				return "⊘"
			case "skipped":
				return "⏭"
			default:
				return "?"
		}
	}
}

// ============================================================================
// Singleton export
// ============================================================================

export const executeParallelChildTaskTool = new ExecuteParallelChildTaskTool()
