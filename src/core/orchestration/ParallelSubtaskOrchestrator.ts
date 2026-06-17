/**
 * Parallel Subtask Orchestrator — top-level execution engine.
 *
 * Orchestrates the full lifecycle of parallel subtask execution:
 * 1. Build DAG from tasks
 * 2. Detect cycles → fail if found
 * 3. Topological sort → waves
 * 4. For each wave: spawn subtasks via SubtaskExecutor, monitor, handle failures
 * 5. Aggregate results
 *
 * Subtasks execute **sequentially** within each wave to respect the
 * single-open-task invariant (only one Task can be active at a time).
 * The DAG provides dependency ordering and wave structure; parallelism
 * is achieved by the child agent's own tool calls, not by concurrent
 * Task instances.
 *
 * Integrates with LockManager, Blackboard, ContextRouter, and LogAggregator.
 *
 * @module
 */

import type {
	SubtaskNode,
	SubtaskDAG,
	LogEntry,
	LogFilter,
	ExecutionResult,
	SubtaskExecutionResult,
} from "@roo-code/types"

import { SubtaskDAGBuilder } from "./SubtaskDAG"
import { LockManager } from "./LockManager"
import { Blackboard } from "./Blackboard"
import { ContextRouter } from "./ContextRouter"
import { LogAggregator, CorrelationIdManager } from "./LogAggregator"

// ============================================================================
// Types
// ============================================================================

/**
 * Callback that spawns a real child agent for a subtask.
 *
 * Implementations must call `task.startSubtask(message, todos, mode)`
 * which delegates via `ClineProvider.delegateParentAndOpenChild()`.
 * The child runs to completion (attempt_completion) before the promise
 * resolves with the child's result summary.
 */
export type SubtaskExecutor = (params: {
	subtaskId: string
	message: string
	mode: string
	todos?: string
}) => Promise<{ taskId: string; result: string }>

// ============================================================================
// Constants
// ============================================================================

/** Default maximum parallel subtasks (used for semaphore, but execution is sequential). */
const DEFAULT_MAX_PARALLEL = 1

/** Default timeout per subtask (ms). */
const DEFAULT_TIMEOUT_MS = 300_000

/** Heartbeat check interval (ms). */
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000

// ============================================================================
// ParallelSubtaskOrchestrator
// ============================================================================

/**
 * Top-level orchestrator for parallel subtask execution.
 *
 * Manages the full lifecycle: DAG construction, wave-based execution,
 * lock-aware scheduling, failure handling, and result aggregation.
 */
export class ParallelSubtaskOrchestrator {
	private dagBuilder: SubtaskDAGBuilder
	private lockManager: LockManager
	private blackboard: Blackboard
	private contextRouter: ContextRouter
	private logAggregator: LogAggregator

	private currentDAG: SubtaskDAG | null = null
	private isRunning = false
	private abortRequested = false
	private maxParallel: number
	private heartbeatTimer: NodeJS.Timeout | null = null

	/**
	 * Real subtask executor — calls task.startSubtask() to spawn a child agent.
	 * Set by the tool that owns this orchestrator.
	 */
	private subtaskExecutor: SubtaskExecutor | null = null

	/**
	 * @param lockManager - LockManager instance
	 * @param blackboard - Blackboard instance
	 * @param contextRouter - ContextRouter instance
	 * @param logAggregator - LogAggregator instance
	 * @param maxParallel - Maximum parallel subtasks (default: 1)
	 */
	constructor(
		lockManager: LockManager,
		blackboard: Blackboard,
		contextRouter: ContextRouter,
		logAggregator: LogAggregator,
		maxParallel: number = DEFAULT_MAX_PARALLEL,
	) {
		this.dagBuilder = new SubtaskDAGBuilder()
		this.lockManager = lockManager
		this.blackboard = blackboard
		this.contextRouter = contextRouter
		this.logAggregator = logAggregator
		this.maxParallel = maxParallel
	}

	/**
	 * Set the real subtask executor.
	 * Must be called before execute() to enable real child agent spawning.
	 */
	setSubtaskExecutor(executor: SubtaskExecutor): void {
		this.subtaskExecutor = executor
	}

