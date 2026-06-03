/**
 * Death Spiral Detector
 *
 * Implements 3 detection patterns for agent tool-call loops:
 * 1. Exact Repeat Detection — SHA-256 hash of (toolName + filePath + errorMessage)
 * 2. Same-Tool Failure Cascade — consecutive failures on same file in time window
 * 3. Idempotent No-Progress — file unchanged after consecutive edit attempts
 *
 * Each pattern tracks occurrence counts and returns warn/block severity
 * based on configured thresholds.
 */

import { createHash } from "node:crypto"
import { DetectionType, type DetectionEvent, type DetectionResult, type GuardrailConfig } from "./types"

/**
 * Default per-type thresholds used when not overridden in config.
 */
const DEFAULT_THRESHOLDS: Record<DetectionType, { warnAfter: number; hardStopAfter: number }> = {
	[DetectionType.EXACT_REPEAT]: { warnAfter: 2, hardStopAfter: 3 },
	[DetectionType.SAME_TOOL_FAILURE]: { warnAfter: 3, hardStopAfter: 5 },
	[DetectionType.IDEMPOTENT_NO_PROGRESS]: { warnAfter: 3, hardStopAfter: 4 },
}

/**
 * Internal tracker entry for exact-repeat detection.
 */
interface ExactRepeatEntry {
	hash: string
	timestamps: number[]
}

/**
 * Internal tracker entry for same-tool failure cascade.
 */
interface ToolFailureEntry {
	toolName: string
	filePath: string
	failures: number[]
}

/**
 * Internal tracker entry for idempotent no-progress detection.
 */
interface IdempotentEntry {
	filePath: string
	attempts: number
	lastContent: string | null
}

/**
 * Detects agent death spirals by analyzing tool call patterns.
 *
 * Three detection modes:
 * - **Exact Repeat**: SHA-256 of (toolName + filePath + errorMessage) seen N times
 * - **Same-Tool Failure**: Same tool failing on same file within sliding time window
 * - **Idempotent No-Progress**: Edit tool called on file but content unchanged
 */
export class DeathSpiralDetector {
	private readonly config: GuardrailConfig
	private readonly exactRepeatMap: Map<string, ExactRepeatEntry> = new Map()
	private readonly toolFailureMap: Map<string, ToolFailureEntry> = new Map()
	private readonly idempotentMap: Map<string, IdempotentEntry> = new Map()

	constructor(config: GuardrailConfig = {}) {
		this.config = config
	}

	/**
	 * Compute a SHA-256 hash of the detection key.
	 * Used for exact-repeat detection.
	 */
	private computeHash(toolName: string, filePath: string, errorMessage?: string): string {
		const data = `${toolName}||${filePath}||${errorMessage ?? ""}`
		return createHash("sha256").update(data, "utf-8").digest("hex")
	}

	/**
	 * Build a composite key for the same-tool failure map.
	 */
	private buildToolFailureKey(toolName: string, filePath: string): string {
		return `${toolName}::${filePath}`
	}

	/**
	 * Get the threshold configuration for a given detection type.
	 */
	private getThresholds(type: DetectionType): { warnAfter: number; hardStopAfter: number } {
		const custom = this.config.detectionThresholds?.[type]
		if (custom) {
			return {
				warnAfter: custom.warnAfter,
				hardStopAfter: custom.hardStopAfter,
			}
		}
		return DEFAULT_THRESHOLDS[type]
	}

	/**
	 * Get the sliding time window in milliseconds.
	 */
	private getFailureWindowMs(): number {
		return this.config.failureWindowMs ?? 60_000
	}

	/**
	 * Log a message if a logger is configured.
	 */
	private log(message: string): void {
		if (this.config.log) {
			this.config.log(`[DeathSpiralDetector] ${message}`)
		}
	}

