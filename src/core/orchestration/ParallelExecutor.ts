/**
 * Parallel task execution engine for Zoo-Code's multi-language monorepo orchestration.
 *
 * Orchestrates concurrent execution of terminal commands using semaphore-limited
 * parallelism. Each command runs in its own subprocess via `execa`, avoiding VS Code
 * terminal UI contention for parallel workloads. Provides grouped execution with
 * dependency resolution via `wait_for`, sequential group fallback, and graceful
 * degradation when the parallel execution feature flag is disabled.
 *
 * ## Key Design Decisions
 *
 * - **Execa subprocess** for each parallel command (no VS Code terminal UI overhead).
 * - **Semaphore** (promise-based) to bound concurrency at `os.cpus().length` by default.
 * - **Promise.allSettled** semantics — one failure does not cancel other commands.
 * - **Bounded output buffers** (100KB per stream) matching the existing
 *   `ExecuteCommandTool` memory guard.
 * - **Timeout per command** via execa's built-in timeout support.
 *
 * @module
 */

import * as os from "os"
import * as path from "path"
import { execa, ExecaError } from "execa"

import type {
	AggregatedResult,
	CommandResult,
	GroupResult,
	ParallelCommand,
	ParallelCommandGroup,
	ParsedError,
	ParsedResult,
} from "@roo-code/types"

// ============================================================================
// Types
// ============================================================================

/**
 * Runtime execution options for a batch of parallel commands.
 */
export interface ExecOptions {
	/** Default working directory for commands that don't specify one */
	cwd?: string
	/** Default timeout in milliseconds for each command (0 / undefined = no timeout) */
	timeout?: number
	/** Maximum number of commands to execute concurrently */
	concurrency?: number
	/** If true, force sequential execution regardless of feature flag */
	sequential?: boolean
}

/**
 * Constructor options for the ParallelExecutor.
 */
export interface ParallelExecutorOptions {
	/** Maximum concurrency (default: os.cpus().length or 4) */
	maxParallel?: number
	/** Terminal provider to use ("execa" subprocess or "vscode" terminal) */
	terminalProvider?: "execa" | "vscode"
	/** Whether parallel execution is enabled via feature flag */
	isParallelEnabled?: boolean
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum accumulated output buffer per command (100KB, matching ExecuteCommandTool). */
const MAX_OUTPUT_SIZE = 100_000

/** Fallback concurrency when os.cpus() is unavailable. */
const DEFAULT_CONCURRENCY = 4

// ============================================================================
// Semaphore
// ============================================================================

/**
 * Simple promise-based semaphore for concurrency limiting.
 *
 * Manages a fixed number of permits. Callers {@link acquire} a permit before
 * starting work and {@link release} it when done. If all permits are held,
 * `acquire()` blocks until a permit becomes available.
 *
 * @example
 * ```typescript
 * const sem = new Semaphore(2)
 * // Run up to 2 tasks concurrently
 * await Promise.all([
 *   sem.run(() => fetch("/a")),
 *   sem.run(() => fetch("/b")),
 *   sem.run(() => fetch("/c")), // starts after /a or /b finishes
 * ])
 * ```
 */
export class Semaphore {
	private current = 0
	private queue: Array<() => void> = []

	/**
	 * @param max - Maximum number of concurrent acquisitions (clamped to minimum 1)
	 */
	constructor(private max: number) {
		this.max = Math.max(1, max)
	}

	/**
	 * Acquire a permit, blocking if at capacity.
	 * The returned promise resolves when a slot becomes available.
	 */
	async acquire(): Promise<void> {
		if (this.current < this.max) {
			this.current++
			return
		}
		return new Promise((resolve) => {
			this.queue.push(resolve)
		})
	}

	/**
	 * Release a permit, allowing the next queued acquisition to proceed.
	 * If no one is waiting, decrements the counter for the next `acquire()`.
	 */
	release(): void {
		const next = this.queue.shift()
		if (next) {
			// Hand the permit directly to the next waiter — no counter change
			next()
		} else {
			this.current--
		}
	}

