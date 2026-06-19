/**
 * Type definitions for the Parallel Subtask Execution System.
 *
 * Defines all TypeScript interfaces for the DAG-based parallel subtask execution
 * system, including subtask nodes, lock management, blackboard communication,
 * context routing, and observability.
 *
 * @module
 */

import { z } from "zod"

// ============================================================================
// Subtask Node & Status
// ============================================================================

/**
 * Status of a single subtask in the execution DAG.
 */
export const SubtaskStatusSchema = z.enum([
	"pending",
	"ready",
	"running",
	"completed",
	"failed",
	"blocked",
	"skipped",
	"timed_out",
])

export type SubtaskStatus = z.infer<typeof SubtaskStatusSchema>

/**
 * Runtime metadata attached to a subtask during execution.
 */
export interface SubtaskMetadata {
	/** Timestamp when the subtask started execution (Unix ms) */
	startedAt?: number
	/** Timestamp when the subtask completed (Unix ms) */
	completedAt?: number
	/** Exit code from the subagent process */
	exitCode?: number
	/** Error message if the subtask failed */
	error?: string
	/** Correlation ID for the entire task run */
	correlationId: string
	/** Path to this subtask's heartbeat file under .roosync/heartbeats/ */
	heartbeatPath?: string
	/** Interval in ms between heartbeat file touches (default: 5000) */
	heartbeatIntervalMs?: number
	/** Result summary from the child agent's attempt_completion */
	result?: string
}

/**
 * A single node in the subtask DAG.
 */
export interface SubtaskNode {
	id: string
	name: string
	/** The mode slug to execute this subtask in */
	mode: string
	/** The prompt/instructions for this subtask */
	prompt: string
	/** Source tool: "execute_parallel_subtask" or "execute_parallel_child_task" */
	source?: "execute_parallel_subtask" | "execute_parallel_child_task"
	/** Files this subtask is expected to read (for context injection) */
	inputFiles: string[]
	/** Files this subtask is expected to write (for lock acquisition) */
	outputFiles: string[]
	/** IDs of subtasks that must complete before this one starts */
	deps: string[]
	/** Resources this subtask needs (e.g., "db-schema", "api-spec") */
	requiredResources: string[]
	/** Topics this subtask subscribes to on .roosync */
	subscribedTopics: string[]
	/** Topics this subtask publishes to on .roosync */
	publishedTopics: string[]
	/** Estimated token budget for this subtask */
	estimatedTokens: number
	/** Maximum wall-clock time before timeout (ms) */
	timeoutMs: number
	/** Whether to continue downstream if this subtask fails */
	isCritical: boolean
	/** Current status */
	status: SubtaskStatus
	/** Runtime metadata */
	metadata: SubtaskMetadata
}

// ============================================================================
// Subtask DAG
// ============================================================================

/**
 * A directed acyclic graph of subtasks with topological wave ordering.
 */
export interface SubtaskDAG {
	/** All nodes in the graph, keyed by node ID */
	nodes: Map<string, SubtaskNode>
	/** Dependency edges: nodeId → Set of dependency nodeIds */
	edges: Map<string, Set<string>>
	/** Topologically sorted layers (waves) for parallel execution */
	waves: SubtaskNode[][]
	/** Current overall status of the DAG execution */
	status: "pending" | "running" | "completed" | "failed" | "aborted"
}

// ============================================================================
// Lock Types
// ============================================================================

/**
 * Granularity level for lock acquisition.
 */
export const LockLevelSchema = z.enum(["file", "module", "resource", "roosync"])

export type LockLevel = z.infer<typeof LockLevelSchema>

/**
 * Lock mode — read (shared) or write (exclusive).
 */
export const LockTypeSchema = z.enum(["read", "write"])

export type LockType = z.infer<typeof LockTypeSchema>

/**
 * Request to acquire a lock on a target resource.
 */
export interface LockRequest {
	/** Lock granularity level */
	level: LockLevel
	/** Path to the file, module directory, or resource name */
	target: string
	/** Read (shared) or Write (exclusive) */
	type: LockType
	/** Subtask requesting the lock */
	subtaskId: string
	/** Maximum time to wait for lock acquisition (ms) */
	timeoutMs: number
}

/**
 * Granted lock handle returned on successful acquisition.
 */
export interface LockGrant {
	/** Unique lock identifier */
	lockId: string
	/** Lock granularity level */
	level: LockLevel
	/** Locked target */
	target: string
	/** Lock mode */
	type: LockType
	/** Subtask holding the lock */
	subtaskId: string
	/** Timestamp when the lock was acquired (Unix ms) */
	acquiredAt: number
	/** Timestamp when the lock expires (Unix ms) */
	expiresAt: number
}

