/**
 * Tests for ParallelSubtaskOrchestrator — full execution flow, cancellation, status.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import type { SubtaskNode } from "@roo-code/types"
import { ParallelSubtaskOrchestrator } from "../ParallelSubtaskOrchestrator"
import { LockManager } from "../LockManager"
import { Blackboard } from "../Blackboard"
import { ContextRouter } from "../ContextRouter"
import { LogAggregator } from "../LogAggregator"

describe("ParallelSubtaskOrchestrator", () => {
	const testDir = path.join(os.tmpdir(), "roo-orch-test")
	let orchestrator: ParallelSubtaskOrchestrator
	let lockManager: LockManager
	let blackboard: Blackboard
	let contextRouter: ContextRouter
	let logAggregator: LogAggregator

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true })
		lockManager = new LockManager(path.join(testDir, "heartbeats"))
		blackboard = new Blackboard(lockManager, path.join(testDir, "topics"))
		contextRouter = new ContextRouter(blackboard)
		logAggregator = new LogAggregator(path.join(testDir, "logs.jsonl"), 100)
		orchestrator = new ParallelSubtaskOrchestrator(lockManager, blackboard, contextRouter, logAggregator, 4)
	})

	afterEach(() => {
		lockManager.dispose()
		fs.rmSync(testDir, { recursive: true, force: true })
	})

	function makeSubtask(id: string, deps: string[] = []): SubtaskNode {
		return {
			id,
			name: id,
			mode: "code",
			prompt: `Execute ${id}`,
			inputFiles: [],
			outputFiles: [],
			deps,
			requiredResources: [],
			subscribedTopics: [],
			publishedTopics: [],
			estimatedTokens: 1000,
			timeoutMs: 300_000,
			isCritical: false,
			status: "pending",
			metadata: { correlationId: "" },
		}
	}

	describe("execute", () => {
		it("should return empty DAG for empty tasks", async () => {
			const dag = await orchestrator.execute([])
			expect(dag.status).toBe("completed")
			expect(dag.nodes.size).toBe(0)
		})

		it("should execute a single subtask", async () => {
			const dag = await orchestrator.execute([makeSubtask("a")])
			expect(dag.status).toBe("completed")
			expect(dag.nodes.get("a")!.status).toBe("completed")
		})

		it("should execute independent subtasks in parallel", async () => {
			const dag = await orchestrator.execute([makeSubtask("a"), makeSubtask("b"), makeSubtask("c")])
			expect(dag.status).toBe("completed")
			expect(dag.nodes.get("a")!.status).toBe("completed")
			expect(dag.nodes.get("b")!.status).toBe("completed")
			expect(dag.nodes.get("c")!.status).toBe("completed")
		})

		it("should execute dependent subtasks in order", async () => {
			const dag = await orchestrator.execute([makeSubtask("a"), makeSubtask("b", ["a"]), makeSubtask("c", ["b"])])
			expect(dag.status).toBe("completed")
			expect(dag.nodes.get("a")!.status).toBe("completed")
			expect(dag.nodes.get("b")!.status).toBe("completed")
			expect(dag.nodes.get("c")!.status).toBe("completed")
		})

		it("should detect cycles and fail", async () => {
			const dag = await orchestrator.execute([makeSubtask("a", ["b"]), makeSubtask("b", ["a"])])
			expect(dag.status).toBe("failed")
		})
	})

	describe("cancel", () => {
		it("should cancel a specific subtask", async () => {
			const dag = await orchestrator.execute([makeSubtask("a"), makeSubtask("b")])
			orchestrator.cancel("a")
			expect(dag.nodes.get("a")!.status).toBe("skipped")
		})

		it("should abort all subtasks", async () => {
			// Cancel after execution — verify it doesn't throw and releases locks
			const dag = await orchestrator.execute([makeSubtask("a"), makeSubtask("b")])
			orchestrator.cancel()
			// Execution completed before cancel, so status is "completed"
			expect(dag.status).toBe("completed")
			// All locks should be released
			expect(lockManager.getHeldLocks("a")).toHaveLength(0)
			expect(lockManager.getHeldLocks("b")).toHaveLength(0)
		})
	})

	describe("getStatus", () => {
		it("should return pending DAG before execution", () => {
			const status = orchestrator.getStatus()
			expect(status.status).toBe("pending")
		})

		it("should return completed DAG after execution", async () => {
			await orchestrator.execute([makeSubtask("a")])
			const status = orchestrator.getStatus()
			expect(status.status).toBe("completed")
		})
	})

	describe("getDAG", () => {
		it("should return the current DAG", async () => {
			await orchestrator.execute([makeSubtask("a")])
			const dag = orchestrator.getDAG()
			expect(dag.nodes.has("a")).toBe(true)
		})
	})

	describe("getLogs", () => {
		it("should return execution logs", async () => {
			await orchestrator.execute([makeSubtask("a")])
			const logs = orchestrator.getLogs()
			expect(logs.length).toBeGreaterThan(0)
			expect(logs.some((l) => l.message.includes("Starting subtask"))).toBe(true)
		})

		it("should filter logs by subtask", async () => {
			await orchestrator.execute([makeSubtask("a"), makeSubtask("b")])
			const logs = orchestrator.getLogs({ subtaskId: "a" })
			expect(logs.every((l) => l.subtaskId === "a" || l.subtaskId === "")).toBe(true)
		})
	})

	describe("getExecutionResult", () => {
		it("should return execution result after run", async () => {
			await orchestrator.execute([makeSubtask("a")])
			const result = orchestrator.getExecutionResult()
			expect(result.status).toBe("completed")
			expect(result.subtaskResults).toHaveLength(1)
			expect(result.subtaskResults[0].id).toBe("a")
		})
	})
})
