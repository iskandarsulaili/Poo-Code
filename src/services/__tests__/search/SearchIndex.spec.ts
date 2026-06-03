import { describe, it, expect, beforeEach } from "vitest"
import { SearchIndex } from "../../search/SearchIndex"

describe("SearchIndex", () => {
	let searchIndex: SearchIndex

	beforeEach(async () => {
		searchIndex = new SearchIndex()
		await searchIndex.initialize()
	})

	describe("search - no indexed data", () => {
		it("should return empty array when no data indexed", async () => {
			const results = await searchIndex.search({
				query: "anything",
				mode: "fulltext",
			})
			expect(results).toEqual([])
		})
	})

	describe("search - routing", () => {
		it("should route to fullTextIndex and return results", async () => {
			const fti = (searchIndex as any).fullTextIndex
			await fti.index("The quick brown fox jumps", {
				sessionId: "session-fts",
				timestamp: Date.now(),
				mode: "fulltext",
				filePath: "test.ts",
			})

			const results = await searchIndex.search({
				query: "quick brown",
				mode: "fulltext",
			})
			expect(results.length).toBeGreaterThanOrEqual(1)
			expect(results[0].sessionId).toBe("session-fts")
		})
	})

	describe("search - invalid mode", () => {
		it("should throw for unknown mode", async () => {
			await expect(
				searchIndex.search({
					query: "test",
					mode: "invalid" as any,
				}),
			).rejects.toThrow()
		})
	})
})
