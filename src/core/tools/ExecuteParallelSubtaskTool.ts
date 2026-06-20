/**
 * Tool for executing parallel subtasks via the Parallel Subtask Execution System.
 *
 * Accepts an array of subtask definitions and executes them with DAG-based
 * dependency resolution, lock-aware scheduling, and blackboard communication.
 *
 * ## Flow
 * 1. **Feature-flag check** — if `PARALLEL_SUBTASK` disabled, push fallback result.
 * 2. **Validation** — ensure subtasks are valid, deps reference existing IDs.
 * 3. **Execution** — delegate to {@link ParallelSubtaskOrchestrator.execute}.
 * 4. **Formatting** — structured markdown with per-subtask status.
 * 5. **Push result** — via `callbacks.pushToolResult()`.
 *
 * @module
 */

import type { SubtaskNode } from "@roo-code/types"

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { experimentConfigsMap } from "../../shared/experiments"
import { ParallelSubtaskOrchestrator, StatusCallback, ThoughtCallback, SubtaskExecutor } from "../orchestration/ParallelSubtaskOrchestrator"
import { LockManager } from "../orchestration/LockManager"
import { Blackboard } from "../orchestration/Blackboard"
import { ContextRouter } from "../orchestration/ContextRouter"
import { LogAggregator } from "../orchestration/LogAggregator"
import { compressPrompt } from "../../shared/prompt-compressor"

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for the execute_parallel_subtask tool.
 */
interface ExecuteParallelSubtaskParams {
	tasks: Array<{
		id: string
		name: string
		mode: string
		prompt: string
		inputFiles?: string[]
		outputFiles?: string[]
		deps?: string[]
		requiredResources?: string[]
		subscribedTopics?: string[]
		publishedTopics?: string[]
		estimatedTokens?: number
		timeoutMs?: number
		isCritical?: boolean
	}>
	maxParallel?: number
}

// ============================================================================
// ExecuteParallelSubtaskTool
// ============================================================================

/**
 * Tool that the LLM calls to execute multiple subtasks in parallel.
 *
 * Registered as a singleton in the tool registry. Must be initialized with
 * all dependencies before first use (called during extension activation).
 *
 * @extends BaseTool<"execute_parallel_subtask">
 */
export class ExecuteParallelSubtaskTool extends BaseTool<"execute_parallel_subtask"> {
	readonly name = "execute_parallel_subtask" as const

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