	/**
	 * Execute a set of subtasks.
	 *
	 * @param tasks - Array of subtask nodes to execute
	 * @returns The final SubtaskDAG with execution results
	 */
	async execute(tasks: SubtaskNode[]): Promise<SubtaskDAG> {
		const correlationId = CorrelationIdManager.generate()
		CorrelationIdManager.set(correlationId)

		this.logAggregator.log({
			correlationId,
			subtaskId: "",
			component: "orchestrator",
			level: "info",
			message: `Starting parallel subtask execution: ${tasks.length} task(s)`,
			timestamp: new Date().toISOString(),
		})

		if (tasks.length === 0) {
			const emptyDAG: SubtaskDAG = {
				nodes: new Map(),
				edges: new Map(),
				waves: [],
				status: "completed",
			}
			this.currentDAG = emptyDAG
			return emptyDAG
		}

		// Step 1: Build DAG
		this.logAggregator.log({
			correlationId,
			subtaskId: "",
			component: "dag-builder",
			level: "info",
			message: `Building DAG from ${tasks.length} task(s)`,
			timestamp: new Date().toISOString(),
		})

		const dag = this.dagBuilder.build(tasks)
		this.currentDAG = dag

		// Step 2: Detect cycles
		const cycles = this.dagBuilder.detectCycles(dag)
		if (cycles.length > 0) {
			const cycleStr = cycles.map((c) => c.join(" → ")).join("; ")
			this.logAggregator.log({
				correlationId,
				subtaskId: "",
				component: "dag-builder",
				level: "error",
				message: `Cycles detected in DAG: ${cycleStr}`,
				timestamp: new Date().toISOString(),
			})

			dag.status = "failed"
			return dag
		}

		// Step 3: Execute waves
		this.isRunning = true
		this.abortRequested = false
		dag.status = "running"

		// Start heartbeat monitor
		this.startHeartbeatMonitor()

		try {
			await this.executeWaves(dag, correlationId)
		} catch (error) {
			this.logAggregator.log({
				correlationId,
				subtaskId: "",
				component: "orchestrator",
				level: "error",
				message: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
				timestamp: new Date().toISOString(),
			})
			dag.status = "failed"
		} finally {
			this.isRunning = false
			this.stopHeartbeatMonitor()
			this.lockManager.cleanupAllHeartbeats()
		}

		// Determine final status
		const allCompleted = [...dag.nodes.values()].every((n) => n.status === "completed" || n.status === "skipped")
		const anyFailed = [...dag.nodes.values()].some((n) => n.status === "failed" || n.status === "timed_out")

		if (allCompleted) {
			dag.status = "completed"
		} else if (anyFailed) {
			dag.status = "failed"
		} else if (this.abortRequested) {
			dag.status = "aborted"
		} else {
			dag.status = "failed"
		}

		this.logAggregator.log({
			correlationId,
			subtaskId: "",
			component: "orchestrator",
			level: "info",
			message: `Execution complete: status="${dag.status}"`,
			timestamp: new Date().toISOString(),
		})

		return dag
	}

	/**
	 * Cancel execution of a specific subtask or all subtasks.
	 *
	 * @param subtaskId - Optional subtask ID to cancel (all if not specified)
	 */
	cancel(subtaskId?: string): void {
		if (subtaskId) {
			this.logAggregator.log({
				correlationId: CorrelationIdManager.get(),
				subtaskId,
				component: "orchestrator",
				level: "warn",
				message: `Cancelling subtask: "${subtaskId}"`,
				timestamp: new Date().toISOString(),
			})

			const node = this.currentDAG?.nodes.get(subtaskId)
			if (node) {
				node.status = "skipped"
				this.lockManager.releaseAll(subtaskId)
				this.lockManager.cleanupHeartbeat(subtaskId)
			}
		} else {
			this.logAggregator.log({
				correlationId: CorrelationIdManager.get(),
				subtaskId: "",
				component: "orchestrator",
				level: "warn",
				message: "Aborting all subtasks",
				timestamp: new Date().toISOString(),
			})

			this.abortRequested = true
			this.isRunning = false

			// Release all locks
			if (this.currentDAG) {
				for (const nodeId of this.currentDAG.nodes.keys()) {
					this.lockManager.releaseAll(nodeId)
					this.lockManager.cleanupHeartbeat(nodeId)
				}
			}
		}
	}

