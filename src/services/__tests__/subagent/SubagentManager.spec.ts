// Run: cd Zoo-Code/src && pnpm vitest run services/__tests__/subagent/SubagentManager.spec.ts

import { SubagentManager } from "../../subagent/SubagentManager"
import { generateSubagentId, SubagentError } from "../../subagent/types"
import type { SubagentConfig } from "../../subagent/types"

describe("SubagentManager", () => {
	let manager: SubagentManager
	const workspaceRoot = "/tmp/test-workspace"

	beforeEach(() => {
		manager = new SubagentManager({ workspaceRoot, poolSize: 3 })
	})

	afterEach(async () => {
		await manager.dispose()
	})

	describe("constructor", () => {
		it("should create a manager with defaults", () => {
			expect(manager).toBeDefined()
		})
	})

	describe("spawnSubagent", () => {
		it("should register subagent in active tracking", async () => {
			const id = generateSubagentId()
			const config: SubagentConfig = {
				subagentId: id,
				role: "leaf",
				taskPrompt: "Test task",
			}

			// spawnSubagent catches errors and returns a failed result (never rejects)
			const result = await manager.spawnSubagent(config)

			expect(result.subagentId).toBe(id)
			expect(result.success).toBe(false)

			// Entry should exist with a terminal status
			const statuses = manager.getAllStatuses()
			expect(statuses.length).toBe(1)
			expect(statuses[0].subagentId).toBe(id)
		})
	})

	describe("spawnParallel", () => {
		it("should return results in config order", async () => {
			const configs: SubagentConfig[] = [
				{ subagentId: generateSubagentId(), role: "leaf", taskPrompt: "Task 1" },
				{ subagentId: generateSubagentId(), role: "leaf", taskPrompt: "Task 2" },
			]

			const results = await manager.spawnParallel(configs, 2)
			expect(results).toHaveLength(2)
			expect(results[0].subagentId).toBe(configs[0].subagentId)
			expect(results[1].subagentId).toBe(configs[1].subagentId)
		})
	})

	describe("cancelSubagent", () => {
		it("should throw when cancelling a non-existent subagent", async () => {
			await expect(manager.cancelSubagent("non-existent")).rejects.toThrow(SubagentError)
		})

		it("should be a no-op on already-failed subagent", async () => {
			const id = generateSubagentId()
			const config: SubagentConfig = {
				subagentId: id,
				role: "leaf",
				taskPrompt: "Test task",
			}

			await manager.spawnSubagent(config)

			// Cancelling a failed subagent should not throw
			await expect(manager.cancelSubagent(id)).resolves.toBeUndefined()
			const status = manager.getStatus(id)
			expect(status.status).toBe("failed")
		})
	})

	describe("status tracking", () => {
		it("should throw when getting status of unknown subagent", () => {
			expect(() => manager.getStatus("unknown-id")).toThrow(SubagentError)
		})

		it("should return execution summary with correct counts", () => {
			const summary = manager.getExecutionSummary()
			expect(summary.totalSubagents).toBe(0)
			expect(summary.succeeded).toBe(0)
			expect(summary.failed).toBe(0)
			expect(summary.timedOut).toBe(0)
			expect(summary.cancelled).toBe(0)
			expect(summary.totalExecutionTimeMs).toBe(0)
		})
	})

	describe("cancelAll", () => {
		it("should handle cancelAll with no active subagents", async () => {
			await expect(manager.cancelAll()).resolves.toBeUndefined()
		})
	})
})