// ============================================================================
// Blackboard Types
// ============================================================================

/**
 * A named topic on the blackboard that subtasks can publish/subscribe to.
 */
export interface BlackboardTopic {
	/** Topic name (kebab-case) */
	name: string
	/** Current version number (monotonically increasing) */
	version: number
	/** JSON Schema for the topic data (optional) */
	schema?: Record<string, unknown>
	/** Subtask IDs subscribed to this topic */
	subscribers: string[]
}

/**
 * A single entry on the blackboard for a given topic.
 */
export interface BlackboardEntry {
	/** Topic name */
	topic: string
	/** Topic data */
	data: unknown
	/** Version number */
	version: number
	/** ISO 8601 timestamp of last update */
	timestamp: string
	/** Subtask ID that published this entry */
	subtaskId: string
}

/**
 * Strategy for resolving conflicting writes to the same topic.
 */
export const ConflictStrategySchema = z.enum(["last-writer-wins", "merge", "supervisor"])

export type ConflictStrategy = z.infer<typeof ConflictStrategySchema>

/**
 * Record of a conflict detected on a blackboard topic.
 */
export interface ConflictRecord {
	/** Topic where the conflict occurred */
	topic: string
	/** Version that was read (stale base) */
	versionA: number
	/** Version that was written concurrently */
	versionB: number
	/** Subtask that attempted the stale write */
	subtaskIdA: string
	/** Subtask that wrote the winning version */
	subtaskIdB: string
	/** Conflict resolution strategy applied */
	strategy: ConflictStrategy
	/** Whether the conflict has been resolved */
	resolved: boolean
}

// ============================================================================
// Context Types
// ============================================================================

/**
 * Per-subtask context assembled by the ContextRouter.
 */
export interface SubtaskContext {
	/** The subtask's own prompt */
	prompt: string
	/** Mode definition for this subtask's agent */
	modeDefinition: {
		roleDefinition: string
		customInstructions?: string
		groups: string[]
	}
	/** File contents this subtask needs (from inputFiles) */
	fileContext: Array<{
		path: string
		content: string
		format: "full" | "diff" | "summary"
	}>
	/** Blackboard topics this subtask subscribes to */
	blackboardContext: Array<{
		topic: string
		data: unknown
		version: number
	}>
	/** Global alignment data */
	globalAlignment: {
		architectureDecisions: string[]
		namingConventions: string[]
		sharedTypes: string[]
	}
	/** Token budget for this subtask's response */
	tokenBudget: number
}

/**
 * Diff between two SubtaskContext instances.
 */
export interface ContextDiff {
	/** Files added in the new context */
	added: string[]
	/** Files removed from the old context */
	removed: string[]
	/** Files modified between old and new context */
	modified: string[]
	/** Files unchanged between old and new context */
	unchanged: string[]
}

// ============================================================================
// Logging Types
// ============================================================================

/**
 * A single structured log entry.
 */
export interface LogEntry {
	/** Correlation ID for the entire task run */
	correlationId: string
	/** Subtask ID (empty for orchestrator-level events) */
	subtaskId: string
	/** Component emitting the log */
	component:
		| "orchestrator"
		| "dag-builder"
		| "lock-manager"
		| "blackboard"
		| "context-router"
		| "subtask-agent"
		| "supervisor"
	/** Log level */
	level: "debug" | "info" | "warn" | "error"
	/** Structured message */
	message: string
	/** ISO 8601 timestamp */
	timestamp: string
	/** Optional duration in ms (for performance tracking) */
	durationMs?: number
	/** Optional structured metadata */
	metadata?: Record<string, unknown>
}

/**
 * Filter criteria for querying log entries.
 */
