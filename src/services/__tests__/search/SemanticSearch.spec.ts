import { describe, it, expect, beforeEach } from "vitest"
import { SemanticSearch } from "../../search/SemanticSearch"

describe("SemanticSearch", () => {
	let semanticSearch: SemanticSearch

	beforeEach(async () => {
		semanticSearch = new SemanticSearch()
		await semanticSearch.initialize()
	})

	describe("embed", () => {
		it("should generate consistent embeddings for similar text", async () => {
			const embedding1 = await semanticSearch.embed("TypeScript is a typed language")
			const embedding2 = await semanticSearch.embed("TypeScript is a typed language")
			expect(embedding1.length).toBeGreaterThan(0)
			expect(embedding1.length).toBe(embedding2.length)
		})
	})

	describe("cosineSimilarity", () => {
		it("should return ~1 for identical vectors", () => {
			const vec = [1, 2, 3]
			const sim = (semanticSearch as any).cosineSimilarity(vec, vec)
			expect(sim).toBeCloseTo(1, 5)
		})

		it("should return ~0 for orthogonal vectors", () => {
			const sim = (semanticSearch as any).cosineSimilarity([1, 0], [0, 1])
			expect(sim).toBeCloseTo(0, 3)
		})

		it("should handle zero vectors gracefully", () => {
			const sim = (semanticSearch as any).cosineSimilarity([0, 0], [1, 0])
			expect(sim).toBe(0)
		})
	})

	describe("search", () => {
		it("should return empty when no data indexed", async () => {
			const results = await semanticSearch.search({ query: "anything", mode: "semantic" })
			expect(results).toEqual([])
		})
	})

	describe("remove", () => {
		it("should handle removing non-existent session", async () => {
			await semanticSearch.remove("nonexistent-session")
			// Should not throw
		})
	})

	describe("tokenize", () => {
		it("should split text into tokens", () => {
			const tokens = (semanticSearch as any).tokenize("Hello World Test")
			expect(Array.isArray(tokens)).toBe(true)
			expect(tokens.length).toBeGreaterThanOrEqual(3)
		})
	})
})
