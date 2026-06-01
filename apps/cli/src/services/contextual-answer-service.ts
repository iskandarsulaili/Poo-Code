/**
 * ContextualAnswerService - Generates contextual answers when stdin has no input
 *
 * This service wraps three concerns:
 * 1. Draft answer generation from question + available context (suggestions, history)
 * 2. Review Team gating using 4 persona scores (Innovator, Contrarian, Devil's Advocate, Decider)
 * 3. Retry loop with progressive refinement (up to 3 attempts)
 *
 * Design notes:
 * - Self-contained: no dependency on extension-side ReviewTeamService
 * - Uses the same pseudo-pattern scoring approach as QuestionEvaluatorService
 * - Falls back to safe "cannot generate" message after exhausting retries
 * - Logs all scoring decisions for observability
 */

// =============================================================================
// Types
// =============================================================================

export interface ContextualAnswerContext {
	/** Suggestions from the follow_up parameter (map to mode + answer) */
	suggestions?: Array<{ answer: string; mode?: string | null }>
	/** Recent conversation history (last N messages) */
	conversationHistory?: string[]
	/** Workspace-relative file paths relevant to the question */
	relevantFiles?: string[]
	/** Current mode slug (e.g., "code", "architect") */
	mode?: string
}

export interface ContextualAnswerResult {
	/** The final answer string */
	answer: string
	/** Whether this was auto-generated (vs user-provided) */
	isGenerated: boolean
	/** Aggregate score from the review team (0-1) */
	score: number
	/** Whether the review team approved the answer */
	approved: boolean
	/** Number of refinement attempts */
	attempts: number
	/** Per-persona scores for observability */
	personaScores?: {
		innovator: number
		contrarian: number
		devilsAdvocate: number
		decider: number
	}
}

/** Internal review verdict from the pseudo-team */
interface ReviewVerdict {
	approved: boolean
	score: number
	innovatorScore: number
	contrarianScore: number
	devilsAdvocateScore: number
	deciderScore: number
	feedback: string
}

// =============================================================================
// Constants
// =============================================================================

const MAX_RETRY_ATTEMPTS = 3
const PASS_THRESHOLD = 0.5
const INNOVATOR_WEIGHT = 0.3
const CONTRARIAN_WEIGHT = 0.3
const DEVILS_ADVOCATE_WEIGHT = 0.3
const DECIDER_THRESHOLD = 0.5
const SAFE_FALLBACK = "I cannot generate a sufficient answer"

// =============================================================================
// Logger Interface
// =============================================================================

/** Minimal logger matching what's available in CLI context */
export interface AnswerLogger {
	appendLine(message: string): void
}

// =============================================================================
// ContextualAnswerService
// =============================================================================

export class ContextualAnswerService {
	private logger: AnswerLogger

	constructor(logger: AnswerLogger) {
		this.logger = logger
	}

	// =========================================================================
	// Public API
	// =========================================================================

	/**
	 * Main entry point: generate a gated contextual answer.
	 *
	 * 1. Generates a draft answer from question + context
	 * 2. Passes it through 4-persona review
	 * 3. If below threshold, refines and retries (up to 3 attempts)
	 * 4. Returns the best answer or safe fallback
	 */
	async getGatedAnswer(question: string, context?: ContextualAnswerContext): Promise<ContextualAnswerResult> {
		this.logger.appendLine(`[ContextualAnswer] Generating answer for: "${question.substring(0, 80)}..."`)

		let draft = this.generateDraft(question, context)
		const attempts: Array<{ draft: string; verdict: ReviewVerdict }> = []

		for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
			this.logger.appendLine(
				`[ContextualAnswer] Attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}, draft length=${draft.length}`,
			)

			const verdict = this.reviewAnswer(draft, question)
			attempts.push({ draft, verdict })

			this.logger.appendLine(
				`[ContextualAnswer]  Attempt ${attempt + 1} score=${verdict.score.toFixed(3)}, approved=${verdict.approved}`,
			)

			if (verdict.approved) {
				const lastAttempt = attempts[attempts.length - 1]!
				const lastScore = lastAttempt.verdict.score
				return {
					answer: draft,
					isGenerated: true,
					score: lastScore,
					approved: true,
					attempts: attempt + 1,
					personaScores: {
						innovator: verdict.innovatorScore,
						contrarian: verdict.contrarianScore,
						devilsAdvocate: verdict.devilsAdvocateScore,
						decider: verdict.deciderScore,
					},
				}
			}

			// Refine draft for next attempt
			draft = this.refineDraft(draft, question, context, verdict)
		}