	/**
	 * Run an async function under the semaphore guard.
	 * Acquires a permit before `fn` starts and releases it when `fn` completes
	 * (or throws).
	 *
	 * @param fn - The async function to execute
	 * @returns The result of `fn`
	 */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire()
		try {
			return await fn()
		} finally {
			this.release()
		}
	}

	/**
	 * Dynamically adjust the maximum concurrency.
	 *
	 * @param n - New maximum (clamped to minimum of 1)
	 */
	setConcurrency(n: number): void {
		this.max = Math.max(1, n)
	}
}

// ============================================================================
// ParallelExecutor
// ============================================================================

/**
 * Core engine for orchestrating parallel command execution.
 *
 * ## Method overview
 *
 * | Method | Use case |
 * |--------|----------|
 * | {@link execute} | Flat array of commands, returns single-group `AggregatedResult` |
 * | {@link executeGroup} | Single `ParallelCommandGroup` — respects `sequential` flag |
 * | {@link executeGroups} | Full dependency graph with `wait_for` edges |
 * | {@link executeParallel} | Low-level semaphore-limited concurrent dispatch |
 * | {@link executeSequential} | Sequential fallback (feature flag disabled / forced) |
 *
 * ## Graceful degradation
 *
 * When `isParallelEnabled` is `false`, all `execute*()` methods transparently
 * fall back to sequential execution. Callers always receive the same
 * `AggregatedResult` / `GroupResult` shape regardless.
 */
export class ParallelExecutor {
	private semaphore: Semaphore
	private terminalProvider: "execa" | "vscode"
	private isParallelEnabled: boolean

	/**
	 * @param options - Optional configuration
	 */
	constructor(private options: ParallelExecutorOptions = {}) {
		const cpuCount = os.cpus()?.length ?? DEFAULT_CONCURRENCY
		this.semaphore = new Semaphore(options.maxParallel ?? cpuCount)
		this.terminalProvider = options.terminalProvider ?? "execa"
		this.isParallelEnabled = options.isParallelEnabled ?? true
	}

	// ========================================================================
	// Public API
	// ========================================================================

	/**
	 * Execute a flat array of commands and return aggregated results.
	 *
	 * This is the main entry point for simple parallel usage where all commands
	 * are independent and belong to a single implicit group.
	 *
	 * @param commands - Commands to execute
	 * @param options - Runtime options (cwd, timeout, concurrency, force-sequential)
	 * @returns Aggregated result with one implicit group
	 */
	async execute(commands: ParallelCommand[], options?: ExecOptions): Promise<AggregatedResult> {
		if (commands.length === 0) {
			return emptyAggregatedResult()
		}

		const startTime = Date.now()
		const concurrency = options?.concurrency ?? this.options.maxParallel ?? os.cpus()?.length ?? DEFAULT_CONCURRENCY

		let results: CommandResult[]
		if (options?.sequential || !this.isParallelEnabled) {
			results = await this.executeSequential(commands, options)
		} else {
			results = await this.executeParallel(commands, concurrency, options)
		}

		const endTime = Date.now()
		const successCount = results.filter((r) => r.exitCode === 0 && !r.error).length
		const failedCount = results.filter((r) => r.exitCode !== 0 || !!r.error).length
		const skippedCount = results.filter((r) => r.error?.startsWith("Skipped:")).length

		return {
			groups: [
				{
					id: "default",
					sequential: options?.sequential ?? !this.isParallelEnabled,
					commands: results,
					successCount,
					failedCount,
					skippedCount,
					totalDuration: endTime - startTime,
				},
			],
			totalDuration: endTime - startTime,
			successCount,
			failedCount,
			skippedCount,
		}
	}

