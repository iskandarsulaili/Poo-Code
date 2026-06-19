/**
 * Log Aggregator — structured JSON logging with correlation IDs.
 *
 * Provides centralized log collection, querying, streaming, and export.
 * Every log entry is tagged with a correlation ID and subtask ID for
 * full observability of parallel subtask execution.
 *
 * @module
 */

import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"

import type { LogEntry, LogFilter } from "@roo-code/types"

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of log entries to keep in memory. */
const MAX_BUFFER_SIZE = 10_000

/** Default log file path. */
const DEFAULT_LOG_FILE = path.join(".roo", ".roosync", "logs", "execution.jsonl")

// ============================================================================
// CorrelationIdManager
// ============================================================================

/**
 * Manages correlation ID generation and propagation.
 *
 * Correlation IDs are generated at task start and propagated to all
 * subtasks via environment variable `ZOO_CORRELATION_ID`.
 */
export class CorrelationIdManager {
	private static current: string | null = null

	/**
	 * Generate a new correlation ID.
	 *
	 * @returns A unique correlation ID string
	 */
	static generate(): string {
		return `run-${crypto.randomUUID().slice(0, 8)}`
	}

	/**
	 * Set the current correlation ID.
	 *
	 * @param id - Correlation ID to set
	 */
	static set(id: string): void {
		CorrelationIdManager.current = id
	}

	/**
	 * Get the current correlation ID, generating one if none exists.
	 *
	 * @returns Current correlation ID
	 */
	static get(): string {
		if (!CorrelationIdManager.current) {
			CorrelationIdManager.current = CorrelationIdManager.generate()
		}
		return CorrelationIdManager.current
	}

	/**
	 * Reset the current correlation ID.
	 */
	static reset(): void {
		CorrelationIdManager.current = null
	}
}

// ============================================================================
// LogAggregator
// ============================================================================

/**
 * Aggregates structured log entries with correlation IDs.
 *
 * Supports in-memory buffering (last 10,000 entries), disk persistence
 * (JSONL format), querying with filters, and streaming per subtask.
 */
export class LogAggregator {
	private buffer: LogEntry[] = []
	private maxBufferSize: number
	private logFilePath: string

	/**
	 * Optional callback invoked after each log entry is recorded.
	 * Used to forward log entries to the webview for live display.
	 */
	public onLog: ((entry: LogEntry) => void) | null = null

	/**
	 * @param logFilePath - Path to the log file (default: `.roo/.roosync/logs/execution.jsonl`)
	 * @param maxBufferSize - Maximum in-memory entries (default: 10,000)
	 */
	constructor(logFilePath?: string, maxBufferSize: number = MAX_BUFFER_SIZE) {
		this.logFilePath = logFilePath ?? DEFAULT_LOG_FILE
		this.maxBufferSize = maxBufferSize

		// Ensure log directory exists
		fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true })
	}

	/**
	 * Append a log entry.
	 *
	 * @param entry - Log entry to append
	 */
	log(entry: LogEntry): void {
		// Add to in-memory buffer
		this.buffer.push(entry)

		// Trim buffer if over max size
		if (this.buffer.length > this.maxBufferSize) {
			this.buffer = this.buffer.slice(-this.maxBufferSize)
		}

		// Write to disk (JSONL format)
		try {
			fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + "\n", "utf-8")
		} catch (error) {
			console.error(`[LogAggregator] Failed to write log entry: ${error}`)
		}

		// Forward to webview via callback if wired
		this.onLog?.(entry)
	}

	/**
	 * Query log entries with optional filters.
	 *
	 * @param filter - Optional filter criteria
	 * @returns Filtered array of log entries
	 */
	getLogs(filter?: LogFilter): LogEntry[] {
		let results = [...this.buffer]

		if (filter) {
			if (filter.correlationId) {
				results = results.filter((e) => e.correlationId === filter.correlationId)
			}
			if (filter.subtaskId) {
				results = results.filter((e) => e.subtaskId === filter.subtaskId)
			}
			if (filter.level) {
				results = results.filter((e) => e.level === filter.level)
			}
			if (filter.component) {
				results = results.filter((e) => e.component === filter.component)
			}
			if (filter.startTime) {
				results = results.filter((e) => e.timestamp >= filter.startTime!)
			}
			if (filter.endTime) {
				results = results.filter((e) => e.timestamp <= filter.endTime!)
			}
			if (filter.limit && filter.limit > 0) {
				results = results.slice(-filter.limit)
			}
		}

		return results
	}

	/**
	 * Stream log entries for a specific subtask.
	 * Returns an async iterable that yields entries as they are added.
	 *
	 * @param subtaskId - Subtask ID to stream logs for
	 * @returns AsyncIterable of log entries
	 */
	async *stream(subtaskId: string): AsyncIterable<LogEntry> {
		const startIndex = this.buffer.length

		while (true) {
			const currentLength = this.buffer.length
			for (let i = startIndex; i < currentLength; i++) {
				const entry = this.buffer[i]
				if (entry.subtaskId === subtaskId) {
					yield entry
				}
			}

			// Wait for new entries
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	/**
	 * Export logs in the specified format.
	 *
	 * @param format - Export format: "json", "jsonl", or "human"
	 * @returns Formatted log string
	 */
	export(format: "json" | "jsonl" | "human" = "json"): string {
		switch (format) {
			case "json":
				return JSON.stringify(this.buffer, null, 2)
			case "jsonl":
				return this.buffer.map((e) => JSON.stringify(e)).join("\n")
			case "human": {
				return this.buffer
					.map((e) => {
						const time = new Date(e.timestamp).toISOString()
						const level = e.level.toUpperCase().padEnd(5)
						const component = e.component.padEnd(16)
						return `[${time}] [${level}] [${component}] [${e.subtaskId || "orchestrator"}] ${e.message}${e.durationMs ? ` (${e.durationMs}ms)` : ""}`
					})
					.join("\n")
			}
		}
	}

	/**
	 * Clear all log entries from memory.
	 */
	clear(): void {
		this.buffer = []
	}

	/**
	 * Get the number of entries in the buffer.
	 *
	 * @returns Current buffer size
	 */
	get size(): number {
		return this.buffer.length
	}
}
