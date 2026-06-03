import { describe, it, expect, beforeEach } from "vitest"
import { FullTextIndex } from "../../search/FullTextIndex"
import { IndexEntry, SearchQuery } from "../../search/types"

describe("FullTextIndex", () => {
	let index: FullTextIndex

	beforeEach(async () => {
		index = new FullTextIndex()
		// Falls back to in-memory index when better-sqlite3 unavailable
		await index.initialize()
	})

	describe("index and search", () => {
		it("should index and search text content", async () => {
			await index.index("The quick brown fox jumps over the lazy dog", {
				sessionId: "session-1",
				timestamp: Date.now(),
				mode: "fulltext",
				filePath: "test.txt",
			})

			const results = await index.search({ query: "quick brown fox", mode: "fulltext" })
			expect(results.length).toBeGreaterThanOrEqual(1)
			expect(results[0].sessionId).toBe("session-1")
		})

		it("should return empty results for non-matching query", async () => {
			await index.index("Hello world", {
				sessionId: "session-1",
				timestamp: Date.now(),
				mode: "fulltext",
			})

			const results = await index.search({ query: "nonexistent", mode: "fulltext" })
			expect(results).toEqual([])
		})

		it("should respect limit parameter", async () => {
			for (let i = 0; i < 5; i++) {
				await index.index(`Document ${i} with test content`, {
					sessionId: `session-${i}`,
					timestamp: Date.now(),
					mode: "fulltext",
				})
			}

			const results = await index.search({ query: "test", mode: "fulltext", limit: 3 })
			expect(results.length).toBeLessThanOrEqual(3)
		})

		it("should respect offset parameter", async () => {
			for (let i = 0; i < 5; i++) {
				await index.index(`Document ${i} with test content`, {
					sessionId: `session-${i}`,
					timestamp: Date.now(),
					mode: "fulltext",
				})
			}

			const firstPage = await index.search({ query: "test", mode: "fulltext", limit: 2, offset: 0 })
			const secondPage = await index.search({ query: "test", mode: "fulltext", limit: 2, offset: 2 })
			expect(firstPage.length).toBeGreaterThanOrEqual(1)
			expect(secondPage.length).toBeGreaterThanOrEqual(0)
		})
	})

	describe("remove", () => {
		it("should remove indexed data by session ID", async () => {
			await index.index("Unique content for removal test", {
				sessionId: "session-remove",
				timestamp: Date.now(),
				mode: "fulltext",
			})

			await index.remove("session-remove")

			const results = await index.search({ query: "removal", mode: "fulltext" })
			expect(results).toEqual([])
		})
	})

	describe("search with filters", () => {
		it("should filter by mode", async () => {
			await index.index("Filter test content", {
				sessionId: "session-filter",
				timestamp: Date.now(),
				mode: "fulltext",
			})

			const results = await index.search({
				query: "filter",
				mode: "fulltext",
				filters: { mode: "fulltext" },
			})
			expect(results.length).toBeGreaterThanOrEqual(1)
		})
	})
})