	/**
	 * Execute a single command group and return its result.
	 *
	 * Commands within the group execute according to the group's `sequential` flag:
	 * - `true` → sequential order (one after another)
	 * - `false` → concurrently (semaphore-limited)
	 *
	 * When `continue_on_error` is `false` and a sequential command fails,
	 * remaining commands in the group are skipped.
	 *
	 * @param group - The command group to execute
	 * @param options - Runtime options (cwd, timeout, concurrency)
	 * @returns Group result with per-command details
	 */
	async executeGroup(group: ParallelCommandGroup, options?: ExecOptions): Promise<GroupResult> {
		const startTime = Date.now()

		let cmdResults: CommandResult[]

		if (group.sequential || !this.isParallelEnabled) {
			cmdResults = await this.executeSequential(group.commands, options, group.continue_on_error)
		} else {
			const concurrency =
				options?.concurrency ?? this.options.maxParallel ?? os.cpus()?.length ?? DEFAULT_CONCURRENCY
			cmdResults = await this.executeParallel(group.commands, concurrency, options)
		}

		const endTime = Date.now()
		const successCount = cmdResults.filter((r) => r.exitCode === 0 && !r.error).length
		const failedCount = cmdResults.filter((r) => r.exitCode !== 0 || !!r.error).length
		const skippedCount = cmdResults.filter((r) => r.error?.startsWith("Skipped:")).length

		return {
			id: group.id,
			sequential: group.sequential,
			commands: cmdResults,
			successCount,
			failedCount,
			skippedCount,
			totalDuration: endTime - startTime,
		}
	}

	/**
	 * Execute multiple command groups respecting `wait_for` dependencies.
	 *
	 * Groups are topologically sorted by their `wait_for` edges. Groups with no
	 * dependencies execute concurrently (bounded by the semaphore). Groups with
	 * dependencies wait for their dependencies to complete before starting.
	 *
	 * Within each group, commands execute according to the group's `sequential` flag.
	 *
	 * @param groups - Array of command groups with optional dependency edges
	 * @param options - Runtime options
	 * @returns Aggregated result across all groups
	 */
	async executeGroups(groups: ParallelCommandGroup[], options?: ExecOptions): Promise<AggregatedResult> {
		if (groups.length === 0) {
			return emptyAggregatedResult()
		}

		const startTime = Date.now()
		const groupResults: GroupResult[] = []

		if (groups.length === 1) {
			// Fast path: single group, no dependency resolution needed
			const groupResult = await this.executeGroup(groups[0], options)
			groupResults.push(groupResult)
		} else {
			// Build dependency graph from wait_for
			const sortedGroups = this.topologicalSort(groups)
			const completed = new Set<string>()
			let remaining = [...sortedGroups]

			while (remaining.length > 0) {
				// Partition: groups whose dependencies are all satisfied vs not
				const ready: ParallelCommandGroup[] = []
				const blocked: ParallelCommandGroup[] = []

				for (const group of remaining) {
					const allDepsCompleted = (group.wait_for ?? []).every((depId) => completed.has(depId))
					if (allDepsCompleted) {
						ready.push(group)
					} else {
						blocked.push(group)
					}
				}

				if (ready.length === 0) {
					// Deadlock — mark remaining as skipped
					console.error("[ParallelExecutor] Deadlock detected in wait_for dependencies:", {
						remaining: remaining.map((g) => g.id),
						completed: [...completed],
					})
					for (const group of blocked) {
						groupResults.push(this.buildSkippedGroupResult(group))
					}
					break
				}

				// Execute ready groups concurrently (each group internally sequential or parallel)
				const waveResults = await Promise.all(
					ready.map(async (group) => {
						const result = await this.executeGroup(group, options)
						completed.add(group.id)
						return result
					}),
				)

				groupResults.push(...waveResults)
				remaining = blocked
			}
		}

		const endTime = Date.now()
		const totalSuccess = groupResults.reduce((sum, g) => sum + g.successCount, 0)
		const totalFailed = groupResults.reduce((sum, g) => sum + g.failedCount, 0)
		const totalSkipped = groupResults.reduce((sum, g) => sum + g.skippedCount, 0)

		return {
			groups: groupResults,
			totalDuration: endTime - startTime,
			successCount: totalSuccess,
			failedCount: totalFailed,
			skippedCount: totalSkipped,
		}
	}

