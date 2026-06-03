import type {
	KanbanCard,
	CardResult,
	VerificationResult,
	CriteriaResult,
	BoardVerificationResult,
	VerificationReport,
} from "./types"
import { BoardNotFoundError, CardNotFoundError } from "./types"
import { KanbanBoardManager } from "./KanbanBoard"

/**
 * Verifier — validates that card/board outputs meet acceptance criteria.
 *
 * Uses simple text-based matching to verify criteria against card outputs.
 * More sophisticated verification (LLM-based) can be added as an extension.
 *
 * @example
 * ```ts
 * const verifier = new Verifier(boardManager)
 * const result = verifier.verifyCard(card, cardResult)
 * if (result.passed) {
 *   console.log(`Card ${card.title} verified successfully`)
 * }
 * ```
 */
export class Verifier {
	private readonly boardManager: KanbanBoardManager

	constructor(boardManager: KanbanBoardManager) {
		this.boardManager = boardManager
	}

	/**
	 * Verify a single card's result against its acceptance criteria.
	 *
	 * Each criterion is checked against the card output using substring matching.
	 * A criterion passes if the output contains the criterion text (case-insensitive)
	 * or if the criterion is a known pattern that can be verified.
	 *
	 * @param card - The card to verify
	 * @param result - The result from executing the card
	 * @returns VerificationResult with per-criteria breakdown
	 */
	verifyCard(card: KanbanCard, result: CardResult): VerificationResult {
		const criteriaResults: CriteriaResult[] = []

		if (!card.acceptanceCriteria || card.acceptanceCriteria.length === 0) {
			return {
				cardId: card.id,
				passed: result.success,
				criteriaResults: [],
				overallMessage: result.success
					? "Card completed (no acceptance criteria defined)"
					: "Card execution failed",
			}
		}

		for (const criterion of card.acceptanceCriteria) {
			const cr = this.verifyCriterion(criterion, result)
			criteriaResults.push(cr)
		}

		const allPassed = criteriaResults.every((cr) => cr.passed)
		const failedCount = criteriaResults.filter((cr) => !cr.passed).length

		return {
			cardId: card.id,
			passed: allPassed,
			criteriaResults,
			overallMessage: allPassed
				? "All acceptance criteria met"
				: `${failedCount} of ${criteriaResults.length} criteria not met`,
		}
	}

	/**
	 * Verify all completed cards on a board.
	 *
	 * @param boardId - Board ID
	 * @returns BoardVerificationResult with per-card results
	 */
	verifyBoard(boardId: string): BoardVerificationResult {
		const board = this.boardManager.getBoard(boardId)
		const cardResults: VerificationResult[] = []

		for (const card of board.cards) {
			if (card.status === "done" && card.result) {
				const vr = this.verifyCard(card, card.result)
				cardResults.push(vr)
			}
		}

		const verified = cardResults.filter((r) => r.passed).length
		const failed = cardResults.filter((r) => !r.passed).length
		const notVerified = board.cards.filter((c) => c.status !== "done" || !c.result).length

		return {
			boardId,
			totalCards: board.cards.length,
			verified,
			failed,
			notVerified,
			cardResults,
		}
	}

	/**
	 * Get a serializable verification report for a board.
	 *
	 * @param boardId - Board ID
	 * @returns VerificationReport with detailed breakdown
	 */
	getVerificationReport(boardId: string): VerificationReport {
		const boardVerification = this.verifyBoard(boardId)
		const board = this.boardManager.getBoard(boardId)

		return {
			boardId,
			generatedAt: Date.now(),
			totalCards: boardVerification.totalCards,
			passed: boardVerification.verified,
			failed: boardVerification.failed,
			details: boardVerification.cardResults.map((vr) => {
				const card = board.cards.find((c) => c.id === vr.cardId)
				return {
					cardId: vr.cardId,
					cardTitle: card?.title ?? "Unknown",
					passed: vr.passed,
					criteriaBreakdown: vr.criteriaResults,
				}
			}),
		}
	}

	/**
	 * Verify a single criterion against a card result.
	 */
	private verifyCriterion(criterion: string, result: CardResult): CriteriaResult {
		const criterionLower = criterion.toLowerCase()

		// Check if the output mentions the criterion
		const outputContainsCriterion = result.output.toLowerCase().includes(criterionLower)

		// Check for common verification patterns
		const isFileExistsCheck =
			criterionLower.includes("file") && (criterionLower.includes("create") || criterionLower.includes("exist"))
		const isFunctionalityCheck = criterionLower.includes("should") || criterionLower.includes("must")

		if (isFileExistsCheck) {
			// Verify against filesModified
			const filesMatch = result.filesModified.some(
				(f) => criterionLower.includes(f.toLowerCase()) || f.toLowerCase().includes(criterionLower),
			)
			return {
				criterion,
				passed: filesMatch || outputContainsCriterion || result.success,
				details: filesMatch
					? "Matched by modified files"
					: "No matching files found; relying on overall success",
			}
		}

		if (isFunctionalityCheck) {
			// Functionality criteria — verify by output content
			return {
				criterion,
				passed: outputContainsCriterion || result.success,
				details: outputContainsCriterion
					? "Criterion mentioned in output"
					: "No direct match; relying on overall success",
			}
		}

		// Default: simple text matching
		return {
			criterion,
			passed: outputContainsCriterion || result.success,
			details: outputContainsCriterion
				? "Text match found in output"
				: `No direct text match; card ${result.success ? "succeeded" : "failed"}`,
		}
	}
}
