/**
 * Circuit Breaker
 *
 * Implements a state machine for tool-call circuit breaking:
 * - CLOSED: normal operation, tracking failures
 * - HALF_OPEN: after warn threshold, allows with warnings
 * - OPEN: after hard-stop threshold, rejects all matching calls
 *
 * Timer-based auto-reset moves from OPEN → HALF_OPEN after cooldown.
 * In HALF_OPEN, a single probe is allowed; if it fails → back to OPEN,
 * if it succeeds → back to CLOSED.
 */

import {
	type AllowanceResult,
	type CircuitBreakerState,
	type CircuitBreakerStateValue,
	DetectionType,
	type DetectionEvent,
	type GuardrailConfig,
	type IncidentRecord,
	GuardrailError,
} from "./types"
import { DeathSpiralDetector } from "./DeathSpiralDetector"

/**
 * Default configuration values.
 */
const DEFAULTS = {
	resetTimeoutMs: 30_000,
	maxIncidents: 100,
}

/**
 * Circuit breaker implementation with full state machine.
 *
 * Usage:
 * ```ts
 * const breaker = new CircuitBreaker()
 * const { allowed, reason } = breaker.isAllowed("write_to_file", "/path/to/file.ts")
 * if (!allowed) throw new GuardrailError(reason!, ...)
 * // ... execute tool ...
 * breaker.recordCall("write_to_file", "/path/to/file.ts", true)
 * ```
 */
export class CircuitBreaker {
	private state: CircuitBreakerState = {
		state: "CLOSED",
		openedAt: null,
		resetTimer: null,
	}

	private readonly config: Required<Pick<GuardrailConfig, "resetTimeoutMs">> & Pick<GuardrailConfig, "log">
	private readonly detector: DeathSpiralDetector
	private readonly incidents: IncidentRecord[] = []
	private readonly failureCounts: Map<string, number> = new Map()
	private readonly maxIncidents: number

	/**
	 * Create a new CircuitBreaker with an optional guardrail configuration.
	 *
	 * @param config - Guardrail configuration (uses defaults for missing values).
	 * @param detector - Optional DeathSpiralDetector instance; creates one if not provided.
	 */
	constructor(config?: GuardrailConfig, detector?: DeathSpiralDetector) {
		this.config = {
			resetTimeoutMs: config?.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs,
			log: config?.log,
		}
		this.maxIncidents = DEFAULTS.maxIncidents
		this.detector = detector ?? new DeathSpiralDetector(config)
	}

	/**
	 * Get the current circuit breaker state.
	 */
	public getState(): CircuitBreakerState {
		return { ...this.state }
	}

	/**
	 * Get the underlying death spiral detector.
	 */
	public getDetector(): DeathSpiralDetector {
		return this.detector
	}

	/**
	 * Log a message if a logger is configured.
	 */
	private log(message: string): void {
		if (this.config.log) {
			this.config.log(`[CircuitBreaker] ${message}`)
		}
	}

	/**
	 * Build a composite key for failure tracking.
	 */
	private buildKey(toolName: string, filePath: string): string {
		return `${toolName}::${filePath}`
	}

	/**
	 * Record a tool call result and update internal state.
	 *
	 * @param toolName - Name of the tool that was called.
	 * @param filePath - File path the tool operated on.
	 * @param success - Whether the tool call succeeded.
	 */
	public recordCall(toolName: string, filePath: string, success: boolean): void {
		const key = this.buildKey(toolName, filePath)

		if (success) {
			// On success, reduce failure count (cannot go below 0)
			const current = this.failureCounts.get(key) ?? 0
			if (current > 0) {
				this.failureCounts.set(key, current - 1)
			}

			// If in HALF_OPEN and a probe succeeds, transition to CLOSED
			if (this.state.state === "HALF_OPEN") {
				this.transitionTo("CLOSED")
				this.log(`Probe succeeded for "${toolName}" on "${filePath}" — circuit CLOSED`)
			}
		} else {
			// On failure, increment failure count
			this.failureCounts.set(key, (this.failureCounts.get(key) ?? 0) + 1)
		}
	}

	/**
	 * Check if a tool call is allowed to proceed.
	 *
	 * @param toolName - Name of the tool being called.
	 * @param filePath - File path the tool will operate on.
	 * @returns An AllowanceResult with { allowed, reason }.
	 */
	public isAllowed(toolName: string, filePath: string): AllowanceResult {
		const key = this.buildKey(toolName, filePath)

		// OPEN state: block all matching calls
		if (this.state.state === "OPEN") {
			const reason =
				`Circuit is OPEN for "${toolName}" on "${filePath}". ` +
				`Auto-reset in ${this.config.resetTimeoutMs}ms. ` +
				`Opened at: ${this.state.openedAt}`
			return { allowed: false, reason }
		}

		// HALF_OPEN state: allow only if the failure count is not extreme
		if (this.state.state === "HALF_OPEN") {
			const failureCount = this.failureCounts.get(key) ?? 0
			if (failureCount > 0) {
				return {
					allowed: true,
					reason: `Circuit HALF_OPEN — "${toolName}" on "${filePath}" has ${failureCount} prior failures. Proceeding with caution.`,
				}
			}
		}

		// CLOSED state: normal operation
		return { allowed: true }
	}