	/**
	 * Low-level parallel execution with semaphore concurrency limiting.
	 *
	 * Each command runs in its own subprocess. Commands that time out or fail
	 * are captured in their individual `CommandResult.error` — they do NOT
	 * cancel other running commands.
	 *
	 * @param commands - Commands to execute
	 * @param concurrency - Maximum concurrent executions (default: 4)
	 * @param options - Runtime options
	 * @returns Array of command results (one per input command, in same order)
	 */
	async executeParallel(
		commands: ParallelCommand[],
		concurrency: number = DEFAULT_CONCURRENCY,
		options?: ExecOptions,
	): Promise<CommandResult[]> {
		if (commands.length === 0) {
			return []
		}

		const sem = new Semaphore(Math.max(1, concurrency))

		const tasks = commands.map((cmd) =>
			sem.run(() =>
				this.runSingleCommand(cmd, options).catch((error: unknown) =>
					this.buildErrorResult(cmd, options, error),
				),
			),
		)

		const settled = await Promise.allSettled(tasks)
		return settled.map((r, i) => {
			if (r.status === "fulfilled") return r.value
			return this.buildErrorResult(commands[i], options, r.reason)
		})
	}

	/**
	 * Sequential execution — runs commands one at a time.
	 *
	 * Used as fallback when the parallel execution feature flag is disabled or
	 * when `sequential: true` is requested.
	 *
	 * @param commands - Commands to execute in order
	 * @param options - Runtime options
	 * @param continueOnError - If true, continue on command failure (default: false)
	 * @returns Array of command results
	 */
	async executeSequential(
		commands: ParallelCommand[],
		options?: ExecOptions,
		continueOnError: boolean = false,
	): Promise<CommandResult[]> {
		const results: CommandResult[] = []
		let encounteredFailure = false

		for (let i = 0; i < commands.length; i++) {
			if (encounteredFailure && !continueOnError) {
				results.push(this.buildSkippedResult(commands[i], options))
				continue
			}

			try {
				const result = await this.runSingleCommand(commands[i], options)
				results.push(result)
				if (result.exitCode !== 0 || result.error) {
					encounteredFailure = true
				}
			} catch (error) {
				results.push(this.buildErrorResult(commands[i], options, error))
				encounteredFailure = true
			}
		}

		return results
	}

	// ========================================================================
	// Private: Single Command Execution
	// ========================================================================