		console.log("[ExecuteParallelSubtaskTool] Initialized with ParallelSubtaskOrchestrator")
	}

	/**
	 * Execute parallel subtasks.
	 *
	 * @param params - Typed parameters
	 * @param task - Task instance
	 * @param callbacks - Tool execution callbacks
	 */
	async execute(params: ExecuteParallelSubtaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			// ------------------------------------------------------------------
			// 1. Feature-flag check
			// ------------------------------------------------------------------
			if (!experimentConfigsMap.PARALLEL_SUBTASK?.enabled) {
				pushToolResult(
					"Parallel subtask execution is disabled via experiment config. Use new_task sequentially.",
				)
				return
			}

			// ------------------------------------------------------------------
			// 2. Initialization check
			// ------------------------------------------------------------------
			if (!this.orchestrator) {
				pushToolResult(
					"Parallel subtask orchestrator is not initialized. Ensure initialize() is called during extension activation.",
				)
				return
			}

			// ------------------------------------------------------------------
			// 3. Validate params
			// ------------------------------------------------------------------
			const { tasks, maxParallel } = params
	
			if (!Array.isArray(tasks) || tasks.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_parallel_subtask")
				pushToolResult(await task.sayAndCreateMissingParamError("execute_parallel_subtask", "tasks"))
				return
			}

			// Validate each subtask
			const validationErrors: string[] = []
			const taskIds = new Set(tasks.map((t) => t.id))

			for (let i = 0; i < tasks.length; i++) {
				const t = tasks[i]

				if (!t.id || t.id.trim().length === 0) {
					validationErrors.push(`Task at index ${i} is missing an 'id'.`)
					continue
				}

				if (!t.name || t.name.trim().length === 0) {
					validationErrors.push(`Task "${t.id}" is missing a 'name'.`)
				}

				if (!t.mode || t.mode.trim().length === 0) {
					validationErrors.push(`Task "${t.id}" is missing a 'mode'.`)
				}

				if (!t.prompt || t.prompt.trim().length === 0) {
					validationErrors.push(`Task "${t.id}" is missing a 'prompt'.`)
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
					`Validation failed for execute_parallel_subtask:\n${validationErrors.map((e) => `- ${e}`).join("\n")}`,
				)
				return
			}

			task.consecutiveMistakeCount = 0

			// ------------------------------------------------------------------
			// 4. Convert to SubtaskNode[]
			// ------------------------------------------------------------------
			const subtaskNodes: SubtaskNode[] = (tasks as Array<{
				id: string
				name: string
				mode: string
				prompt: string
				inputFiles?: string[]
				outputFiles?: string[]
				deps?: string[]
				requiredResources?: string[]
				subscribedTopics?: string[]
				publishedTopics?: string[]
				estimatedTokens?: number
				timeoutMs?: number
				isCritical?: boolean
			}>).map((t) => ({
				id: t.id,
				name: t.name,
				mode: t.mode,
				source: "execute_parallel_subtask",
				prompt: t.prompt,
				inputFiles: t.inputFiles ?? [],
				outputFiles: t.outputFiles ?? [],
				deps: t.deps ?? [],
				requiredResources: t.requiredResources ?? [],
				subscribedTopics: t.subscribedTopics ?? [],
				publishedTopics: t.publishedTopics ?? [],
				estimatedTokens: t.estimatedTokens ?? 0,
				timeoutMs: t.timeoutMs ?? 300_000,
				isCritical: t.isCritical ?? false,
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
			// Wire log forwarding to send live log entries to the webview
			this.logAggregator!.onLog = (entry) => {
				task.providerRef.deref()?.postMessageToWebview({
					type: "parallelSubtaskLog",
					payload: entry,
				})
			}
			// Wire thought forwarding to send thought tokens to the webview
			const thoughtCallback: ThoughtCallback = (subtaskId, token) => {
				task.providerRef.deref()?.postMessageToWebview({
					type: "parallelSubtaskThought",
					payload: { subtaskId, token },
				})
			}
			this.orchestrator!.setThoughtCallback(thoughtCallback)
			// Wire status callback to send live DAG updates to the webview
			const statusCallback: StatusCallback = (dag) => {
				task.providerRef.deref()?.postMessageToWebview({
					type: "parallelSubtaskStatus",
					payload: {
						nodes: Object.fromEntries(dag.nodes),
						edges: Object.fromEntries(
							[...dag.edges.entries()].map(([k, v]) => [k, [...v]])
						),
						waves: dag.waves,
						status: dag.status,
					},
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
			await handleError("executing parallel subtasks", error as Error)
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

		lines.push(`## Parallel Subtask Execution Results (${dag.status})`)
		lines.push(`Total: ${totalNodes} subtask(s), ${completed} completed, ${failed} failed, ${skipped} skipped`)
		lines.push(`Waves: ${dag.waves.length}`)
		lines.push("")

		// Per-wave sections
		for (let wi = 0; wi < dag.waves.length; wi++) {
			const wave = dag.waves[wi]
			lines.push(`### Wave ${wi + 1} (${wave.length} subtask(s))`)
			lines.push("")

			for (const node of wave) {
				const statusIcon = this.getStatusIcon(node.status)
				const duration =
					node.metadata.startedAt && node.metadata.completedAt
						? `${node.metadata.completedAt - node.metadata.startedAt}ms`
						: "-"
				const depsStr = node.deps.length > 0 ? ` (after: ${node.deps.join(", ")})` : ""

				lines.push(`**${node.name}** \`${node.id}\` ${statusIcon}${depsStr}`)
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
	 * Get a status icon for a subtask status.
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

	// ========================================================================
	// Intervention methods (called from webview message handlers)
	// ========================================================================

	/**
	 * Pause a running subtask.
	 */
	pauseSubtask(subtaskId: string): void {
		console.log(`[ExecuteParallelSubtaskTool] pauseSubtask: ${subtaskId}`)
		// In production, this would signal the subagent to pause
	}

	/**
	 * Resume a paused subtask.
	 */
	resumeSubtask(subtaskId: string): void {
		console.log(`[ExecuteParallelSubtaskTool] resumeSubtask: ${subtaskId}`)
		// In production, this would signal the subagent to resume
	}

	/**
	 * Cancel a subtask.
	 */
	cancelSubtask(subtaskId: string): void {
		console.log(`[ExecuteParallelSubtaskTool] cancelSubtask: ${subtaskId}`)
		this.orchestrator?.cancel(subtaskId)
	}

	/**
	 * Retry a failed subtask.
	 */
	retrySubtask(subtaskId: string): void {
		console.log(`[ExecuteParallelSubtaskTool] retrySubtask: ${subtaskId}`)
		// In production, this would re-execute the subtask
	}

	/**
	 * Skip a subtask.
	 */
	skipSubtask(subtaskId: string): void {
		console.log(`[ExecuteParallelSubtaskTool] skipSubtask: ${subtaskId}`)
		const dag = this.orchestrator?.getDAG()
		if (dag) {
			const node = dag.nodes.get(subtaskId)
			if (node) {
				node.status = "skipped"
			}
		}
	}

	/**
	 * Resume a persisted DAG.
	 */
	resumeDAG(correlationId: string): void {
		console.log(`[ExecuteParallelSubtaskTool] resumeDAG: ${correlationId}`)
		// In production, this would reload the DAG from .roosync/dag-state-{correlationId}.json
	}
}

// ============================================================================
// Singleton export
// ============================================================================

export const executeParallelSubtaskTool = new ExecuteParallelSubtaskTool()