	/**
	 * Check the event against all three detection patterns.
	 *
	 * @param event - The detection event captured from a tool call.
	 * @returns A DetectionResult if a pattern is matched, or null if no issue detected.
	 */
	public check(event: DetectionEvent): DetectionResult | null {
		const exactResult = this.checkExactRepeat(event)
		if (exactResult) {
			return exactResult
		}

		const cascadeResult = this.checkSameToolFailure(event)
		if (cascadeResult) {
			return cascadeResult
		}

		return null
	}

	/**
	 * Check for exact repeat pattern.
	 * Uses SHA-256 of (toolName + filePath + errorMessage) to detect duplicate failures.
	 */
	public checkExactRepeat(event: DetectionEvent): DetectionResult | null {
		if (!event.errorMessage) {
			return null
		}

		const hash = this.computeHash(event.toolName, event.filePath, event.errorMessage)
		const now = Date.now()
		const thresholds = this.getThresholds(DetectionType.EXACT_REPEAT)

		let entry = this.exactRepeatMap.get(hash)
		if (!entry) {
			entry = { hash, timestamps: [] }
			this.exactRepeatMap.set(hash, entry)
		}

		entry.timestamps.push(now)
		const count = entry.timestamps.length

		if (count >= thresholds.hardStopAfter) {
			this.log(`EXACT_REPEAT block detected: tool=${event.toolName} file=${event.filePath} count=${count}`)
			return {
				pattern: DetectionType.EXACT_REPEAT,
				severity: "block",
				message: `Exact repeat detected for tool "${event.toolName}" on "${event.filePath}" — seen ${count} times (hard limit: ${thresholds.hardStopAfter})`,
				consecutiveCount: count,
			}
		}

		if (count >= thresholds.warnAfter) {
			this.log(`EXACT_REPEAT warn detected: tool=${event.toolName} file=${event.filePath} count=${count}`)
			return {
				pattern: DetectionType.EXACT_REPEAT,
				severity: "warn",
				message: `Exact repeat detected for tool "${event.toolName}" on "${event.filePath}" — seen ${count} times (warn threshold: ${thresholds.warnAfter})`,
				consecutiveCount: count,
			}
		}

		return null
	}

	/**
	 * Check for same-tool failure cascade pattern.
	 * Tracks consecutive failures of the same tool on the same file within a sliding time window.
	 */
	public checkSameToolFailure(event: DetectionEvent): DetectionResult | null {
		if (!event.errorMessage) {
			return null
		}

		const key = this.buildToolFailureKey(event.toolName, event.filePath)
		const now = Date.now()
		const windowMs = this.getFailureWindowMs()
		const thresholds = this.getThresholds(DetectionType.SAME_TOOL_FAILURE)

		let entry = this.toolFailureMap.get(key)
		if (!entry) {
			entry = { toolName: event.toolName, filePath: event.filePath, failures: [] }
			this.toolFailureMap.set(key, entry)
		}

		// Prune failures outside the sliding window
		entry.failures = entry.failures.filter((ts) => now - ts <= windowMs)
		entry.failures.push(now)

		// Use the filtered count (within window) for decision
		const count = entry.failures.length

		if (count >= thresholds.hardStopAfter) {
			this.log(
				`SAME_TOOL_FAILURE block: tool=${event.toolName} file=${event.filePath} failures=${count} in window=${windowMs}ms`,
			)
			return {
				pattern: DetectionType.SAME_TOOL_FAILURE,
				severity: "block",
				message: `Tool "${event.toolName}" failed ${count} times on "${event.filePath}" within ${windowMs}ms window (hard limit: ${thresholds.hardStopAfter})`,
				consecutiveCount: count,
			}
		}

		if (count >= thresholds.warnAfter) {
			this.log(
				`SAME_TOOL_FAILURE warn: tool=${event.toolName} file=${event.filePath} failures=${count} in window=${windowMs}ms`,
			)
			return {
				pattern: DetectionType.SAME_TOOL_FAILURE,
				severity: "warn",
				message: `Tool "${event.toolName}" failed ${count} times on "${event.filePath}" within ${windowMs}ms window (warn threshold: ${thresholds.warnAfter})`,
				consecutiveCount: count,
			}
		}

		return null
	}

