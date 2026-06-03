import { describe, it, expect, beforeEach } from "vitest"
import { SemanticMemory } from "../../memory/SemanticMemory"
import { MemoryTier } from "../../memory/types"

describe("SemanticMemory", () => {
	let memory: SemanticMemory

	beforeEach(async () => {
		memory = new SemanticMemory()
		await memory.initialize()
	})

	describe("storePattern and queryPatterns", () => {
		it("should store and retrieve patterns", async () => {
			const stored = await memory.storePattern({
				description: "Users prefer dark mode",
				evidenceCount: 10,
				confidence: 0.85,
				lastReinforced: Date.now(),
				category: "preference",
				metadata: {},
			})
			expect(stored.id).toBeDefined()
			expect(stored.description).toBe("Users prefer dark mode")

			const results = await memory.queryPatterns({ category: "preference" })
			expect(results.length).toBeGreaterThanOrEqual(1)
			expect(results[0].description).toContain("dark mode")
		})

		it("should filter by minimum confidence", async () => {
			await memory.storePattern({
				description: "Quick brown fox jumps lazy dog",
				evidenceCount: 1,
				confidence: 0.3,
				lastReinforced: Date.now(),
				category: "fact",
				metadata: {},
			})
			await memory.storePattern({
				description: "Purple elephants fly midnight sky",
				evidenceCount: 5,
				confidence: 0.95,
				lastReinforced: Date.now(),
				category: "fact",
				metadata: {},
			})

			const results = await memory.queryPatterns({ minConfidence: 0.5 })
			expect(results.length).toBeGreaterThanOrEqual(1)
			expect(results.every((p) => p.confidence >= 0.5)).toBe(true)
		})

		it("should filter by minimum evidence", async () => {
			await memory.storePattern({
				description: "Single raindrop falls silently ground",
				evidenceCount: 1,
				confidence: 0.5,
				lastReinforced: Date.now(),
				category: "fact",
				metadata: {},
			})
			await memory.storePattern({
				description: "Multiple stars twinkle galaxy vast",
				evidenceCount: 10,
				confidence: 0.5,
				lastReinforced: Date.now(),
				category: "fact",
				metadata: {},
			})

			const results = await memory.queryPatterns({ minEvidence: 5 })
			expect(results.every((p) => p.evidenceCount >= 5)).toBe(true)
		})
	})

	describe("reinforcePattern", () => {
		it("should reinforce existing pattern when identical description stored", async () => {
			const first = await memory.storePattern({
				description: "API error handling pattern best practice",
				evidenceCount: 3,
				confidence: 0.6,
				lastReinforced: Date.now(),
				category: "learned_skill",
				metadata: {},
			})

			const second = await memory.storePattern({
				description: "API error handling pattern best practice",
				evidenceCount: 5,
				confidence: 0.8,
				lastReinforced: Date.now(),
				category: "learned_skill",
				metadata: {},
			})

			// Identical description triggers dedup → same ID
			expect(second.id).toBe(first.id)
		})
	})

	describe("queryPatterns edge cases", () => {
		it("should sort by confidence descending", async () => {
			await memory.storePattern({
				description: "Xylophone zebra quick narrow fox",
				evidenceCount: 1,
				confidence: 0.3,
				lastReinforced: Date.now(),
				category: "fact",
				metadata: {},
			})
			await memory.storePattern({
				description: "Jazz rhythm piano bass drum solo",
				evidenceCount: 5,
				confidence: 0.95,
				lastReinforced: Date.now(),
				category: "fact",
				metadata: {},
			})

			const results = await memory.queryPatterns({})
			expect(results.length).toBeGreaterThanOrEqual(2)
			expect(results[0].confidence).toBeGreaterThanOrEqual(results[1].confidence)
		})
	})

	describe("tier property", () => {
		it("should return SEMANTIC tier", () => {
			expect(memory.tier).toBe(MemoryTier.SEMANTIC)
		})
	})
})
