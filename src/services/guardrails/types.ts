/**
 * Tool Loop Guardrails — Type Definitions
 *
 * Defines all types for F6: Tool Loop Guardrails feature.
 * Detects agent death spirals and triggers circuit breakers.
 */

/**
 * Detection patterns for death spiral analysis.
 */
export enum DetectionType {
	/** Same SHA-256 hash of (toolName + filePath + errorMessage) repeated */
	EXACT_REPEAT = "exact_repeat",
	/** Same tool failing consecutively on the same file */
	SAME_TOOL_FAILURE = "same_tool_failure",
	/** File unchanged after consecutive edit attempts */
	IDEMPOTENT_NO_PROGRESS = "idempotent_no_progress",
}

/**
 * Severity level of a detection result.
 */
export type DetectionSeverity = "warn" | "block"

/**
 * Result from a death spiral detection check.
 */
export interface DetectionResult {
	/** The pattern type that was detected */
	pattern: DetectionType
	/** Severity level — warn or block */
	severity: DetectionSeverity
	/** Human-readable message describing the detection */
	message: string
	/** Number of consecutive occurrences */
	consecutiveCount: number
}

/**
 * Configuration for each detection type within the guardrail system.
 */
export interface DetectionTypeConfig {
	/** Number of occurrences before emitting a warning */
	warnAfter: number
	/** Number of occurrences before blocking (hard stop) */
	hardStopAfter: number
}

/**
 * Configuration for the guardrail system.
 */
export interface GuardrailConfig {
	/** Per-type thresholds */
	detectionThresholds?: Partial<Record<DetectionType, DetectionTypeConfig>>
	/** Auto-reset timeout in milliseconds after OPEN state (default: 30000) */
	resetTimeoutMs?: number
	/** Sliding time window in ms for same-tool failure tracking (default: 60000) */
	failureWindowMs?: number
	/** Logger function */
	log?: (message: string) => void
}

/**
 * A detection event captured during tool execution.
 */
export interface DetectionEvent {
	/** Name of the tool that was called */
	toolName: string
	/** File path the tool operated on */
	filePath: string
	/** SHA-256 hash of (toolName + filePath + errorMessage) */
	sha256: string
	/** Timestamp of the event (epoch ms) */
	timestamp: number
	/** Error message if the tool call failed */
	errorMessage?: string
	/** Current diagnosis cycle number */
	diagnosisCycle: number
}

/**
 * State of the circuit breaker state machine.
 */
export type CircuitBreakerStateValue = "CLOSED" | "HALF_OPEN" | "OPEN"

/**
 * Full state object for the circuit breaker.
 */
export interface CircuitBreakerState {
	/** Current state value */
	state: CircuitBreakerStateValue
	/** Timestamp when the circuit was opened (epoch ms) */
	openedAt: number | null
	/** Timer handle for auto-reset */
	resetTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Result of an isAllowed check on the circuit breaker.
 */
export interface AllowanceResult {
	/** Whether the call is allowed to proceed */
	allowed: boolean
	/** Reason if the call is not allowed */
	reason?: string
}

/**
 * A record of a detected incident.
 */
export interface IncidentRecord {
	/** Type of incident */
	type: DetectionType
	/** Severity level */
	severity: DetectionSeverity
	/** Tool name involved */
	toolName: string
	/** File path involved */
	filePath?: string
	/** Human-readable message */
	message: string
	/** Number of consecutive occurrences */
	consecutiveCount: number
	/** Timestamp of the incident (epoch ms) */
	timestamp: number
}

/**
 * Error class for guardrail violations.
 * Thrown when the circuit breaker blocks a tool call.
 */
export class GuardrailError extends Error {
	public readonly code: GuardrailErrorCode
	public readonly toolName: string
	public readonly filePath?: string

	constructor(message: string, code: GuardrailErrorCode, toolName: string, filePath?: string) {
		super(message)
		this.name = "GuardrailError"
		this.code = code
		this.toolName = toolName
		this.filePath = filePath
	}
}

/**
 * Error codes for guardrail violations.
 */
export type GuardrailErrorCode = "CIRCUIT_OPEN" | "EXACT_REPEAT_LIMIT" | "TOOL_FAILURE_LIMIT" | "IDEMPOTENT_LIMIT"