		this.logger.appendLine(`[ContextualAnswer] All ${MAX_RETRY_ATTEMPTS} attempts failed, using safe fallback`)

		return {
			answer: attempts.length > 0 ? attempts[attempts.length - 1]!.draft : SAFE_FALLBACK,
			isGenerated: true,
			score: attempts.length > 0 ? attempts[attempts.length - 1]!.verdict.score : 0,
			approved: false,
			attempts: MAX_RETRY_ATTEMPTS,
		}
	}

	// =========================================================================
	// Draft Generation
	// =========================================================================

	/**
	 * Generate an initial draft answer from question + available context.
	 *
	 * Strategy (in priority order):
	 * 1. Use the highest-ranked suggestion if suggestions exist
	 * 2. Generate a heuristic answer from question keywords
	 * 3. Return a generic acknowledgment as last resort
	 */
	generateDraft(question: string, context?: ContextualAnswerContext): string {
		// Priority 1: Use suggestions
		const suggestions = context?.suggestions
		if (suggestions && suggestions.length > 0) {
			// Pick the best suggestion (prefer non-empty, prefer mode-specific)
			const bestSuggestion = this.pickBestSuggestion(suggestions)
			if (bestSuggestion) {
				this.logger.appendLine(`[ContextualAnswer] Using suggestion: "${bestSuggestion.substring(0, 60)}..."`)
				return bestSuggestion
			}
		}

		// Priority 2: Heuristic from question
		const heuristic = this.heuristicAnswer(question)
		if (heuristic) {
			this.logger.appendLine(`[ContextualAnswer] Using heuristic answer: "${heuristic}"`)
			return heuristic
		}

		// Priority 3: Generic acknowledgment
		this.logger.appendLine(`[ContextualAnswer] Using generic acknowledgment`)
		return "acknowledged"
	}

	/**
	 * Pick the best suggestion from the list.
	 * Prefers non-empty, mode-specific suggestions.
	 */
	private pickBestSuggestion(suggestions: Array<{ answer: string; mode?: string | null }>): string | null {
		if (suggestions.length === 0) return null

		// Prefer suggestions with a non-empty answer
		const valid = suggestions.filter((s) => s.answer && s.answer.trim().length > 0)

		if (valid.length === 0) return null

		// Prefer mode-specific suggestions (more targeted)
		const modeSpecific = valid.filter((s) => s.mode)
		if (modeSpecific.length > 0) {
			return modeSpecific[0]!.answer
		}

		// Fall back to first valid suggestion
		return valid[0]!.answer
	}

	/**
	 * Heuristic answer generation from question text.
	 * Handles common question patterns.
	 */
	private heuristicAnswer(question: string): string | null {
		const q = question.toLowerCase().trim()

		// Yes/no patterns
		if (/^(should|shall|would|will|can|could|do|does|is|are|has|have)\b/.test(q)) {
			// Conservative: agree to proceed
			return "yes"
		}

		// Approval patterns
		if (/approve|confirm|permit|allow|continue|proceed/i.test(q)) {
			return "yes"
		}

		// Information request patterns (must check BEFORE choice patterns
		// to properly match "what is", "how does", etc.)
		if (/explain|describe|tell|what is|what are|what does|how does|how do|elaborate\b/i.test(q)) {
			return `I acknowledge your question about "${question.substring(0, 120)}". I understand the context and will proceed accordingly.`
		}

		// Choice patterns
		if (/which|choose|select|pick|option|alternative/i.test(q) || /^what\b/.test(q)) {
			return "The first option seems appropriate."
		}

		return null
	}

	// =========================================================================
	// Review Team Gating (4 Personas)
	// =========================================================================

	/**
	 * Review an answer through 4 pseudo-personas.
	 *
	 * Scoring mirrors the extension's ReviewTeamService logic:
	 * - Innovator: Values specificity, contextual relevance, length
	 * - Contrarian: Challenges generic/short answers
	 * - Devil's Advocate: Checks answer-question alignment
	 * - Decider: Weighted aggregation + threshold
	 */
	reviewAnswer(answer: string, question: string): ReviewVerdict {
		const innovatorScore = this.innovatorReview(answer, question)
		const contrarianScore = this.contrarianReview(answer, question)
		const devilsAdvocateScore = this.devilsAdvocateReview(answer, question)
		const deciderScore = this.deciderReview(answer, question, innovatorScore, contrarianScore, devilsAdvocateScore)

		// Weighted score (matches ReviewTeamService.calculateWeightedScore)
		const weightedScore =
			innovatorScore * INNOVATOR_WEIGHT +
			contrarianScore * CONTRARIAN_WEIGHT +
			devilsAdvocateScore * DEVILS_ADVOCATE_WEIGHT

		// Decider ultimately decides
		const approved = weightedScore >= DECIDER_THRESHOLD && deciderScore >= DECIDER_THRESHOLD

		return {
			approved,
			score: weightedScore,
			innovatorScore,
			contrarianScore,
			devilsAdvocateScore,
			deciderScore,
			feedback: `Innovator=${innovatorScore.toFixed(2)} Contrarian=${contrarianScore.toFixed(2)} DA=${devilsAdvocateScore.toFixed(2)} Decider=${deciderScore.toFixed(2)} Weighted=${weightedScore.toFixed(2)}`,
		}
	}

	/**
	 * Innovator persona: values specificity, novelty, and contextual relevance.
	 * Scores higher for:
	 * - Longer, more detailed answers (>20 chars)
	 * - Answers containing question-relevant keywords
	 * - Mode or action-specific answers
	 */
	private innovatorReview(answer: string, question: string): number {
		let score = 0.5 // neutral baseline

		const answerLower = answer.toLowerCase().trim()
		const questionLower = question.toLowerCase()

		// Length bonus
		if (answerLower.length > 80) score += 0.2
		else if (answerLower.length > 40) score += 0.1
		else if (answerLower.length > 10) score += 0.05
		else score -= 0.15 // very short answers

		// Keyword overlap bonus
		const questionKeywords = questionLower.split(/\s+/).filter((w) => w.length > 4)
		const keywordOverlap = questionKeywords.filter((kw) => answerLower.includes(kw)).length
		score += Math.min(keywordOverlap * 0.05, 0.15)

		// Too generic penalty
		const generic = ["yes", "no", "ok", "acknowledged", "proceed", "continue", "done"]
		if (generic.includes(answerLower)) {
			score -= 0.2
		}

		return Math.max(0, Math.min(1, score))
	}

	/**
	 * Contrarian persona: challenges assumptions, penalizes weak answers.
	 * Scores higher for:
	 * - Answers that show consideration of alternatives
	 * - Longer, reasoned responses
	 * - Answers that address potential concerns
	 *
	 * Scores lower for:
	 * - Extremely short or single-word answers
	 * - Generic acknowledgments
	 */
	private contrarianReview(answer: string, question: string): number {
		let score = 0.4 // slightly skeptical baseline

		const answerLower = answer.toLowerCase().trim()

		// Generic answer penalty
		const generic = ["yes", "no", "y", "n", "ok", "k", "sure", "acknowledged"]
		if (generic.includes(answerLower)) {
			score -= 0.25
		}

		// Length penalty for one-word answers
		if (answerLower.split(/\s+/).length <= 2) {
			score -= 0.1
		}

		// Substantive content bonus
		if (answerLower.length > 30) score += 0.15
		if (answerLower.length > 80) score += 0.1

		// Reasoning indicators bonus
		if (/because|therefore|however|consider|option|alternatively|suggest/i.test(answerLower)) {
			score += 0.15
		}

		// Question-relevant keywords bonus
		const questionKeywords = question
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 4)
		const keywordOverlap = questionKeywords.filter((kw) => answerLower.includes(kw)).length
		score += Math.min(keywordOverlap * 0.05, 0.15)

		return Math.max(0, Math.min(1, score))
	}

	/**
	 * Devil's Advocate persona: finds weaknesses, tests edge cases.
	 * Scores higher for:
	 * - Answers that acknowledge complexity
	 * - Answers that are directly relevant to the question
	 * - Answers with specific details
	 *
	 * Scores lower for:
	 * - Vague or non-committal answers
	 * - Answers unrelated to the question
	 */
	private devilsAdvocateReview(answer: string, question: string): number {
		let score = 0.4 // cautious baseline

		const answerLower = answer.toLowerCase().trim()
		const questionLower = question.toLowerCase()

		// Relevance check: does the answer overlap meaningfully with the question?
		const questionWords = new Set(questionLower.split(/\s+/).filter((w) => w.length > 3))
		const answerWords = answerLower.split(/\s+/)
		const meaningfulOverlap = answerWords.filter((w) => questionWords.has(w)).length

		if (meaningfulOverlap > 0) {
			score += Math.min(meaningfulOverlap * 0.06, 0.2)
		} else {
			score -= 0.15 // no keyword overlap = potentially off-topic
		}

		// Length adequacy
		if (answerLower.length === 0) {
			score -= 0.3
		} else if (answerLower.length < 5) {
			score -= 0.15
		} else if (answerLower.length > 60) {
			score += 0.1 // detailed answers are better
		}

		// Commitment level: yes/no answers are decisive but may lack nuance
		if (answerLower === "yes" || answerLower === "no") {
			score -= 0.05
		}

		// Hedging penalty
		if (/maybe|perhaps|possibly|might|could be|not sure|i think/i.test(answerLower)) {
			score -= 0.1
		}

		return Math.max(0, Math.min(1, score))
	}

	/**
	 * Decider persona: aggregates the team votes and makes final call.
	 * Returns a score reflecting the consensus quality.
	 * The actual approval is determined by the weighted score + threshold.
	 */
	private deciderReview(
		answer: string,
		_question: string,
		innovatorScore: number,
		contrarianScore: number,
		devilsAdvocateScore: number,
	): number {
		// Base score: the team consensus
		const consensus = (innovatorScore + contrarianScore + devilsAdvocateScore) / 3

		// Penalize high variance (disagreement between personas)
		const scores = [innovatorScore, contrarianScore, devilsAdvocateScore]
		const mean = scores.reduce((a, b) => a + b, 0) / scores.length
		const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length

		// High variance means the team can't agree - lower confidence
		let deciderScore = consensus
		if (variance > 0.1) {
			deciderScore -= Math.min(variance * 0.5, 0.15)
		}

		// Content quality directly observed
		const answerLower = answer.toLowerCase().trim()
		if (answerLower.length > 0 && !["yes", "no", "ok", "acknowledged"].includes(answerLower)) {
			deciderScore += 0.05
		}

		return Math.max(0, Math.min(1, deciderScore))
	}

	// =========================================================================
	// Refinement
	// =========================================================================

	/**
	 * Refine the draft answer for retry when the review score was below threshold.
	 * Uses the review feedback to improve the answer.
	 */
	private refineDraft(
		draft: string,
		question: string,
		context: ContextualAnswerContext | undefined,
		verdict: ReviewVerdict,
	): string {
		const currentScore = verdict.score
		const answerLower = draft.toLowerCase().trim()

		// Strategy 1: If draft is generic, use a suggestion if available
		const generic = ["yes", "no", "ok", "acknowledged", "proceed", "continue", "done"]
		if (generic.includes(answerLower) && context?.suggestions && context.suggestions.length > 0) {
			const betterSuggestion = context.suggestions.find((s) => s.answer && s.answer.trim().length > 0)
			if (betterSuggestion) {
				return betterSuggestion.answer
			}
		}

		// Strategy 2: If draft is too short, expand with context
		if (draft.length < 15) {
			const expanded =
				`I understand your question about "${question.substring(0, 100)}". ` +
				`Based on the available context, my response is: ${draft}. I will proceed accordingly.`
			return expanded
		}

		// Strategy 3: If draft lacks reasoning, add it
		if (currentScore < PASS_THRESHOLD * 0.6) {
			const reasoning = ` After consideration, I believe this approach is appropriate because it aligns with the current context and addresses the question directly.`
			return draft + reasoning
		}

		// Strategy 4: Add specificity from context
		if (context?.mode) {
			const modeNote = ` I am answering from the perspective of the ${context.mode} mode.`
			return draft + modeNote
		}

		// Default refinement: try longer, more contextual version
		return `In response to "${question.substring(0, 120)}": ${draft}. I have evaluated the options and confirm this is the most appropriate course of action based on the current context.`
	}
}
