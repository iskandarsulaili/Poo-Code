/**
 * Tests for LogAggregator and CorrelationIdManager — logging, querying, streaming, export.
 */

import { describe, it, expect, beforeEach } from "vitest"

import type { LogEntry } from "@roo-code/types"
import { LogAggregator, CorrelationIdManager } from "../LogAggregator"

describe("CorrelationIdManager", () => {
	beforeEach(() => {
		CorrelationIdManager.reset()
	})

	it("should generate a correlation ID", () => {
		const id = CorrelationIdManager.generate()
		expect(id).toMatch(/^run-[a-f0-9]+$/)
	})

	it("should set and get correlation ID", () => {
		CorrelationIdManager.set("test-run-123")
		expect(CorrelationIdManager.get()).toBe("test-run-123")
	})

	it("should generate on get if not set", () => {
		const id = CorrelationIdManager.get()
		expect(id).toMatch(/^run-[a-f0-9]+$/)
	})

	it("should reset correlation ID", () => {
		CorrelationIdManager.set("test-run")
		CorrelationIdManager.reset()
		expect(CorrelationIdManager.get()).not.toBe("test-run")
	})
})

describe("LogAggregator", () => {
	let aggregator: LogAggregator

	beforeEach(() => {
		aggregator = new LogAggregator("/dev/null", 100)
	})

	function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
		return {
			correlationId: "test-run",
			subtaskId: "subtask-a",
			component: "orchestrator",
			level: "info",
			message: "Test message",
			timestamp: new Date().toISOString(),
			...overrides,
		}
	}

	describe("log", () => {
		it("should add a log entry", () => {
			aggregator.log(makeEntry())
			expect(aggregator.size).toBe(1)
		})

		it("should enforce max buffer size", () => {
			const smallAgg = new LogAggregator("/dev/null", 5)
			for (let i = 0; i < 10; i++) {
				smallAgg.log(makeEntry({ message: `Message ${i}` }))
			}
			expect(smallAgg.size).toBe(5)
		})
	})

	describe("getLogs", () => {
		it("should return all logs without filter", () => {
			aggregator.log(makeEntry())
			aggregator.log(makeEntry({ subtaskId: "subtask-b" }))
			const logs = aggregator.getLogs()
			expect(logs).toHaveLength(2)
		})

		it("should filter by subtaskId", () => {
			aggregator.log(makeEntry({ subtaskId: "subtask-a" }))
			aggregator.log(makeEntry({ subtaskId: "subtask-b" }))
			const logs = aggregator.getLogs({ subtaskId: "subtask-a" })
			expect(logs).toHaveLength(1)
			expect(logs[0].subtaskId).toBe("subtask-a")
		})

		it("should filter by level", () => {
			aggregator.log(makeEntry({ level: "info" }))
			aggregator.log(makeEntry({ level: "error" }))
			const logs = aggregator.getLogs({ level: "error" })
			expect(logs).toHaveLength(1)
			expect(logs[0].level).toBe("error")
		})

		it("should filter by component", () => {
			aggregator.log(makeEntry({ component: "orchestrator" }))
			aggregator.log(makeEntry({ component: "lock-manager" }))
			const logs = aggregator.getLogs({ component: "lock-manager" })
			expect(logs).toHaveLength(1)
		})

		it("should limit results", () => {
			aggregator.log(makeEntry({ message: "1" }))
			aggregator.log(makeEntry({ message: "2" }))
			aggregator.log(makeEntry({ message: "3" }))
			const logs = aggregator.getLogs({ limit: 2 })
			expect(logs).toHaveLength(2)
		})
	})

	describe("export", () => {
		it("should export as JSON", () => {
			aggregator.log(makeEntry())
			const exported = aggregator.export("json")
			expect(() => JSON.parse(exported)).not.toThrow()
		})

		it("should export as JSONL", () => {
			aggregator.log(makeEntry())
			aggregator.log(makeEntry())
			const exported = aggregator.export("jsonl")
			const lines = exported.split("\n").filter(Boolean)
			expect(lines).toHaveLength(2)
		})

		it("should export as human-readable", () => {
			aggregator.log(makeEntry())
			const exported = aggregator.export("human")
			expect(exported).toContain("subtask-a")
			expect(exported).toContain("INFO")
		})
	})

	describe("clear", () => {
		it("should clear all logs", () => {
			aggregator.log(makeEntry())
			aggregator.clear()
			expect(aggregator.size).toBe(0)
		})
	})
})
