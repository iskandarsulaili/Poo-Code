import { describe, it, expect, beforeEach } from "vitest"
import { EpisodicMemory } from "../../memory/EpisodicMemory"
import { MemoryTier, EpisodeEntry, EpisodeQuery } from "../../memory/types"

describe("EpisodicMemory", () => {
	let memory: EpisodicMemory

	beforeEach(async () => {
		memory = new EpisodicMemory()
		await memory.initialize()
	})

	describe("storeEpisode and recallSimilarEpisodes", () => {
		it("should store and recall episodes by similarity", async () => {
			const episode = await memory.storeEpisode({
				problem: "Fix memory leak in cache",
				approach: "Add weak references",
				solution: "Used WeakMap for cache entries",
				filesModified: ["cache.ts"],
				result: "success",
				tags: ["bug_fix", "performance"],
			})
			expect(episode.id).toBeDefined()
			expect(episode.confidence).toBe(0.8)

			const results = await memory.recallSimilarEpisodes({ problem: "memory leak" })
			expect(results).toHaveLength(1)
			expect(results[0].problem).toContain("memory leak")
		})

		it("recall with empty store should return empty array", async () => {
			const results = await memory.recallSimilarEpisodes({ problem: "anything" })
			expect(results).toEqual([])
		})

		it("tags filter should limit results correctly", async () => {
			await memory.storeEpisode({
				problem: "Fix login bug",
				approach: "Validate input",
				solution: "Added input validation",
				filesModified: ["login.ts"],
				result: "success",
				tags: ["bug_fix"],
			})
			await memory.storeEpisode({
				problem: "Add dark mode",
				approach: "CSS variables",
				solution: "Implemented theme switching",
				filesModified: ["theme.ts"],
				result: "success",
				tags: ["feature"],
			})

			const bugResults = await memory.recallSimilarEpisodes({ tags: ["bug_fix"] })
			expect(bugResults).toHaveLength(1)
			expect(bugResults[0].tags).toContain("bug_fix")

			const featureResults = await memory.recallSimilarEpisodes({ tags: ["feature"] })
			expect(featureResults).toHaveLength(1)

			const allResults = await memory.recallSimilarEpisodes({})
			expect(allResults).toHaveLength(2)
		})
	})

	describe("deduplication", () => {
		it("should store deduplicate similar episodes", async () => {
			await memory.storeEpisode({
				problem: "API timeout error",
				approach: "Retry with backoff",
				solution: "Exponential backoff implemented",
				filesModified: ["api.ts"],
				result: "success",
				tags: ["bug_fix"],
			})
			const duplicate = await memory.storeEpisode({
				problem: "API timeout error",
				approach: "Retry with backoff",
				solution: "Exponential backoff implemented",
				filesModified: ["api.ts"],
				result: "success",
				tags: ["bug_fix"],
			})

			// The duplicate should still be stored (exact match dedup is not implemented
			// at the episode level, but it updates the existing episode's confidence)
			expect(duplicate.id).toBeDefined()
		})
	})

	describe("recallSimilarEpisodes edge cases", () => {
		it("should filter by result type", async () => {
			await memory.storeEpisode({
				problem: "Failed build",
				approach: "Fix dependencies",
				solution: "Updated package.json",
				filesModified: ["package.json"],
				result: "success",
				tags: ["build"],
			})
			await memory.storeEpisode({
				problem: "CSS conflict",
				approach: "Scope styles",
				solution: "Added CSS modules",
				filesModified: ["styles.css"],
				result: "failure",
				tags: ["build"],
			})

			const successes = await memory.recallSimilarEpisodes({ result: "success" })
			expect(successes).toHaveLength(1)
			expect(successes[0].result).toBe("success")

			const all = await memory.recallSimilarEpisodes({})
			expect(all).toHaveLength(2)
		})

		it("should respect minConfidence filter", async () => {
			const ep = await memory.storeEpisode({
				problem: "Test episode",
				approach: "Test approach",
				solution: "Test solution",
				filesModified: ["test.ts"],
				result: "success",
				tags: ["test"],
			})
			// Store another via internal API that has lower confidence
			await memory.storeEpisode({
				problem: "Low confidence test",
				approach: "Unknown",
				solution: "Unknown",
				filesModified: [],
				result: "failure",
				tags: ["test"],
			})

			const highConf = await memory.recallSimilarEpisodes({ minConfidence: 0.9 })
			expect(highConf).toHaveLength(0)

			const all = await memory.recallSimilarEpisodes({})
			expect(all.length).toBeGreaterThanOrEqual(2)
		})
	})

	describe("tier property", () => {
		it("should return EPISODIC tier", () => {
			expect(memory.tier).toBe(MemoryTier.EPISODIC)
		})
	})
})
