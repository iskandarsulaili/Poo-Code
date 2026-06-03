import { describe, it, expect, beforeEach } from "vitest"
import { WorkingMemory } from "../../memory/WorkingMemory"
import { MemoryStoreError, MemoryTier, WorkingContext, ActionRecord } from "../../memory/types"

describe("WorkingMemory", () => {
	let memory: WorkingMemory

	beforeEach(async () => {
		memory = new WorkingMemory()
		await memory.initialize()
	})

	describe("captureContext and getWorkingSet", () => {
		it("should capture and retrieve working context", async () => {
			const context: WorkingContext = {
				sessionId: "session-1",
				currentTask: "Write unit tests",
				recentActions: [],
				openFiles: ["test.ts"],
				conversationState: "active",
				timestamp: Date.now(),
			}
			await memory.captureContext(context)
			const retrieved = await memory.getWorkingSet()
			expect(retrieved.sessionId).toBe("session-1")
			expect(retrieved.currentTask).toBe("Write unit tests")
		})

		it("should throw if no context captured", async () => {
			await expect(memory.getWorkingSet()).rejects.toThrow(MemoryStoreError)
		})
	})

	describe("clearSession", () => {
		it("should clear all data", async () => {
			await memory.captureContext({
				sessionId: "session-1",
				currentTask: "Clean up",
				recentActions: [],
				openFiles: [],
				conversationState: "active",
				timestamp: Date.now(),
			})
			await memory.clearSession()
			await expect(memory.getWorkingSet()).rejects.toThrow(MemoryStoreError)
		})
	})

	describe("recordAction", () => {
		it("should record an action and update context", async () => {
			await memory.captureContext({
				sessionId: "session-1",
				currentTask: "Testing",
				recentActions: [],
				openFiles: [],
				conversationState: "active",
				timestamp: Date.now(),
			})

			const action: ActionRecord = {
				toolName: "write_to_file",
				args: { path: "test.ts" },
				result: "success",
				timestamp: Date.now(),
			}
			await memory.recordAction(action)
			const context = await memory.getWorkingSet()
			expect(context.recentActions).toHaveLength(1)
			expect(context.recentActions[0].toolName).toBe("write_to_file")
		})

		it("should auto-create context if not yet captured", async () => {
			const action: ActionRecord = {
				toolName: "read_file",
				args: { path: "test.ts" },
				result: "content",
				timestamp: Date.now(),
			}
			await memory.recordAction(action)
			const context = await memory.getWorkingSet()
			expect(context.sessionId).toBeDefined()
			expect(context.recentActions).toHaveLength(1)
		})
	})

	describe("store and query", () => {
		it("should get working set returns context correctly", async () => {
			await memory.captureContext({
				sessionId: "session-1",
				currentTask: "Test task",
				recentActions: [],
				openFiles: ["a.ts", "b.ts"],
				conversationState: "active",
				timestamp: Date.now(),
			})
			const set = await memory.getWorkingSet()
			expect(set.openFiles).toContain("a.ts")
			expect(set.sessionId).toBe("session-1")
		})
	})

	describe("tier property", () => {
		it("should return WORKING tier", () => {
			expect(memory.tier).toBe(MemoryTier.WORKING)
		})
	})
})
