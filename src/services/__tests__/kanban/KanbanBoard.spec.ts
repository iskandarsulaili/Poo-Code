// Run: cd Zoo-Code/src && pnpm vitest run services/__tests__/kanban/KanbanBoard.spec.ts

import { KanbanBoardManager } from "../../kanban/KanbanBoard"
import { BoardNotFoundError, CardNotFoundError, InvalidStatusTransitionError } from "../../kanban/types"

describe("KanbanBoardManager", () => {
	let manager: KanbanBoardManager

	beforeEach(() => {
		manager = new KanbanBoardManager()
	})

	describe("createBoard", () => {
		it("should create a board with name and description", () => {
			const board = manager.createBoard("Sprint 24", "Q3 feature development")

			expect(board).toBeDefined()
			expect(board.id).toBeDefined()
			expect(board.name).toBe("Sprint 24")
			expect(board.description).toBe("Q3 feature development")
			expect(board.status).toBe("active")
			expect(board.cards).toEqual([])
			expect(board.createdAt).toBeGreaterThan(0)
			expect(board.updatedAt).toBeGreaterThan(0)
		})

		it("should create a board without description", () => {
			const board = manager.createBoard("Sprint 24")
			expect(board.name).toBe("Sprint 24")
			expect(board.description).toBeUndefined()
		})
	})

	describe("addCard", () => {
		it("should add a card to a board and return it with an id", () => {
			const board = manager.createBoard("Sprint 24")
			const card = manager.addCard(board.id, {
				title: "Implement auth",
				description: "OAuth2 login flow",
				priority: "high",
				acceptanceCriteria: ["User can log in"],
			})

			expect(card).toBeDefined()
			expect(card.id).toBeDefined()
			expect(card.title).toBe("Implement auth")
			expect(card.description).toBe("OAuth2 login flow")
			expect(card.priority).toBe("high")
			expect(card.status).toBe("todo")
			expect(card.deps).toEqual([])
			expect(card.acceptanceCriteria).toEqual(["User can log in"])

			// Verify card is on the board
			const retrievedBoard = manager.getBoard(board.id)
			expect(retrievedBoard.cards).toHaveLength(1)
			expect(retrievedBoard.cards[0].id).toBe(card.id)
		})

		it("should throw BoardNotFoundError when adding to non-existent board", () => {
			expect(() => manager.addCard("non-existent", { title: "Test", description: "Test" })).toThrow(
				BoardNotFoundError,
			)
		})
	})

	describe("updateCardStatus", () => {
		it("should transition from todo to in_progress", () => {
			const board = manager.createBoard("Test")
			const card = manager.addCard(board.id, { title: "Task", description: "Do it" })

			manager.updateCardStatus(card.id, "in_progress")
			const boardState = manager.getBoard(board.id)
			const updated = boardState.cards.find((c) => c.id === card.id)
			expect(updated?.status).toBe("in_progress")
		})

		it("should transition from in_progress to in_review to done", () => {
			const board = manager.createBoard("Test")
			const card = manager.addCard(board.id, { title: "Task", description: "Do it" })

			manager.updateCardStatus(card.id, "in_progress")
			manager.updateCardStatus(card.id, "in_review")
			manager.updateCardStatus(card.id, "done")

			const boardState = manager.getBoard(board.id)
			const updated = boardState.cards.find((c) => c.id === card.id)
			expect(updated?.status).toBe("done")
		})

		it("should throw InvalidStatusTransitionError for invalid transition", () => {
			const board = manager.createBoard("Test")
			const card = manager.addCard(board.id, { title: "Task", description: "Do it" })

			expect(() => manager.updateCardStatus(card.id, "done")).toThrow(InvalidStatusTransitionError)
		})

		it("should throw CardNotFoundError for non-existent card", () => {
			expect(() => manager.updateCardStatus("non-existent", "in_progress")).toThrow(CardNotFoundError)
		})
	})

	describe("getBlockedCards", () => {
		it("should return cards whose deps are not all done", () => {
			const board = manager.createBoard("Test")
			const dep1 = manager.addCard(board.id, { title: "Dep1", description: "" })
			const dep2 = manager.addCard(board.id, { title: "Dep2", description: "" })
			const main = manager.addCard(board.id, { title: "Main", description: "", deps: [dep1.id, dep2.id] })

			// Only dep1 is done (dep2 still todo)
			manager.updateCardStatus(dep1.id, "in_progress")
			manager.updateCardStatus(dep1.id, "in_review")
			manager.updateCardStatus(dep1.id, "done")

			const blocked = manager.getBlockedCards(board.id)
			expect(blocked.some((c) => c.id === main.id)).toBe(true)
		})

		it("should not return cards whose deps are all done", () => {
			const board = manager.createBoard("Test")
			const dep1 = manager.addCard(board.id, { title: "Dep1", description: "" })
			const main = manager.addCard(board.id, { title: "Main", description: "", deps: [dep1.id] })

			// Complete the dep
			manager.updateCardStatus(dep1.id, "in_progress")
			manager.updateCardStatus(dep1.id, "in_review")
			manager.updateCardStatus(dep1.id, "done")

			const blocked = manager.getBlockedCards(board.id)
			expect(blocked.some((c) => c.id === main.id)).toBe(false)
		})
	})
})