	/**
	 * Check for idempotent no-progress pattern.
	 * Tracks file content before/after edit attempts. If file is unchanged
	 * after consecutive edit attempts, a cycle is detected.
	 *
	 * @param filePath - Path to the file being edited.
	 * @param currentContent - Current content of the file after the edit attempt.
	 * @param previousContent - Previous content of the file before the edit attempt.
	 * @returns DetectionResult if no-progress cycle detected, null otherwise.
	 */
	public checkIdempotentNoProgress(
		filePath: string,
		currentContent: string,
		previousContent?: string,
	): DetectionResult | null {
		const thresholds = this.getThresholds(DetectionType.IDEMPOTENT_NO_PROGRESS)

		let entry = this.idempotentMap.get(filePath)
		if (!entry) {
			entry = { filePath, attempts: 0, lastContent: previousContent ?? currentContent }
			this.idempotentMap.set(filePath, entry)
		}

		// If content changed, reset the counter
		if (previousContent !== undefined && previousContent !== entry.lastContent) {
			entry.attempts = 0
			entry.lastContent = previousContent
		}

		// If current content matches the last known content, increment counter
		if (currentContent === entry.lastContent) {
			entry.attempts++
		} else {
			entry.attempts = 0
			entry.lastContent = currentContent
		}

		const count = entry.attempts

		if (count >= thresholds.hardStopAfter) {
			this.log(`IDEMPOTENT_NO_PROGRESS block: file=${filePath} unchanged after ${count} edit attempts`)
			return {
				pattern: DetectionType.IDEMPOTENT_NO_PROGRESS,
				severity: "block",
				message: `File "${filePath}" unchanged after ${count} consecutive edit attempts (hard limit: ${thresholds.hardStopAfter})`,
				consecutiveCount: count,
			}
		}

		if (count >= thresholds.warnAfter) {
			this.log(`IDEMPOTENT_NO_PROGRESS warn: file=${filePath} unchanged after ${count} edit attempts`)
			return {
				pattern: DetectionType.IDEMPOTENT_NO_PROGRESS,
				severity: "warn",
				message: `File "${filePath}" unchanged after ${count} consecutive edit attempts (warn threshold: ${thresholds.warnAfter})`,
				consecutiveCount: count,
			}
		}

		return null
	}

	/**
	 * Reset all internal state for all detection patterns.
	 * Useful when starting a new task or after a circuit breaker reset.
	 */
	public reset(): void {
		this.exactRepeatMap.clear()
		this.toolFailureMap.clear()
		this.idempotentMap.clear()
		this.log("All detection state reset")
	}

	/**
	 * Reset state for a specific detection event.
	 * Useful after a successful tool call breaks a streak.
	 */
	public resetEvent(event: DetectionEvent): void {
		const hash = this.computeHash(event.toolName, event.filePath, event.errorMessage)
		this.exactRepeatMap.delete(hash)

		const key = this.buildToolFailureKey(event.toolName, event.filePath)
		this.toolFailureMap.delete(key)

		this.idempotentMap.delete(event.filePath)
	}

	/**
	 * Get current count for exact-repeat of a specific hash key.
	 */
	public getExactRepeatCount(toolName: string, filePath: string, errorMessage?: string): number {
		const hash = this.computeHash(toolName, filePath, errorMessage)
		const entry = this.exactRepeatMap.get(hash)
		return entry?.timestamps.length ?? 0
	}

	/**
	 * Get current failure count for a tool/file combination.
	 */
	public getToolFailureCount(toolName: string, filePath: string): number {
		const key = this.buildToolFailureKey(toolName, filePath)
		const now = Date.now()
		const windowMs = this.getFailureWindowMs()
		const entry = this.toolFailureMap.get(key)
		if (!entry) return 0
		// Only count failures still within the window
		return entry.failures.filter((ts) => now - ts <= windowMs).length
	}

	/**
	 * Get current idempotent attempt count for a file.
	 */
	public getIdempotentCount(filePath: string): number {
		return this.idempotentMap.get(filePath)?.attempts ?? 0
	}
}
