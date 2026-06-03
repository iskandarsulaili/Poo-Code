// npx vitest services/__tests__/kanban/TaskDecomposer.spec.ts

import { TaskDecomposer } from "../../kanban/TaskDecomposer"
import type { KanbanCard } from "../../kanban/types"
import type { ProviderSettings } from "@roo-code/types"

describe("TaskDecomposer", () => {
	let decomposer: TaskDecomposer
	const mockApiConfig: ProviderSettings = {
		apiProvider: "openai",
		openAiApiKey: "mock-key",
		openAiModelId: "gpt-4",
	}

	beforeEach(() => {
		decomposer = new TaskDecomposer(mockApiConfig, { maxCards: 10 })
	})

	describe("validateDecomposition", () => {
		it("should detect cycles in dependencies", () => {
			const cards: KanbanCard[] = [
				{
					id: "card-1",
					boardId: "board-1",
					title: "Setup DB",
					description: "Set up the database schema",
					status: "todo",
					priority: "high",
					deps: ["card-2"], // card-1 depends on card-2
					acceptanceCriteria: ["DB is running"],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "card-2",
					boardId: "board-1",
					title: "Build API",
					description: "Build the API layer",
					status: "todo",
					priority: "high",
					deps: ["card-1"], // card-2 depends on card-1 — cycle!
					acceptanceCriteria: ["API is running"],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			]

			const result = decomposer.validateDecomposition(cards)
			expect(result.valid).toBe(false)
			expect(result.cycles.length).toBeGreaterThan(0)
		})

		it("should detect orphaned cards with missing dependency targets", () => {
			const cards: KanbanCard[] = [
				{
					id: "card-1",
					boardId: "board-1",
					title: "Main task",
					description: "The main task",
					status: "todo",
					priority: "high",
					deps: ["non-existent-card"],
					acceptanceCriteria: ["Done"],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			]

			const result = decomposer.validateDecomposition(cards)
			expect(result.valid).toBe(false)
			expect(result.orphanCards.length).toBeGreaterThan(0)
			expect(result.warnings.some((w) => w.includes("non-existent-card"))).toBe(true)
		})

		it("should validate a valid decomposition without issues", () => {
			const cards: KanbanCard[] = [
				{
					id: "card-1",
					boardId: "board-1",
					title: "Setup DB",
					description: "Set up the database",
					status: "todo",
					priority: "high",
					deps: [],
					acceptanceCriteria: ["Schema created"],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "card-2",
					boardId: "board-1",
					title: "Add tests",
					description: "Write tests for the feature",
					status: "todo",
					priority: "medium",
					deps: ["card-1"],
					acceptanceCriteria: ["Tests pass"],
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			]

			const result = decomposer.validateDecomposition(cards)
			// Should be valid despite warnings about no test card (we have one) and acceptance criteria
			expect(result.cycles).toHaveLength(0)
			expect(result.orphanCards).toHaveLength(0)
		})
	})
})