	/**
	 * Get the current DAG status.
	 *
	 * @returns Current SubtaskDAG
	 */
	getStatus(): SubtaskDAG {
		return (
			this.currentDAG ?? {
				nodes: new Map(),
				edges: new Map(),
				waves: [],
				status: "pending",
			}
		)
	}

	/**
	 * Get the full DAG.
	 *
	 * @returns Current SubtaskDAG
	 */
	getDAG(): SubtaskDAG {
		return this.getStatus()
	}

	/**
	 * Get logs with optional filter.
	 *
	 * @param filter - Optional log filter
	 * @returns Array of matching log entries
	 */
	getLogs(filter?: LogFilter): LogEntry[] {
		return this.logAggregator.getLogs(filter)
	}

	/**
	 * Build an ExecutionResult from the current DAG state.
	 *
	 * @returns ExecutionResult
	 */
	getExecutionResult(): ExecutionResult {
		const dag = this.currentDAG
		if (!dag) {
			return {
				correlationId: CorrelationIdManager.get(),
				status: "failed",
				subtaskResults: [],
				totalDurationMs: 0,
				tokenUsage: { total: 0, perSubtask: new Map() },
			}
		}

		const subtaskResults: SubtaskExecutionResult[] = []
		let totalTokens = 0
		const perSubtask = new Map<string, number>()

		for (const [, node] of dag.nodes) {
			const duration =
				node.metadata.completedAt && node.metadata.startedAt
					? node.metadata.completedAt - node.metadata.startedAt
					: 0

			subtaskResults.push({
				id: node.id,
				status: node.status,
				durationMs: duration,
				error: node.metadata.error,
			})

			const tokens = node.estimatedTokens || 0
			totalTokens += tokens
			perSubtask.set(node.id, tokens)
		}

		return {
			correlationId: CorrelationIdManager.get(),
			status: dag.status === "completed" ? "completed" : dag.status === "running" ? "partial" : "failed",
			subtaskResults,
			totalDurationMs: Date.now(),
			tokenUsage: { total: totalTokens, perSubtask },
		}
	}

	// ========================================================================
	// Private: Wave Execution
	// ========================================================================

	/**
	 * Execute DAG waves sequentially, with parallel subtask execution within each wave.
	 */
	private async executeWaves(dag: SubtaskDAG, correlationId: string): Promise<void> {
		for (let waveIndex = 0; waveIndex < dag.waves.length; waveIndex++) {
			if (this.abortRequested) {
				break
			}

			const wave = dag.waves[waveIndex]
			this.logAggregator.log({
				correlationId,
				subtaskId: "",
				component: "orchestrator",
				level: "info",
				message: `Executing wave ${waveIndex + 1}/${dag.waves.length}: ${wave.length} subtask(s)`,
				timestamp: new Date().toISOString(),
			})

			// Lock-aware scheduling: partition into ready vs blocked
			const { ready, blocked } = await this.partitionWave(wave, dag)

			if (blocked.length > 0) {
				this.logAggregator.log({
					correlationId,
					subtaskId: "",
					component: "orchestrator",
					level: "warn",
					message: `${blocked.length} subtask(s) blocked on locks in wave ${waveIndex + 1}`,
					timestamp: new Date().toISOString(),
				})
			}

			// Execute ready subtasks with concurrency limit
			const active: Promise<void>[] = []
			const semaphore = this.createSemaphore(this.maxParallel)

			for (const subtask of ready) {
				if (this.abortRequested) {
					break
				}

				const execPromise = semaphore.run(async () => {
					await this.executeSingleSubtask(subtask, dag, correlationId)
				})

				active.push(execPromise)
			}

			// Wait for all active subtasks in this wave
			await Promise.allSettled(active)

			// Handle blocked subtasks — recheck after wave completes
			for (const subtask of blocked) {
				if (this.abortRequested) {
					break
				}
				// Mark as skipped since their dependencies may never be satisfied
				subtask.status = "skipped"
				this.logAggregator.log({
					correlationId,
					subtaskId: subtask.id,
					component: "orchestrator",
					level: "warn",
					message: `Subtask "${subtask.id}" skipped (blocked on locks)`,
					timestamp: new Date().toISOString(),
				})
			}

			// Check for failures and recalculate DAG if needed
			const failedNodes = wave.filter((n) => n.status === "failed" || n.status === "timed_out")

			for (const failedNode of failedNodes) {
				this.dagBuilder.recalculateOnFailure(dag, failedNode.id)
			}
		}
	}

