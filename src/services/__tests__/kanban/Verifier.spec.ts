// Run: cd Zoo-Code/src && pnpm vitest run services/__tests__/kanban/Verifier.spec.ts

import { Verifier } from "../../kanban/Verifier"
import { KanbanBoardManager } from "../../kanban/KanbanBoard"
import type { KanbanCard, CardResult } from "../../kanban/types"

describe("Verifier", () => {
	let boardManager: KanbanBoardManager
	let verifier: Verifier

	beforeEach(() => {
		boardManager = new KanbanBoardManager()
		verifier = new Verifier(boardManager)
	})

	describe("verifyCard", () => {
		it("should pass when all criteria are met in output", () => {
			const card: KanbanCard = {
				id: "card-1",
				boardId: "board-1",
				title: "Add auth",
				description: "Implement auth",
				status: "done",
				priority: "high",
				deps: [],
				acceptanceCriteria: ["User can log in", "Tokens refresh automatically"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}

			const result: CardResult = {
				cardId: "card-1",
				success: true,
				output: "Implemented OAuth2 login. User can log in. Tokens refresh automatically.",
				filesModified: ["auth.ts"],
				executionTimeMs: 100,
			}

			const verification = verifier.verifyCard(card, result)
			expect(verification.passed).toBe(true)
			expect(verification.criteriaResults).toHaveLength(2)
			expect(verification.criteriaResults.every((cr) => cr.passed)).toBe(true)
		})

		it("should fail when output lacks explicit criteria mention and result failed", () => {
			const card: KanbanCard = {
				id: "card-1",
				boardId: "board-1",
				title: "Add auth",
				description: "Implement auth",
				status: "done",
				priority: "high",
				deps: [],
				acceptanceCriteria: ["User can log in", "MFA is enabled"],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}

			const result: CardResult = {
				cardId: "card-1",
				success: false, // must be false so the fallback doesn't mask the mismatch
				output: "User can log in.",
				filesModified: ["auth.ts"],
				executionTimeMs: 100,
			}

			const verification = verifier.verifyCard(card, result)
			expect(verification.passed).toBe(false)
			expect(verification.criteriaResults.some((cr) => !cr.passed)).toBe(true)
		})
	})

	describe("verifyBoard", () => {
		it("should count cards that are not done as not verified", () => {
			const board = boardManager.createBoard("Test Board")
			boardManager.addCard(board.id, {
				title: "Auth",
				description: "Auth system",
				acceptanceCriteria: ["User can log in"],
			})
			boardManager.addCard(board.id, {
				title: "DB",
				description: "Database",
				acceptanceCriteria: ["Data persists"],
			})

			const boardResult = verifier.verifyBoard(board.id)
			expect(boardResult.totalCards).toBe(2)
			expect(boardResult.notVerified).toBe(2)
		})
	})

	describe("getVerificationReport", () => {
		it("should generate a serializable verification report for an empty board", () => {
			const board = boardManager.createBoard("Test Board")
			const report = verifier.getVerificationReport(board.id)
			expect(report.boardId).toBe(board.id)
			expect(report.totalCards).toBe(0)
			expect(report.details).toHaveLength(0)
			expect(report.generatedAt).toBeGreaterThan(0)
		})
	})
})
