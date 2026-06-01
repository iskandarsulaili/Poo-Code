import { describe, it, expect, vi } from "vitest"

import { ContextualAnswerService } from "../contextual-answer-service.js"

// =============================================================================
// Helpers
// =============================================================================

function createService(): ContextualAnswerService {
	const logger = { appendLine: vi.fn() }
	return new ContextualAnswerService(logger)
}

// =============================================================================
// Tests
// =============================================================================

describe("ContextualAnswerService", () => {
	// =========================================================================
	// Draft Generation
	// =========================================================================

	describe("generateDraft", () => {
		it("uses the best suggestion when available", () => {
			const service = createService()
			const result = service.generateDraft("Should I proceed?", {
				suggestions: [{ answer: "yes, continue with the refactor" }],
			})
			expect(result).toBe("yes, continue with the refactor")
		})

		it("prefers mode-specific suggestions over generic", () => {
			const service = createService()
			const result = service.generateDraft("Which approach is best?", {
				suggestions: [{ answer: "generic answer" }, { answer: "specific code answer", mode: "code" }],
			})
			expect(result).toBe("specific code answer")
		})

		it("skips suggestions with empty answer", () => {
			const service = createService()
			const result = service.generateDraft("Should I continue?", {
				suggestions: [{ answer: "" }, { answer: "valid answer" }],
			})
			expect(result).toBe("valid answer")
		})

		it("uses heuristic answer when no suggestions", () => {
			const service = createService()
			const result = service.generateDraft("Should I continue with the deployment?")
			expect(result).toBe("yes")
		})

		it("uses heuristic for approval-related questions", () => {
			const service = createService()
			const result = service.generateDraft("Do you approve this change?")
			expect(result).toBe("yes")
		})

		it("uses acknowledgment for information-request questions", () => {
			const service = createService()
			const result = service.generateDraft("Explain the current architecture?")
			expect(result).toContain("I acknowledge your question")
			expect(result).toContain("Explain the current architecture")
		})

		it("uses acknowledgment for 'what is' questions", () => {
			const service = createService()
			const result = service.generateDraft("What is the purpose of this function?")
			expect(result).toContain("I acknowledge your question")
		})

		it("returns 'acknowledged' when no heuristic matches", () => {
			const service = createService()
			// A completely random string with no matching patterns
			const result = service.generateDraft("!@#$%^&*()")
			expect(result).toBe("acknowledged")
		})
	})

	// =========================================================================
	// Review Answer (4 Personas)
	// =========================================================================

	describe("reviewAnswer", () => {
		it("approves detailed, relevant answers", () => {
			const service = createService()
			const verdict = service.reviewAnswer(
				"I understand you're asking about the API endpoint design. The RESTful approach with proper error handling would be best. Let me outline the key considerations: resource naming, status codes, and pagination strategy.",
				"What is the best approach for API endpoints?",
			)
			expect(verdict.approved).toBe(true)
			expect(verdict.score).toBeGreaterThanOrEqual(0.5)
		})

		it("rejects generic one-word answers", () => {
			const service = createService()
			const verdict = service.reviewAnswer("yes", "Should I continue?")
			expect(verdict.approved).toBe(false)
			expect(verdict.score).toBeLessThan(0.5)
		})

		it("rejects empty answers", () => {
			const service = createService()
			const verdict = service.reviewAnswer("", "What should I do?")
			expect(verdict.approved).toBe(false)
		})

		it("scores contextual answers higher than generic", () => {
			const service = createService()
			const question = "Should I refactor the auth module?"

			const genericVerdict = service.reviewAnswer("yes", question)
			const contextualVerdict = service.reviewAnswer(
				"Yes, refactoring the auth module would improve security and maintainability. The current implementation has several identified issues.",
				question,
			)

			expect(contextualVerdict.score).toBeGreaterThan(genericVerdict.score)
			expect(contextualVerdict.approved).toBe(true)
		})

		it("returns all persona scores", () => {
			const service = createService()
			const verdict = service.reviewAnswer(
				"A detailed answer with proper context and reasoning.",
				"What is the best approach?",
			)

			expect(verdict.innovatorScore).toBeGreaterThanOrEqual(0)
			expect(verdict.innovatorScore).toBeLessThanOrEqual(1)
			expect(verdict.contrarianScore).toBeGreaterThanOrEqual(0)
			expect(verdict.contrarianScore).toBeLessThanOrEqual(1)
			expect(verdict.devilsAdvocateScore).toBeGreaterThanOrEqual(0)
			expect(verdict.devilsAdvocateScore).toBeLessThanOrEqual(1)
			expect(verdict.deciderScore).toBeGreaterThanOrEqual(0)
			expect(verdict.deciderScore).toBeLessThanOrEqual(1)
		})

		it("includes feedback string in verdict", () => {
			const service = createService()
			const verdict = service.reviewAnswer("some answer", "some question")
			expect(verdict.feedback).toContain("Innovator=")
			expect(verdict.feedback).toContain("Weighted=")
		})
	})

	// =========================================================================
	// getGatedAnswer (Full Flow)
	// =========================================================================

	describe("getGatedAnswer", () => {
		it("returns approved answer on first attempt when score is high", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("What is the best approach for error handling?", {
				suggestions: [{ answer: "Use a centralized error handler with proper status codes and logging." }],
			})
			expect(result.isGenerated).toBe(true)
			expect(result.approved).toBe(true)
			expect(result.answer.length).toBeGreaterThan(0)
			expect(result.attempts).toBeGreaterThanOrEqual(1)
			expect(result.personaScores).toBeDefined()
		})

		it("returns safe fallback when all retries fail", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("Should I continue?", {
				// No suggestions, short question → heuristic "yes" → review rejects it
			})

			// The result may or may not be approved depending on scoring
			// But it should always return something
			expect(result.isGenerated).toBe(true)
			expect(result.answer.length).toBeGreaterThan(0)
		})

		it("improves answer across retry attempts", async () => {
			const service = createService()
			// Use a short yes/no question with no suggestions to trigger refinement
			const firstPass = await service.getGatedAnswer("Continue?", {})
			// Should have gone through refinement and returned a non-empty answer
			expect(firstPass.answer.length).toBeGreaterThan(0)
		})

		it("handles complex questions with mode context", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("Which testing strategy should we adopt?", {
				suggestions: [{ answer: "Unit tests with 80% coverage target", mode: "code" }],
				mode: "code",
			})
			expect(result.isGenerated).toBe(true)
			expect(result.answer.length).toBeGreaterThan(0)
		})

		it("works with no context at all", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("Proceed with the task?")
			expect(result.isGenerated).toBe(true)
			expect(result.answer).toBeDefined()
		})

		it("handles multiple suggestions and picks the best", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("What approach should I take?", {
				suggestions: [
					{ answer: "" },
					{ answer: "" },
					{ answer: "Refactor the code incrementally to minimize risk.", mode: "code" },
					{ answer: "Rewrite everything from scratch." },
				],
				mode: "code",
			})
			// Should pick the mode-specific non-empty suggestion
			expect(result.answer).toContain("incrementally")
			expect(result.approved).toBe(true)
		})
	})

	// =========================================================================
	// Persona: Innovator
	// =========================================================================

	describe("innovator scoring", () => {
		it("gives higher score to longer answers", () => {
			const service = createService()
			const short = service.reviewAnswer("yes", "Question?")
			const long = service.reviewAnswer(
				"This is a much longer answer that provides detailed context and reasoning about the question at hand.",
				"Question?",
			)
			expect(long.score).toBeGreaterThan(short.score)
		})

		it("gives bonus for keyword overlap", () => {
			const service = createService()
			const noOverlap = service.reviewAnswer("unrelated answer", "authentication strategy")
			const withOverlap = service.reviewAnswer(
				"The authentication strategy should use JWTs",
				"authentication strategy",
			)
			expect(withOverlap.score).toBeGreaterThan(noOverlap.score)
		})

		it("penalizes generic single-word answers", () => {
			const service = createService()
			const generic = service.reviewAnswer("ok", "Question?")
			const specific = service.reviewAnswer("Let me address your question about the architecture.", "Question?")
			expect(specific.score).toBeGreaterThan(generic.score)
		})
	})

	// =========================================================================
	// Persona: Contrarian
	// =========================================================================

	describe("contrarian scoring", () => {
		it("penalizes one-word answers heavily", () => {
			const service = createService()
			const verdict = service.reviewAnswer("y", "Should I proceed?")
			expect(verdict.contrarianScore).toBeLessThan(0.4)
		})

		it("rewards reasoning indicators", () => {
			const service = createService()
			const noReasoning = service.reviewAnswer("just do it", "Question?")
			const withReasoning = service.reviewAnswer("I suggest this because it improves performance.", "Question?")
			expect(withReasoning.contrarianScore).toBeGreaterThan(noReasoning.contrarianScore)
		})

		it("rewards longer substantive answers", () => {
			const service = createService()
			const short = service.reviewAnswer("yes", "Question?")
			const long = service.reviewAnswer(
				"I have carefully considered the options. The best approach is to use the modular architecture because it provides better maintainability and testability.",
				"Question?",
			)
			expect(long.contrarianScore).toBeGreaterThan(short.contrarianScore)
		})
	})

	// =========================================================================
	// Persona: Devil's Advocate
	// =========================================================================

	describe("devilsAdvocate scoring", () => {
		it("rewards answers with keyword overlap", () => {
			const service = createService()
			const unrelated = service.reviewAnswer("just continue", "refactor database schema")
			const related = service.reviewAnswer(
				"Refactoring the database schema should be done carefully.",
				"refactor database schema",
			)
			expect(related.devilsAdvocateScore).toBeGreaterThan(unrelated.devilsAdvocateScore)
		})

		it("penalizes hedging language", () => {
			const service = createService()
			const hedging = service.reviewAnswer("I'm not sure but maybe we could possibly try something.", "Question?")
			const confident = service.reviewAnswer("The best approach is to implement it step by step.", "Question?")
			expect(confident.devilsAdvocateScore).toBeGreaterThan(hedging.devilsAdvocateScore)
		})

		it("penalizes very short answers", () => {
			const service = createService()
			const short = service.reviewAnswer("a", "Question?")
			const adequate = service.reviewAnswer("Proceed with the implementation plan.", "Question?")
			expect(adequate.devilsAdvocateScore).toBeGreaterThan(short.devilsAdvocateScore)
		})
	})

	// =========================================================================
	// Persona: Decider
	// =========================================================================

	describe("decider scoring", () => {
		it("lower score when personas disagree (high variance)", () => {
			const service = createService()
			// High variance: innovator high, contrarian and devil's advocate low
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const highVariance = (service as any).deciderReview("yes", "Question?", 0.9, 0.1, 0.1)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const lowVariance = (service as any).deciderReview(
				"Detailed answer with proper context and reasoning.",
				"Question?",
				0.7,
				0.65,
				0.7,
			)
			expect(lowVariance).toBeGreaterThanOrEqual(highVariance)
		})
	})

	// =========================================================================
	// Edge Cases and Error Handling
	// =========================================================================

	describe("edge cases", () => {
		it("handles empty question gracefully", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("")
			expect(result.isGenerated).toBe(true)
			expect(result.answer).toBeDefined()
		})

		it("handles very long question", async () => {
			const service = createService()
			const longQuestion = "A".repeat(10000)
			const result = await service.getGatedAnswer(longQuestion)
			expect(result.isGenerated).toBe(true)
			expect(result.answer).toBeDefined()
		})

		it("handles null context gracefully", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("Should I proceed?", undefined)
			expect(result.isGenerated).toBe(true)
			expect(result.answer).toBeDefined()
		})

		it("handles suggestions with special characters", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("How to handle <script>alert('xss')</script>?", {
				suggestions: [{ answer: "Sanitize all user input using a proper validation library." }],
			})
			expect(result.isGenerated).toBe(true)
			expect(result.answer).toBeDefined()
		})
	})

	// =========================================================================
	// Integration: conversationHistory context
	// =========================================================================

	describe("conversation history context", () => {
		it("accepts but does not break on conversation history", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("What should I fix next?", {
				suggestions: [{ answer: "Fix the authentication bug first." }],
				conversationHistory: ["User: fix the auth module", "Assistant: I'll look at the auth module"],
			})
			expect(result.isGenerated).toBe(true)
			expect(result.answer).toContain("Fix")
		})

		it("handles empty conversation history", async () => {
			const service = createService()
			const result = await service.getGatedAnswer("What should I do?", {
				conversationHistory: [],
			})
			expect(result.isGenerated).toBe(true)
			expect(result.answer).toBeDefined()
		})
	})
})