	/**
	 * Run a single command via execa subprocess and produce a CommandResult.
	 *
	 * @param command - The command to run
	 * @param options - Runtime options
	 * @returns Structured command result
	 */
	private async runSingleCommand(command: ParallelCommand, options?: ExecOptions): Promise<CommandResult> {
		const startTime = Date.now()
		const cwd = resolveCwd(command.cwd, options?.cwd)
		const timeoutMs = command.timeout ?? options?.timeout
		const commandStr = command.command

		if (!commandStr || commandStr.trim().length === 0) {
			return this.buildErrorResult(command, options, new Error("Command string is empty"))
		}

		let stdout = ""
		let stderr = ""
		let rawOutput = ""
		let exitCode: number | undefined
		let timedOut = false
		let execaError: ExecaError | undefined

		try {
			const subprocess = execa({
				shell: true,
				cwd,
				all: true,
				stdin: "ignore",
				timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
				killSignal: "SIGTERM",
				env: {
					...process.env,
					// Ensure UTF-8 encoding for tool output parsing
					LANG: "en_US.UTF-8",
					LC_ALL: "en_US.UTF-8",
				},
			})`${commandStr}`

			const result = await subprocess
			exitCode = result.exitCode ?? 0
			stdout = result.all ?? result.stdout ?? ""
			stderr = result.stderr ?? ""
			rawOutput = result.all ?? ""
		} catch (caughtError) {
			if (caughtError instanceof ExecaError) {
				execaError = caughtError
				exitCode = caughtError.exitCode ?? undefined
				stdout = caughtError.all ?? caughtError.stdout ?? ""
				stderr = caughtError.stderr ?? ""
				rawOutput = caughtError.all ?? ""
				timedOut = caughtError.timedOut ?? false

				if (caughtError.isTerminated) {
					// Process killed — could be timeout or external kill
				}
			} else {
				// Non-ExecaError (shouldn't happen with execa, but handle gracefully)
				const endTime = Date.now()
				return {
					command: commandStr,
					cwd,
					exitCode: undefined,
					duration: endTime - startTime,
					stdout: "",
					stderr: "",
					parsed: buildParsedResult(undefined, endTime - startTime, "", "", "Command execution failed"),
					rawOutput: "",
					truncated: false,
					error: caughtError instanceof Error ? caughtError.message : String(caughtError),
				}
			}
		}

		const endTime = Date.now()
		const duration = endTime - startTime

		// Bound output buffers
		if (stdout.length > MAX_OUTPUT_SIZE) {
			stdout = stdout.slice(-MAX_OUTPUT_SIZE)
		}
		if (stderr.length > MAX_OUTPUT_SIZE) {
			stderr = stderr.slice(-MAX_OUTPUT_SIZE)
		}
		if (rawOutput.length > MAX_OUTPUT_SIZE) {
			rawOutput = rawOutput.slice(-MAX_OUTPUT_SIZE)
		}

		const truncated = rawOutput.length > MAX_OUTPUT_SIZE
		const isSuccess = exitCode === 0 && !timedOut

		let summary: string
		let errorMsg: string | undefined

		if (timedOut) {
			summary = `Command timed out after ${timeoutMs}ms.`
			errorMsg = `Command timed out after ${timeoutMs}ms. Inspect the partial output and consider retrying with a longer timeout.`
		} else if (isSuccess) {
			summary = "Command completed successfully."
		} else {
			const signalInfo = execaError?.signal ? ` (signal: ${execaError.signal})` : ""
			summary = `Command failed with exit code ${exitCode ?? "undefined"}${signalInfo}.`
			if (exitCode !== 0) {
				errorMsg = `Command failed with exit code ${exitCode}${signalInfo}. Inspect the output for details.`
			}
		}

		return {
			command: commandStr,
			cwd,
			exitCode,
			duration,
			stdout,
			stderr,
			parsed: buildParsedResult(exitCode, duration, stdout, stderr, summary),
			rawOutput,
			truncated,
			error: errorMsg,
		}
	}

	/**
	 * Build an error result for a command that failed before/during execution.
	 */
	private buildErrorResult(command: ParallelCommand, options?: ExecOptions, error?: unknown): CommandResult {
		const cwd = resolveCwd(command.cwd, options?.cwd)
		const errMsg = error instanceof Error ? error.message : String(error ?? "Unknown error")

		return {
			command: command.command,
			cwd,
			exitCode: undefined,
			duration: 0,
			stdout: "",
			stderr: "",
			parsed: buildParsedResult(undefined, 0, "", "", `Command execution failed: ${errMsg}`, [
				{
					file: "",
					line: 0,
					severity: "error",
					message: errMsg,
					raw: errMsg,
				},
			]),
			rawOutput: "",
			truncated: false,
			error: errMsg,
		}
	}

	/**
	 * Build a "skipped" result for commands not executed due to prior failure
	 * in a sequential group with `continue_on_error: false`.
	 */
	private buildSkippedResult(command: ParallelCommand, options?: ExecOptions): CommandResult {
		const cwd = resolveCwd(command.cwd, options?.cwd)

		return {
			command: command.command,
			cwd,
			exitCode: undefined,
			duration: 0,
			stdout: "",
			stderr: "",
			parsed: buildParsedResult(
				undefined,
				0,
				"",
				"",
				"Command skipped due to prior failure in sequential group.",
			),
			rawOutput: "",
			truncated: false,
			error: "Skipped: prior command in sequential group failed",
		}
	}

	/**
	 * Build a GroupResult for a group that was entirely skipped due to deadlock.
	 */
	private buildSkippedGroupResult(group: ParallelCommandGroup): GroupResult {
		return {
			id: group.id,
			sequential: group.sequential,
			commands: group.commands.map((cmd) => this.buildSkippedResult(cmd, { cwd: cmd.cwd ?? undefined })),
			successCount: 0,
			failedCount: 0,
			skippedCount: group.commands.length,
			totalDuration: 0,
		}
	}

