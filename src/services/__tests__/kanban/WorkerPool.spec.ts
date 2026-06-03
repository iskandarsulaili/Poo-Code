// Run: cd Zoo-Code/src && pnpm vitest run services/__tests__/kanban/WorkerPool.spec.ts

import { WorkerPool } from "../../kanban/WorkerPool"
import { KanbanBoardManager } from "../../kanban/KanbanBoard"
import { SubagentManager } from "../../subagent/SubagentManager"

describe("WorkerPool", () => {
	let workerPool: WorkerPool
	let boardManager: KanbanBoardManager
	let subagentManager: SubagentManager

	beforeEach(() => {
		boardManager = new KanbanBoardManager()
		subagentManager = new SubagentManager({ workspaceRoot: "/tmp/test", poolSize: 3 })
		workerPool = new WorkerPool(subagentManager, boardManager)
	})

	afterEach(async () => {
		await subagentManager.dispose()
	})

	describe("constructor", () => {
		it("should use default concurrency of 3", () => {
			expect(workerPool).toBeDefined()
		})
	})

	describe("getProgress", () => {
		it("should return zero progress for missing board", () => {
			const progress = workerPool.getProgress("non-existent")
			expect(progress.total).toBe(0)
			expect(progress.todo).toBe(0)
			expect(progress.percentage).toBe(0)
		})

		it("should reflect partially completed work", () => {
			const board = boardManager.createBoard("Test")
			const card1 = boardManager.addCard(board.id, {
				title: "Auth",
				description: "Auth system",
			})
			const card2 = boardManager.addCard(board.id, {
				title: "DB",
				description: "DB setup",
			})

			// Perform valid transition sequence: todo → in_progress → in_review → done
			boardManager.updateCardStatus(card1.id, "in_progress")
			boardManager.updateCardStatus(card1.id, "in_review")
			boardManager.updateCardStatus(card1.id, "done")

			const progress = workerPool.getProgress(board.id)
			expect(progress.total).toBe(2)
			expect(progress.done).toBe(1)
			expect(progress.todo).toBe(1) // card2 still todo
		})
	})

	describe("executeCard", () => {
		it("should return failed result for card with unmeetable dependency", async () => {
			const board = boardManager.createBoard("Test")
			const card = boardManager.addCard(board.id, {
				title: "Auth",
				description: "Auth system",
				deps: ["non-existent-dep"],
			})

			const result = await workerPool.executeCard(card)
			expect(result.success).toBe(false)
			expect(result.errors).toBeDefined()
			expect(result.errors!.length).toBeGreaterThan(0)
		})
	})
})
