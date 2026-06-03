import crypto from "crypto"
import { SubagentPool } from "./SubagentPool"
import { IsolatedContextFactory } from "./IsolatedContext"
import type {
	SubagentConfig,
	SubagentResult,
	SubagentStatus,
	SubagentStatusValue,
	SubagentEntry,
	AggregatedResult,
	ExecutionSummary,
	PoolSlot,
} from "./types"
import {
	SubagentError,
	SubagentTimeoutError,
	generateSubagentId,
	DEFAULT_POOL_SIZE,
	DEFAULT_SUBAGENT_OPTIONS,
} from "./types"
import type { IsolatedContext } from "./IsolatedContext"
import type { SubagentOptions } from "./types"

/**
 * Main orchestrator for subagent lifecycle management.
 *
 * Handles spawning individual and parallel subagents, tracking their status,
 * cancellation, and cleanup. Uses SubagentPool for concurrency control and
 * IsolatedContextFactory for execution environment isolation.
 *
 * @example
 * ```ts
 * const manager = new SubagentManager({ poolSize: 3 })
 * const result = await manager.spawnSubagent({
 *   subagentId: generateSubagentId(),
 *   role: "leaf",
 *   taskPrompt: "Refactor the auth module to use async/await",
 *   workdir: "/workspace/src",
 *   allowedTools: ["read_file", "apply_diff", "search_files"],
 * })
 * ```
 */
export class SubagentManager {
	private readonly pool: SubagentPool
	private readonly activeSubagents: Map<string, SubagentEntry>
	private readonly options: Required<SubagentOptions>
	private readonly workspaceRoot: string
	private isDisposed = false

	/**
	 * @param options.poolSize - Maximum concurrent subagents (default: 3)
	 * @param options.workspaceRoot - Root directory for workdir resolution
	 * @param options.subagentOptions - Default options applied to every subagent
	 */
	constructor(
		options: {
			poolSize?: number
			workspaceRoot: string
			subagentOptions?: SubagentOptions
		} = { workspaceRoot: process.cwd() },
	) {
		this.pool = new SubagentPool({ maxSize: options.poolSize ?? DEFAULT_POOL_SIZE })
		this.activeSubagents = new Map()
		this.options = { ...DEFAULT_SUBAGENT_OPTIONS, ...options.subagentOptions }
		this.workspaceRoot = options.workspaceRoot
	}

	/**
	 * Spawn a single subagent with its own isolated context.
	 *
	 * Acquires a pool slot, creates an isolated context (temp dir, env vars,
	 * tool restrictions), and executes the subagent task. On completion or
	 * failure the pool slot is released and context is cleaned up.
	 *
	 * @param config - Configuration for the subagent
	 * @returns The subagent's result
	 * @throws {SubagentError} If the manager is disposed or spawning fails
	 */
	async spawnSubagent(config: SubagentConfig): Promise<SubagentResult> {
		this.throwIfDisposed()

		const subagentId = config.subagentId ?? generateSubagentId()
		const entry = this.createEntry(config, subagentId)
		this.activeSubagents.set(subagentId, entry)

		let slot: PoolSlot | undefined
		let context: IsolatedContext | undefined

		try {
			// Acquire pool slot (may wait)
			slot = await this.pool.acquire()

			// Update status to running
			entry.status = "running"
			entry.startedAt = Date.now()

			// Create isolated context
			context = await IsolatedContextFactory.create({
				role: config.role,
				envVars: config.envVars,
				allowedTools: config.allowedTools,
				workdir: config.workdir,
				workspaceRoot: this.workspaceRoot,
			})

			// Execute with timeout
			const result = await this.executeWithTimeout(subagentId, config, entry)

			// Mark completed
			entry.status = "completed"
			entry.result = result
			entry.completedAt = Date.now()

			return result
		} catch (error) {
			// Determine final status
			if (error instanceof SubagentTimeoutError) {
				entry.status = "timed_out"
			} else if (entry.status !== "cancelled") {
				entry.status = "failed"
			}
			entry.error = error instanceof Error ? error.message : String(error)
			entry.completedAt = Date.now()

			return {
				subagentId,
				success: false,
				output: "",
				filesModified: [],
				fileChanges: [],
				errors: [entry.error],
				executionTimeMs: entry.completedAt - entry.startedAt,
			}
		} finally {
			// Release pool slot
			if (slot) {
				this.pool.release(slot)
			}
			// Clean up context
			if (context) {
				await IsolatedContextFactory.destroy(context).catch(() => {
					// Log but don't throw during cleanup
				})
			}
		}
	}

