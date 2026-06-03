// Run: cd Zoo-Code/src && pnpm vitest run services/__tests__/kanban/Synthesizer.spec.ts

import { Synthesizer } from "../../kanban/Synthesizer"
import { KanbanBoardManager } from "../../kanban/KanbanBoard"

describe("Synthesizer", () => {
	let boardManager: KanbanBoardManager
	let synthesizer: Synthesizer

	beforeEach(() => {
		boardManager = new KanbanBoardManager()
		synthesizer = new Synthesizer(boardManager)
	})

	describe("generateSummary", () => {
		it("should return a summary for an empty board", () => {
			const board = boardManager.createBoard("Test")
			const summary = synthesizer.generateSummary(board.id)
			expect(summary).toContain("Test")
		})

		it("should show completed card titles", () => {
			const board = boardManager.createBoard("Sprint 24")
			const card = boardManager.addCard(board.id, {
				title: "Auth",
				description: "Auth system",
				acceptanceCriteria: ["Login works"],
			})

			boardManager.updateCardStatus(card.id, "in_progress")
			boardManager.updateCardStatus(card.id, "in_review")
			boardManager.updateCardStatus(card.id, "done")

			const summary = synthesizer.generateSummary(board.id)
			expect(summary).toContain("Auth")
		})
	})

	describe("getUnresolvedItems", () => {
		it("should detect cards without acceptance criteria", () => {
			const board = boardManager.createBoard("Test")
			boardManager.addCard(board.id, {
				title: "Auth",
				description: "Auth system",
			})

			const items = synthesizer.getUnresolvedItems(board.id)
			expect(items.length).toBeGreaterThan(0)
			expect(items.some((i) => i.description.includes("no acceptance criteria"))).toBe(true)
		})
	})

	describe("synthesize", () => {
		it("should return synthesis for a board with no completed cards", async () => {
			const board = boardManager.createBoard("Test")
			boardManager.addCard(board.id, {
				title: "Auth",
				description: "Auth system",
				acceptanceCriteria: ["Login works"],
			})

			const result = await synthesizer.synthesize(board.id)
			expect(result.boardId).toBe(board.id)
			expect(result.success).toBe(false) // no completed cards → not successful
			expect(result.cardResults).toHaveLength(0)
			expect(result.executionSummary.total).toBe(0)
		})
	})
})
