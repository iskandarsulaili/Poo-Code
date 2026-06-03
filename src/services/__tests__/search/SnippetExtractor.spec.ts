import { describe, it, expect } from "vitest"
import { SnippetExtractor } from "../../search/SnippetExtractor"

describe("SnippetExtractor", () => {
	const extractor = new SnippetExtractor()

	describe("extractSnippets", () => {
		it("should extract relevant snippets for a query", () => {
			const content = "The quick brown fox jumps over the lazy dog. The dog was not amused."
			const snippets = extractor.extractSnippets(content, "fox jumps")
			expect(snippets.length).toBeGreaterThanOrEqual(1)
			expect(snippets[0].text).toContain("fox")
		})

		it("should return empty array for empty query", () => {
			const snippets = extractor.extractSnippets("Some content", "")
			expect(snippets).toEqual([])
		})

		it("should sort by relevance descending", () => {
			const content = "test test test. Something else. test again."
			const snippets = extractor.extractSnippets(content, "test")
			expect(snippets.length).toBeGreaterThanOrEqual(1)
			// Higher relevance snippets should come first
			for (let i = 1; i < snippets.length; i++) {
				expect(snippets[i - 1].relevance).toBeGreaterThanOrEqual(snippets[i].relevance)
			}
		})

		it("should respect maxLength parameter", () => {
			const content = "The quick brown fox jumps over the lazy dog near the riverbank"
			const snippets = extractor.extractSnippets(content, "fox", 50)
			expect(snippets[0].text.length).toBeLessThanOrEqual(50)
		})
	})

	describe("extractGoalResolution", () => {
		it("should extract goal from beginning of content", () => {
			const content = [
				"Can you help me fix this bug?",
				"The error is in the login module.",
				"Here is the stack trace:",
				"Error: Cannot read property",
			].join("\n")
			const { goal, resolution } = extractor.extractGoalResolution(content)
			expect(goal).toContain("fix this bug")
		})

		it("should extract resolution from end of content", () => {
			const content = [
				"Fix the login bug",
				"Let me check the code",
				"I've fixed the issue by validating input",
				"The bug is now resolved and tests pass",
			].join("\n")
			const { goal, resolution } = extractor.extractGoalResolution(content)
			expect(resolution).toBeTruthy()
		})

		it("should handle empty content", () => {
			const { goal, resolution } = extractor.extractGoalResolution("")
			expect(goal).toBe("")
			expect(resolution).toBe("")
		})

		it("should skip system/technical lines for goal extraction", () => {
			const content = ["```", "const x = 1", "Can you refactor this component?"].join("\n")
			const { goal } = extractor.extractGoalResolution(content)
			expect(goal).toContain("refactor")
		})
	})

	describe("highlightMatches", () => {
		it("should highlight matching terms in snippet", () => {
			const result = extractor.highlightMatches("The quick brown fox", "fox")
			expect(result.highlights.length).toBeGreaterThanOrEqual(1)
			expect(result.highlights[0].start).toBeGreaterThanOrEqual(0)
			expect(result.highlights[0].end).toBeGreaterThan(result.highlights[0].start)
		})

		it("should handle no matches", () => {
			const result = extractor.highlightMatches("Hello world", "xyz")
			expect(result.highlights).toEqual([])
		})

		it("should handle multiple matches", () => {
			const result = extractor.highlightMatches("test test test", "test")
			expect(result.highlights.length).toBe(3)
		})
	})
})
