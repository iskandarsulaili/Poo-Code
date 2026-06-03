/**
 * Tool Loop Guardrails — Module Entry Point
 *
 * Exports all types, classes, and utilities for F6: Tool Loop Guardrails.
 */

export { DeathSpiralDetector } from "./DeathSpiralDetector"
export { CircuitBreaker } from "./CircuitBreaker"
export {
	DetectionType,
	GuardrailError,
	type DetectionEvent,
	type DetectionResult,
	type DetectionSeverity,
	type DetectionTypeConfig,
	type GuardrailConfig,
	type CircuitBreakerState,
	type CircuitBreakerStateValue,
	type AllowanceResult,
	type IncidentRecord,
	type GuardrailErrorCode,
} from "./types"