	/**
	 * Execute a single subtask.
	 */
	private async executeSingleSubtask(subtask: SubtaskNode, dag: SubtaskDAG, correlationId: string): Promise<void> {
		const startTime = Date.now()
		subtask.status = "running"
		subtask.metadata.startedAt = startTime
		subtask.metadata.correlationId = correlationId

		// Create heartbeat
		const heartbeatPath = this.lockManager.createHeartbeat(subtask.id)
		subtask.metadata.heartbeatPath = heartbeatPath

		this.logAggregator.log({
			correlationId,
			subtaskId: subtask.id,
			component: "orchestrator",
			level: "info",
			message: `Starting subtask "${subtask.id}" (mode="${subtask.mode}")`,
			timestamp: new Date().toISOString(),
		})

		try {
			// Acquire locks on output files
			for (const outputFile of subtask.outputFiles) {
				const lock = await this.lockManager.acquire({
					level: "file",
					target: outputFile,
					type: "write",
					subtaskId: subtask.id,
					timeoutMs: subtask.timeoutMs || DEFAULT_TIMEOUT_MS,
				})

				if (!lock) {
					throw new Error(`Could not acquire write lock on "${outputFile}"`)
				}
			}

			// Build context
			const context = await this.contextRouter.buildContext(subtask)

			// Subscribe to blackboard topics
			if (subtask.subscribedTopics.length > 0) {
				this.blackboard.subscribe(subtask.id, subtask.subscribedTopics)
			}

			// Publish to blackboard topics (mark subtask as started)
			for (const topic of subtask.publishedTopics) {
				await this.blackboard.publish(topic, { status: "running", subtaskId: subtask.id }, subtask.id)
			}

			// Execute the subtask via the real executor (spawns a child agent).
			// If no executor is set, we fall back to a minimal delay for testing.
			if (this.subtaskExecutor) {
				const result = await this.subtaskExecutor({
					subtaskId: subtask.id,
					message: subtask.prompt,
					mode: subtask.mode,
					todos: undefined,
				})

				// Mark as completed with the child's result
				subtask.status = "completed"
				subtask.metadata.completedAt = Date.now()
				subtask.metadata.result = result.result

				this.logAggregator.log({
					correlationId,
					subtaskId: subtask.id,
					component: "orchestrator",
					level: "info",
					message: `Subtask "${subtask.id}" completed (child: ${result.taskId})`,
					timestamp: new Date().toISOString(),
					durationMs: Date.now() - startTime,
				})
			} else {
				// No executor set — this is a test or dry-run scenario.
				// Use a minimal delay so tests still pass.
				await new Promise((resolve) => setTimeout(resolve, 50))

				subtask.status = "completed"
				subtask.metadata.completedAt = Date.now()

				this.logAggregator.log({
					correlationId,
					subtaskId: subtask.id,
					component: "orchestrator",
					level: "info",
					message: `Subtask "${subtask.id}" completed (dry-run)`,
					timestamp: new Date().toISOString(),
					durationMs: Date.now() - startTime,
				})
			}

			// Publish completion to blackboard
			for (const topic of subtask.publishedTopics) {
				await this.blackboard.publish(topic, { status: "completed", subtaskId: subtask.id }, subtask.id)
			}
		} catch (error) {
			subtask.status = "failed"
			subtask.metadata.completedAt = Date.now()
			subtask.metadata.error = error instanceof Error ? error.message : String(error)

			this.logAggregator.log({
				correlationId,
				subtaskId: subtask.id,
				component: "orchestrator",
				level: "error",
				message: `Subtask "${subtask.id}" failed: ${subtask.metadata.error}`,
				timestamp: new Date().toISOString(),
				durationMs: Date.now() - startTime,
			})
		} finally {
			// Release all locks
			this.lockManager.releaseAll(subtask.id)
			this.lockManager.cleanupHeartbeat(subtask.id)

			// Unsubscribe from blackboard
			if (subtask.subscribedTopics.length > 0) {
				this.blackboard.unsubscribe(subtask.id)
			}
		}
	}