	/**
	 * Process a detection event through the death spiral detector and
	 * update circuit breaker state based on the result.
	 *
	 * @param event - The detection event to check.
	 * @throws GuardrailError if the event triggers a hard stop / OPEN state.
	 */
	public processEvent(event: DetectionEvent): void {
		const result = this.detector.check(event)

		if (!result) {
			return
		}

		// Record the incident
		this.recordIncident({
			type: result.pattern,
			severity: result.severity,
			toolName: event.toolName,
			filePath: event.filePath,
			message: result.message,
			consecutiveCount: result.consecutiveCount,
			timestamp: Date.now(),
		})

		if (result.severity === "block") {
			// Block severity — transition to OPEN
			this.trip(result.pattern, event.toolName, event.filePath, result.message)

			this.log(`GuardrailError thrown: ${result.pattern} on "${event.toolName}" / "${event.filePath}"`)
			throw new GuardrailError(
				result.message,
				this.patternToErrorCode(result.pattern),
				event.toolName,
				event.filePath,
			)
		}

		// Warn severity — transition to HALF_OPEN if not already open
		if (this.state.state === "CLOSED") {
			this.transitionTo("HALF_OPEN")
			this.log(`Circuit HALF_OPEN due to warn: ${result.pattern} on "${event.toolName}"`)
		}
	}

	/**
	 * Trip the circuit breaker — transition from any state to OPEN.
	 */
	private trip(pattern: DetectionType, toolName: string, filePath: string, message: string): void {
		const previousState = this.state.state
		this.transitionTo("OPEN")

		this.log(
			`Circuit tripped OPEN: ${pattern} on "${toolName}/${filePath}" — ${message} ` +
				`(was ${previousState}, reset in ${this.config.resetTimeoutMs}ms)`,
		)

		// Schedule auto-reset timer
		if (this.state.resetTimer) {
			clearTimeout(this.state.resetTimer)
		}

		this.state.resetTimer = setTimeout(() => {
			this.transitionTo("HALF_OPEN")
			this.log(`Auto-reset timer expired — circuit HALF_OPEN for probe`)
		}, this.config.resetTimeoutMs)
	}

	/**
	 * Transition the internal state to a new value and update metadata.
	 */
	private transitionTo(newState: CircuitBreakerStateValue): void {
		if (newState === "OPEN") {
			this.state.state = "OPEN"
			this.state.openedAt = Date.now()
		} else if (newState === "HALF_OPEN") {
			this.state.state = "HALF_OPEN"
			this.state.resetTimer = null
		} else {
			// CLOSED
			this.state.state = "CLOSED"
			this.state.openedAt = null
			this.state.resetTimer = null
		}
	}

	/**
	 * Map a DetectionType to a GuardrailErrorCode.
	 */
	private patternToErrorCode(pattern: DetectionType): GuardrailError["code"] {
		switch (pattern) {
			case DetectionType.EXACT_REPEAT:
				return "EXACT_REPEAT_LIMIT"
			case DetectionType.SAME_TOOL_FAILURE:
				return "TOOL_FAILURE_LIMIT"
			case DetectionType.IDEMPOTENT_NO_PROGRESS:
				return "IDEMPOTENT_LIMIT"
		}
	}

	/**
	 * Record an incident and trim the list if it exceeds the maximum.
	 */
	private recordIncident(incident: IncidentRecord): void {
		this.incidents.push(incident)
		if (this.incidents.length > this.maxIncidents) {
			this.incidents.shift()
		}
	}

	/**
	 * Get all recorded incidents.
	 */
	public getIncidents(): readonly IncidentRecord[] {
		return [...this.incidents]
	}

	/**
	 * Get the failure count for a specific tool/file combination.
	 */
	public getFailureCount(toolName: string, filePath: string): number {
		return this.failureCounts.get(this.buildKey(toolName, filePath)) ?? 0
	}

	/**
	 * Reset the circuit breaker to CLOSED state and clear all state.
	 */
	public reset(): void {
		if (this.state.resetTimer) {
			clearTimeout(this.state.resetTimer)
		}
		this.transitionTo("CLOSED")
		this.failureCounts.clear()
		this.incidents.length = 0
		this.detector.reset()
		this.log("Circuit breaker fully reset to CLOSED")
	}

	/**
	 * Force the circuit breaker into a specific state (useful for testing).
	 *
	 * @param newState - The state to force.
	 */
	public forceState(newState: CircuitBreakerStateValue): void {
		if (this.state.resetTimer) {
			clearTimeout(this.state.resetTimer)
		}
		this.transitionTo(newState)
		this.log(`Circuit breaker force-transitioned to ${newState}`)
	}

	/**
	 * Check for idempotent no-progress cycles on a file.
	 * Convenience wrapper that delegates to the detector.
	 *
	 * @param filePath - Path to the file being edited.
	 * @param currentContent - Current content after edit.
	 * @param previousContent - Previous content before edit.
	 */
	public checkIdempotentNoProgress(filePath: string, currentContent: string, previousContent?: string): void {
		const result = this.detector.checkIdempotentNoProgress(filePath, currentContent, previousContent)

		if (!result) {
			return
		}

		// Record the incident
		this.recordIncident({
			type: result.pattern,
			severity: result.severity,
			toolName: "edit",
			filePath,
			message: result.message,
			consecutiveCount: result.consecutiveCount,
			timestamp: Date.now(),
		})

		if (result.severity === "block") {
			this.trip(result.pattern, "edit", filePath, result.message)
			throw new GuardrailError(result.message, "IDEMPOTENT_LIMIT", "edit", filePath)
		}
	}
}