	/**
	 * Spawn multiple subagents in parallel with concurrency control.
	 *
	 * Uses the pool's built-in semaphore to limit concurrent execution.
	 * Results are returned in the same order as the input configs.
	 * If a subagent fails, other subagents continue unaffected.
	 *
	 * @param configs - Array of subagent configurations
	 * @param maxConcurrency - Optional override for max parallel (default: pool size)
	 * @returns Array of results in config order
	 */
	async spawnParallel(configs: SubagentConfig[], maxConcurrency?: number): Promise<SubagentResult[]> {
		this.throwIfDisposed()

		if (configs.length === 0) {
			return []
		}

		// Generate IDs for configs that lack them
		const configsWithIds = configs.map((c) => ({
			...c,
			subagentId: c.subagentId ?? generateSubagentId(),
		}))

		// Promise concurrency control: run at most `concurrencyLimit` at a time
		const concurrencyLimit = Math.min(maxConcurrency ?? this.pool.getMaxSize(), this.pool.getMaxSize())

		const results: SubagentResult[] = []
		const queue = [...configsWithIds]

		// Execute up to `concurrencyLimit` configs in parallel, then one replaces
		// each completed item until the queue is drained (semaphore pattern)
		const runNext = (): Promise<void> => {
			if (queue.length === 0) {
				return Promise.resolve()
			}

			const config = queue.shift()!
			return this.spawnSubagent(config)
				.then((result) => {
					results.push(result)
				})
				.catch((error: Error) => {
					results.push({
						subagentId: config.subagentId,
						success: false,
						output: "",
						filesModified: [],
						fileChanges: [],
						errors: [error.message],
						executionTimeMs: 0,
					})
				})
				.then(() => runNext())
		}

		// Start initial batch
		const initialBatch = Math.min(concurrencyLimit, queue.length)
		const runners: Promise<void>[] = []
		for (let i = 0; i < initialBatch; i++) {
			runners.push(runNext())
		}

		await Promise.all(runners)

		return results
	}

	/**
	 * Get the current status of a subagent.
	 *
	 * @param subagentId - The subagent's ID
	 * @returns The subagent's status
	 * @throws {SubagentError} If the subagent is not found
	 */
	getStatus(subagentId: string): SubagentStatus {
		const entry = this.activeSubagents.get(subagentId)
		if (!entry) {
			throw new SubagentError(`Subagent ${subagentId} not found`, "NOT_FOUND")
		}

		return {
			subagentId,
			status: entry.status,
			progress: entry.progress,
			startedAt: entry.startedAt,
			completedAt: entry.completedAt,
			error: entry.error,
		}
	}

	/**
	 * Cancel a running subagent. Sets its abort signal so the execution
	 * can be interrupted, and marks its status as "cancelled".
	 *
	 * @param subagentId - The subagent's ID
	 * @throws {SubagentError} If the subagent is not found
	 */
	async cancelSubagent(subagentId: string): Promise<void> {
		const entry = this.activeSubagents.get(subagentId)
		if (!entry) {
			throw new SubagentError(`Subagent ${subagentId} not found`, "NOT_FOUND")
		}

		if (entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled") {
			return // Already finished
		}

		// Signal abortion
		if (entry.abortController) {
			entry.abortController.abort()
		}

		entry.status = "cancelled"
		entry.completedAt = Date.now()
	}

	/**
	 * Cancel all active subagents. Useful for parent task cleanup.
	 */
	async cancelAll(): Promise<void> {
		const ids = [...this.activeSubagents.keys()]
		await Promise.allSettled(ids.map((id) => this.cancelSubagent(id)))
	}