	// ========================================================================
	// Private: Dependency Resolution
	// ========================================================================

	/**
	 * Topological sort of groups based on `wait_for` dependencies.
	 * Uses Kahn's algorithm. Groups with no deps come first.
	 *
	 * @param groups - Groups to sort
	 * @returns Groups in topological order (dependencies before dependents)
	 */
	private topologicalSort(groups: ParallelCommandGroup[]): ParallelCommandGroup[] {
		const groupIds = new Set(groups.map((g) => g.id))
		const groupMap = new Map(groups.map((g) => [g.id, g]))

		// Validate wait_for references — remove references to unknown groups
		for (const group of groups) {
			if (group.wait_for) {
				group.wait_for = group.wait_for.filter((depId) => groupIds.has(depId))
			}
		}

		// Build in-degree map: number of dependencies each group has
		const inDegree = new Map<string, number>()
		const adjacency = new Map<string, string[]>() // groupId → groups that depend on it

		for (const g of groups) {
			inDegree.set(g.id, 0)
			adjacency.set(g.id, [])
		}

		for (const g of groups) {
			for (const depId of g.wait_for ?? []) {
				// g depends on depId → increment g's in-degree
				inDegree.set(g.id, (inDegree.get(g.id) ?? 0) + 1)
				// depId has g as a dependent
				const dependents = adjacency.get(depId) ?? []
				dependents.push(g.id)
				adjacency.set(depId, dependents)
			}
		}

		// Kahn's algorithm
		const queue: string[] = []
		for (const [id, degree] of inDegree) {
			if (degree === 0) {
				queue.push(id)
			}
		}

		const sorted: ParallelCommandGroup[] = []
		while (queue.length > 0) {
			const id = queue.shift()!
			const group = groupMap.get(id)
			if (group) {
				sorted.push(group)
			}

			for (const dependentId of adjacency.get(id) ?? []) {
				const newDegree = (inDegree.get(dependentId) ?? 1) - 1
				inDegree.set(dependentId, newDegree)
				if (newDegree === 0) {
					queue.push(dependentId)
				}
			}
		}

		// If not all groups were sorted, there's a cycle — append remaining in arbitrary order
		const sortedIds = new Set(sorted.map((g) => g.id))
		for (const g of groups) {
			if (!sortedIds.has(g.id)) {
				sorted.push(g)
			}
		}

		return sorted
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Resolve the working directory for a command.
 * Priority: command-level cwd → options-level cwd → process.cwd()
 */
function resolveCwd(commandCwd?: string | null, optionsCwd?: string): string {
	if (commandCwd) {
		return path.resolve(commandCwd)
	}
	if (optionsCwd) {
		return path.resolve(optionsCwd)
	}
	return process.cwd()
}

/**
 * Create an empty AggregatedResult (for no-commands or error edge cases).
 */
function emptyAggregatedResult(): AggregatedResult {
	return {
		groups: [],
		totalDuration: 0,
		successCount: 0,
		failedCount: 0,
		skippedCount: 0,
	}
}

/**
 * Build a ParsedResult from command output.
 *
 * @param exitCode - Process exit code
 * @param duration - Execution duration in ms
 * @param stdout - Captured stdout
 * @param stderr - Captured stderr
 * @param summary - Human-readable summary
 * @param errors - Optional parsed errors
 * @returns A ParsedResult with empty warnings/genericMessages if not provided
 */
function buildParsedResult(
	exitCode: number | undefined,
	duration: number,
	stdout: string,
	stderr: string,
	summary: string,
	errors?: ParsedError[],
): ParsedResult {
	return {
		exitCode,
		duration,
		stdout,
		stderr,
		errors: errors ?? [],
		warnings: [],
		genericMessages: [],
		summary,
		rawOutput: stdout + stderr,
		truncated: stdout.length > MAX_OUTPUT_SIZE || stderr.length > MAX_OUTPUT_SIZE,
	}
}