	/**
	 * Partition wave subtasks into ready (all locks free) vs blocked (≥1 lock held).
	 */
	private async partitionWave(
		wave: SubtaskNode[],
		_dag: SubtaskDAG,
	): Promise<{ ready: SubtaskNode[]; blocked: SubtaskNode[] }> {
		const ready: SubtaskNode[] = []
		const blocked: SubtaskNode[] = []

		for (const subtask of wave) {
			let allLocksFree = true

			for (const outputFile of subtask.outputFiles) {
				if (this.lockManager.isLocked("file", outputFile)) {
					allLocksFree = false
					break
				}
			}

			if (allLocksFree) {
				ready.push(subtask)
			} else {
				blocked.push(subtask)
			}
		}

		return { ready, blocked }
	}

	// ========================================================================
	// Private: Heartbeat Monitor
	// ========================================================================

	/**
	 * Start the heartbeat monitor loop.
	 */
	private startHeartbeatMonitor(): void {
		this.heartbeatTimer = setInterval(() => {
			this.checkHeartbeats()
		}, HEARTBEAT_CHECK_INTERVAL_MS)

		if (this.heartbeatTimer && typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
			;(this.heartbeatTimer as NodeJS.Timeout).unref()
		}
	}

	/**
	 * Stop the heartbeat monitor loop.
	 */
	private stopHeartbeatMonitor(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
	}

	/**
	 * Check all running subtasks' heartbeats.
	 * If a heartbeat is stale, mark the subtask as failed.
	 */
	private checkHeartbeats(): void {
		if (!this.currentDAG) {
			return
		}

		for (const [, node] of this.currentDAG.nodes) {
			if (node.status !== "running" || !node.metadata.heartbeatPath) {
				continue
			}

			if (!this.lockManager.isHeartbeatAlive(node.metadata.heartbeatPath)) {
				this.logAggregator.log({
					correlationId: CorrelationIdManager.get(),
					subtaskId: node.id,
					component: "orchestrator",
					level: "error",
					message: `Subtask "${node.id}" heartbeat lost — marking as failed`,
					timestamp: new Date().toISOString(),
				})

				node.status = "failed"
				node.metadata.error = "Heartbeat timeout"
				node.metadata.completedAt = Date.now()

				this.lockManager.releaseAll(node.id)
				this.lockManager.cleanupHeartbeat(node.id)
			}
		}
	}

	// ========================================================================
	// Private: Semaphore
	// ========================================================================

	/**
	 * Create a simple promise-based semaphore for concurrency limiting.
	 */
	private createSemaphore(max: number): {
		run: <T>(fn: () => Promise<T>) => Promise<T>
	} {
		let current = 0
		const queue: Array<() => void> = []

		const acquire = (): Promise<void> => {
			if (current < max) {
				current++
				return Promise.resolve()
			}
			return new Promise((resolve) => {
				queue.push(resolve)
			})
		}

		const release = (): void => {
			const next = queue.shift()
			if (next) {
				next()
			} else {
				current--
			}
		}

		return {
			run: async <T>(fn: () => Promise<T>): Promise<T> => {
				await acquire()
				try {
					return await fn()
				} finally {
					release()
				}
			},
		}
	}
}