	/**
	 * Get the aggregate status of all tracked subagents.
	 */
	getAllStatuses(): SubagentStatus[] {
		const statuses: SubagentStatus[] = []
		for (const [subagentId, entry] of this.activeSubagents) {
			statuses.push({
				subagentId,
				status: entry.status,
				progress: entry.progress,
				startedAt: entry.startedAt,
				completedAt: entry.completedAt,
				error: entry.error,
			})
		}
		return statuses
	}

	/**
	 * Generate an execution summary across all tracked subagents.
	 */
	getExecutionSummary(): ExecutionSummary {
		let succeeded = 0
		let failed = 0
		let timedOut = 0
		let cancelled = 0
		let totalTime = 0

		for (const [, entry] of this.activeSubagents) {
			switch (entry.status) {
				case "completed":
					succeeded++
					break
				case "failed":
					failed++
					break
				case "timed_out":
					timedOut++
					break
				case "cancelled":
					cancelled++
					break
			}
			if (entry.completedAt && entry.startedAt) {
				totalTime += entry.completedAt - entry.startedAt
			}
		}

		return {
			totalSubagents: this.activeSubagents.size,
			succeeded,
			failed,
			timedOut,
			cancelled,
			totalExecutionTimeMs: totalTime,
		}
	}

	/**
	 * Get the underlying pool for direct access (e.g. for diagnostics).
	 */
	getPool(): SubagentPool {
		return this.pool
	}

	/**
	 * Dispose the manager. Cancels all active subagents and disposes the pool.
	 * No new subagents can be spawned after disposal.
	 */
	async dispose(): Promise<void> {
		if (this.isDisposed) {
			return
		}
		this.isDisposed = true
		await this.cancelAll()
		this.pool.dispose()
		this.activeSubagents.clear()
	}

	// ─── Private Helpers ──────────────────────────────────────────────────

	/**
	 * Create a tracking entry for a new subagent.
	 */
	private createEntry(config: SubagentConfig, subagentId: string): SubagentEntry {
		return {
			config,
			status: "pending",
			progress: 0,
			startedAt: 0,
			abortController: new AbortController(),
		}
	}

	/**
	 * Execute a subagent with a timeout guard.
	 */
	private async executeWithTimeout(
		subagentId: string,
		config: SubagentConfig,
		entry: SubagentEntry,
	): Promise<SubagentResult> {
		const timeoutMs = config.timeoutMs ?? this.options.timeout
		const startTime = Date.now()

		const executionPromise = this.executeSubagentTask(config, entry)

		const timeoutPromise = new Promise<SubagentResult>((_, reject) => {
			const timer = setTimeout(() => {
				reject(new SubagentTimeoutError(subagentId, timeoutMs))
			}, timeoutMs)

			// Clean up timer if abort is signalled
			if (entry.abortController) {
				entry.abortController.signal.addEventListener("abort", () => {
					clearTimeout(timer)
					reject(new SubagentError(`Subagent ${subagentId} cancelled`, "CANCELLED"))
				})
			}
		})

		const partial = await Promise.race([executionPromise, timeoutPromise])
		const executionTimeMs = Date.now() - startTime

		return {
			...partial,
			subagentId,
			executionTimeMs,
		}
	}

	/**
	 * Core execution of a subagent task.
	 * This is the integration point where the actual subagent would be spawned
	 * via NewTaskTool or similar mechanism.
	 *
	 * Currently provides a hook for concrete implementations to override.
	 */
	protected async executeSubagentTask(
		_config: SubagentConfig,
		_entry: SubagentEntry,
	): Promise<Omit<SubagentResult, "executionTimeMs">> {
		// Concrete implementations should override this method to:
		// 1. Create a new Task instance with filtered tools
		// 2. Set up isolated conversation history
		// 3. Execute the task with the given prompt
		// 4. Collect and return the results

		// Default implementation: placeholder that throws if not overridden
		throw new SubagentError(
			"executeSubagentTask must be overridden by a concrete implementation",
			"NOT_IMPLEMENTED",
		)
	}

	/**
	 * Throw if the manager has been disposed.
	 */
	private throwIfDisposed(): void {
		if (this.isDisposed) {
			throw new SubagentError("SubagentManager has been disposed", "DISPOSED")
		}
	}
}
