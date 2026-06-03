import type { KanbanCard, CardResult, SynthesisResult, UnresolvedItem } from "./types"
import { BoardNotFoundError } from "./types"
import { KanbanBoardManager } from "./KanbanBoard"

/**
 * Synthesizer — merges completed kanban card results into a coherent output
 * and generates human-readable summaries.
 *
 * Identifies items not covered by any card's acceptance criteria (unresolved items)
 * and provides an overall execution summary.
 *
 * @example
 * ```ts
 * const synthesizer = new Synthesizer(boardManager)
 * const synthesis = await synthesizer.synthesize("board-123")
 * console.log(synthesizer.generateSummary("board-123"))
 * ```
 */
export class Synthesizer {
	private readonly boardManager: KanbanBoardManager

	constructor(boardManager: KanbanBoardManager) {
		this.boardManager = boardManager
	}

	/**
	 * Synthesize all completed card results on a board into a single result.
	 *
	 * Merges outputs in card execution order (respecting dependencies),
	 * collects execution stats, and produces a unified output.
	 *
	 * @param boardId - Board ID
	 * @returns SynthesisResult with merged output and stats
	 */
	async synthesize(boardId: string): Promise<SynthesisResult> {
		const board = this.boardManager.getBoard(boardId)

		// Collect completed cards' results in dependency-respecting order
		const completedCards = board.cards
			.filter((c) => c.status === "done" && c.result)
			.sort((a, b) => this.dependencyOrder(a, b, board.cards))

		const cardResults: CardResult[] = completedCards
			.map((c) => c.result!)
			.filter((r): r is CardResult => r !== undefined)

		if (cardResults.length === 0) {
			return {
				boardId,
				success: false,
				mergedOutput: "No completed cards to synthesize.",
				cardResults: [],
				executionSummary: {
					total: 0,
					succeeded: 0,
					failed: 0,
					totalTimeMs: 0,
				},
			}
		}

		const sections: string[] = []
		let succeeded = 0
		let failed = 0
		let totalTimeMs = 0

		for (const result of cardResults) {
			const card = completedCards.find((c) => c.result?.cardId === result.cardId)
			const title = card?.title ?? result.cardId

			sections.push(`## ${title}`)
			sections.push("")

			if (result.success) {
				succeeded++
				sections.push(result.output)
			} else {
				failed++
				sections.push(`**FAILED**: ${(result.errors ?? ["Unknown error"]).join("; ")}`)
			}

			if (result.filesModified.length > 0) {
				sections.push("")
				sections.push(`Files modified: ${result.filesModified.join(", ")}`)
			}

			totalTimeMs += result.executionTimeMs
			sections.push("")
		}

		const mergedOutput = sections.join("\n")
		const allSucceeded = failed === 0

		return {
			boardId,
			success: allSucceeded,
			mergedOutput,
			cardResults,
			executionSummary: {
				total: cardResults.length,
				succeeded,
				failed,
				totalTimeMs,
			},
		}
	}

	/**
	 * Generate a human-readable summary of board execution.
	 *
	 * @param boardId - Board ID
	 * @returns Formatted summary string
	 */
	generateSummary(boardId: string): string {
		const board = this.boardManager.getBoard(boardId)
		const progress = this.boardManager.getBoardProgress(boardId)

		const lines: string[] = [
			`Board: ${board.name}`,
			`Status: ${board.status}`,
			`Total cards: ${progress.total}`,
			`├─ Done: ${progress.done}`,
			`├─ In Progress: ${progress.inProgress}`,
			`├─ In Review: ${progress.inReview}`,
			`├─ Blocked: ${progress.blocked}`,
			`└─ Todo: ${progress.todo}`,
			``,
			`Progress: ${progress.percentage}% complete`,
		]

		// List done cards
		const doneCards = board.cards.filter((c) => c.status === "done")
		if (doneCards.length > 0) {
			lines.push("", "Completed cards:")
			for (const card of doneCards) {
				const resultSummary = card.result?.success ? "✅" : card.result ? "❌" : "⬜"
				lines.push(`  ${resultSummary} ${card.title}`)
			}
		}

		// List blocked cards
		const blockedCards = this.boardManager.getBlockedCards(boardId)
		if (blockedCards.length > 0) {
			lines.push("", "Blocked cards:")
			for (const card of blockedCards) {
				const blockingDeps = card.deps
					.map((depId) => board.cards.find((c) => c.id === depId))
					.filter((c) => c && c.status !== "done")
					.map((c) => c!.title)
				lines.push(`  🔒 ${card.title} (waiting for: ${blockingDeps.join(", ")})`)
			}
		}

		return lines.join("\n")
	}

	/**
	 * Identify items mentioned in the board description or card titles
	 * that aren't covered by any card's acceptance criteria.
	 *
	 * @param boardId - Board ID
	 * @returns Array of unresolved items
	 */
	getUnresolvedItems(boardId: string): UnresolvedItem[] {
		const board = this.boardManager.getBoard(boardId)
		const items: UnresolvedItem[] = []

		// Collect all acceptance criteria keywords
		const coveredTerms = new Set<string>()
		for (const card of board.cards) {
			for (const ac of card.acceptanceCriteria) {
				ac.toLowerCase()
					.split(/[^a-z0-9]+/)
					.filter((t) => t.length > 3)
					.forEach((t) => coveredTerms.add(t))
			}
		}

		// Check board description for uncovered terms
		if (board.description) {
			const descTerms = board.description
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((t) => t.length > 4)

			const uniqueDescTerms = [...new Set(descTerms)]
			const uncovered = uniqueDescTerms.filter((t) => !coveredTerms.has(t))

			if (uncovered.length > 3) {
				items.push({
					description: `Board description mentions topics not covered by acceptance criteria: "${uncovered.slice(0, 5).join(", ")}${uncovered.length > 5 ? `... (${uncovered.length - 5} more)` : ""}"`,
					sourceContext: `Board "${board.name}" description`,
					severity: "warning",
				})
			}
		}

		// Check for cards without acceptance criteria
		const cardsWithoutCriteria = board.cards.filter(
			(c) => !c.acceptanceCriteria || c.acceptanceCriteria.length === 0,
		)
		for (const card of cardsWithoutCriteria) {
			items.push({
				description: `Card "${card.title}" has no acceptance criteria defined`,
				sourceContext: `Card ${card.id} in board "${board.name}"`,
				severity: "info",
			})
		}

		// Check for cards with no result (not executed)
		const unexecutedCards = board.cards.filter((c) => !c.result && c.status === "done")
		for (const card of unexecutedCards) {
			items.push({
				description: `Card "${card.title}" is marked done but has no execution result`,
				sourceContext: `Card ${card.id}`,
				severity: "warning",
			})
		}

		return items
	}

	/**
	 * Sort comparator: cards with deps come after their dependencies.
	 */
	private dependencyOrder(a: KanbanCard, b: KanbanCard, allCards: KanbanCard[]): number {
		// If a depends on b, a comes after b
		if (a.deps.includes(b.id)) {
			return 1
		}
		// If b depends on a, b comes after a
		if (b.deps.includes(a.id)) {
			return -1
		}
		// Otherwise, maintain insertion order
		return allCards.indexOf(a) - allCards.indexOf(b)
	}
}