export interface LogFilter {
	correlationId?: string
	subtaskId?: string
	level?: LogEntry["level"]
	component?: LogEntry["component"]
	startTime?: string
	endTime?: string
	limit?: number
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the Parallel Subtask Execution System.
 */
export interface ParallelSubtaskConfig {
	/** Master enable/disable flag */
	enabled: boolean
	/** Maximum number of subtasks to execute in parallel */
	maxParallel: number
	/** Default timeout per subtask (ms) */
	defaultTimeoutMs: number
	/** Heartbeat interval for subtask liveness (ms) */
	heartbeatIntervalMs: number
	/** Lock acquisition timeout (ms) */
	lockTimeoutMs: number
	/** Default token budget per subtask */
	defaultTokenBudget: number
	/** Context allocation strategy */
	contextStrategy: "equal" | "weighted" | "dynamic"
	/** Log level for the system */
	logLevel: "debug" | "info" | "warn" | "error"
}

// ============================================================================
// Orchestrator Interface
// ============================================================================

/**
 * Result of publishing to a blackboard topic.
 */
export type PublishResult =
	| { status: "accepted"; version: number }
	| { status: "conflict"; resolution: "merged" | "rejected" | "escalated"; newVersion: number }
	| { status: "error"; reason: string }

/**
 * Result of a single subtask execution.
 */
export interface SubtaskExecutionResult {
	id: string
	status: SubtaskStatus
	durationMs: number
	error?: string
}

/**
 * Overall execution result from the orchestrator.
 */
export interface ExecutionResult {
	correlationId: string
	status: "completed" | "partial" | "failed" | "aborted"
	subtaskResults: SubtaskExecutionResult[]
	totalDurationMs: number
	tokenUsage: {
		total: number
		perSubtask: Map<string, number>
	}
}

/**
 * Input for a parallel subtask execution run.
 */
export interface TaskInput {
	/** High-level task prompt */
	prompt: string
	/** Optional files to include in context */
	files?: string[]
	/** Optional mode override */
	mode?: string
	/** Optional token budget for the entire run */
	tokenBudget?: number
	/** Maximum parallel subtasks */
	maxParallel?: number
	/** Whether supervisor agent is enabled */
	supervisorEnabled?: boolean
}

/**
 * Full interface for the Parallel Subtask Orchestrator.
 */
export interface IParallelSubtaskOrchestrator {
	/** Execute a set of subtasks */
	execute(tasks: SubtaskNode[]): Promise<SubtaskDAG>
	/** Cancel a specific subtask or all subtasks */
	cancel(subtaskId?: string): void
	/** Get current DAG status */
	getStatus(): SubtaskDAG
	/** Get full DAG */
	getDAG(): SubtaskDAG
	/** Get logs with optional filter */
	getLogs(filter?: LogFilter): LogEntry[]
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

/**
 * Zod schema for SubtaskNode validation.
 */
export const SubtaskNodeSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	mode: z.string().min(1),
	prompt: z.string().min(1),
	inputFiles: z.array(z.string()).default([]),
	outputFiles: z.array(z.string()).default([]),
	deps: z.array(z.string()).default([]),
	requiredResources: z.array(z.string()).default([]),
	subscribedTopics: z.array(z.string()).default([]),
	publishedTopics: z.array(z.string()).default([]),
	estimatedTokens: z.number().int().min(0).default(0),
	timeoutMs: z.number().int().min(0).default(300_000),
	isCritical: z.boolean().default(false),
	status: SubtaskStatusSchema.default("pending"),
	metadata: z
		.object({
			startedAt: z.number().optional(),
			completedAt: z.number().optional(),
			exitCode: z.number().optional(),
			error: z.string().optional(),
			correlationId: z.string().default(""),
			heartbeatPath: z.string().optional(),
			heartbeatIntervalMs: z.number().optional(),
		})
		.default({}),
})

/**
 * Zod schema for LockRequest validation.
 */
export const LockRequestSchema = z.object({
	level: LockLevelSchema,
	target: z.string().min(1),
	type: LockTypeSchema,
	subtaskId: z.string().min(1),
	timeoutMs: z.number().int().min(0).default(30_000),
})

/**
 * Zod schema for LogEntry validation.
 */
export const LogEntrySchema = z.object({
	correlationId: z.string(),
	subtaskId: z.string(),
	component: z.enum([
		"orchestrator",
		"dag-builder",
		"lock-manager",
		"blackboard",
		"context-router",
		"subtask-agent",
		"supervisor",
	]),
	level: z.enum(["debug", "info", "warn", "error"]),
	message: z.string(),
	timestamp: z.string(),
	durationMs: z.number().optional(),
	metadata: z.record(z.unknown()).optional(),
})

/**
 * Zod schema for ParallelSubtaskConfig validation.
 */
export const ParallelSubtaskConfigSchema = z.object({
	enabled: z.boolean().default(true),
	maxParallel: z.number().int().min(1).default(4),
	defaultTimeoutMs: z.number().int().min(1000).default(300_000),
	heartbeatIntervalMs: z.number().int().min(1000).default(5_000),
	lockTimeoutMs: z.number().int().min(1000).default(30_000),
	defaultTokenBudget: z.number().int().min(0).default(8_000),
	contextStrategy: z.enum(["equal", "weighted", "dynamic"]).default("equal"),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
})
