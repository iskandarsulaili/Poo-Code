import crypto from "crypto"

// ─── Error Classes ──────────────────────────────────────────────────────────

/**
 * Base error for subagent-related failures.
 */
export class SubagentError extends Error {
	readonly code: string
	override readonly cause?: unknown

	constructor(message: string, code: string, cause?: unknown) {
		super(message)
		this.name = "SubagentError"
		this.code = code
		this.cause = cause
	}
}

/**
 * Error thrown when the pool is exhausted and all slots are busy.
 */
export class PoolExhaustedError extends SubagentError {
	constructor(maxSize: number) {
		super(`All ${maxSize} pool slots are busy and queue limit reached`, "POOL_EXHAUSTED")
		this.name = "PoolExhaustedError"
	}
}

/**
 * Error thrown when a subagent times out.
 */
export class SubagentTimeoutError extends SubagentError {
	constructor(subagentId: string, timeoutMs: number) {
		super(`Subagent ${subagentId} timed out after ${timeoutMs}ms`, "TIMEOUT")
		this.name = "SubagentTimeoutError"
	}
}

/**
 * Error thrown when context creation or destruction fails.
 */
export class ContextError extends SubagentError {
	constructor(message: string, cause?: unknown) {
		super(message, "CONTEXT_ERROR", cause)
		this.name = "ContextError"
	}
}

// ─── Core Types ─────────────────────────────────────────────────────────────

/**
 * Status lifecycle for a single subagent.
 * - `pending`: queued, not yet started
 * - `running`: currently executing
 * - `completed`: finished successfully
 * - `failed`: finished with an error
 * - `cancelled`: explicitly cancelled before completion
 * - `timed_out`: exceeded its time budget
 */
export type SubagentStatusValue = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out"

/**
 * Role assigned to a subagent controlling recursive delegation capability.
 * - `leaf`: cannot spawn further subagents (prevents runaway recursion)
 * - `orchestrator`: can spawn sub-subagents up to `maxSpawnDepth`
 */
export type SubagentRole = "leaf" | "orchestrator"

/**
 * Configuration for spawning a single subagent.
 */
export interface SubagentConfig {
	/** Unique ID generated at spawn time */
	subagentId: string

	/** Role restricting recursive delegation ability */
	role: SubagentRole

	/** The task prompt / goal for this subagent */
	taskPrompt: string

	/** Working directory (defaults to workspace root) */
	workdir?: string

	/** Tool names the subagent is allowed to use; empty = all available */
	allowedTools?: string[]

	/** Environment variables to inject */
	envVars?: Record<string, string>

	/** Max tokens for the subagent's response */
	maxTokens?: number

	/** Timeout in milliseconds (default: 300000 = 5 min) */
	timeoutMs?: number

	/** Maximum spawn depth for orchestrator role (default: 1) */
	maxSpawnDepth?: number

	/** Context snapshot to clone into subagent */
	contextSnapshot?: ContextSnapshot
}

/**
 * Context snapshot captured from the parent task for propagation.
 */
export interface ContextSnapshot {
	cwd: string
	conversationHistory: unknown[]
	toolResults: unknown[]
}

/**
 * Result returned by a completed subagent.
 */
export interface SubagentResult {
	subagentId: string
	success: boolean
	output: string
	filesModified: string[]
	fileChanges: FileChange[]
	errors?: string[]
	executionTimeMs: number
}

/**
 * Live status snapshot of a subagent.
 */
export interface SubagentStatus {
	subagentId: string
	status: SubagentStatusValue
	progress: number // 0–100
	startedAt: number
	completedAt?: number
	error?: string
}

/**
 * Optional configuration for subagent behaviour.
 */
export interface SubagentOptions {
	maxRetries?: number
	timeout?: number
	contextWindowSize?: number
}

/**
 * Aggregated result from merging multiple subagent results.
 */
export interface AggregatedResult {
	success: boolean
	mergedOutput: string
	conflicts?: ConflictReport[]
	warnings?: string[]
	executionSummary: ExecutionSummary
}

/**
 * A conflict detected during result aggregation.
 */
export interface ConflictReport {
	type: "file" | "dependency" | "output"
	description: string
	/** Cards/subagents involved in the conflict */
	involvedIds: string[]
	/** How the conflict was resolved */
	resolution: ConflictResolution
}

/**
 * Resolution strategy applied to a conflict.
 */
export type ConflictResolution =
	| { strategy: "last_writer_wins"; winnerId: string }
	| { strategy: "merge_with_markers" }
	| { strategy: "manual_review_required" }
	| { strategy: "skipped"; reason: string }

/**
 * Execution summary across all subagents.
 */
export interface ExecutionSummary {
	totalSubagents: number
	succeeded: number
	failed: number
	timedOut: number
	cancelled: number
	totalExecutionTimeMs: number
}

/**
 * File change recorded by a subagent.
 */
export interface FileChange {
	filePath: string
	action: "created" | "modified" | "deleted"
	contentBefore?: string
	contentAfter?: string
}

// ─── Internal State ─────────────────────────────────────────────────────────

/**
 * Internal tracking entry for an active subagent.
 */
export interface SubagentEntry {
	config: SubagentConfig
	status: SubagentStatusValue
	progress: number
	startedAt: number
	completedAt?: number
	result?: SubagentResult
	error?: string
	abortController?: AbortController
}

/**
 * Pool slot representing a reserved execution capacity.
 */
export interface PoolSlot {
	id: string
	slotIndex: number
	acquiredAt: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a unique subagent ID.
 */
export function generateSubagentId(): string {
	return `subagent-${crypto.randomUUID()}`
}

/**
 * Default subagent options.
 */
export const DEFAULT_SUBAGENT_OPTIONS: Required<SubagentOptions> = {
	maxRetries: 0,
	timeout: 300_000,
	contextWindowSize: 128_000,
}

/**
 * Default tools blocked for leaf subagents.
 */
export const LEAF_BLOCKED_TOOLS: readonly string[] = ["delegate_task", "new_task", "memory", "skill_manage"]

/**
 * Default pool size.
 */
export const DEFAULT_POOL_SIZE = 3
