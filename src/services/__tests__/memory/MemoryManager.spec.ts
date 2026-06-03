import { describe, it, expect, beforeEach } from "vitest"
import { MemoryManager } from "../../memory/MemoryManager"
import { MemoryTier, MemoryEntry, MemoryQuery } from "../../memory/types"
import { WorkingMemory } from "../../memory/WorkingMemory"
import { EpisodicMemory } from "../../memory/EpisodicMemory"
import { SemanticMemory } from "../../memory/SemanticMemory"
import { ProceduralMemory } from "../../memory/ProceduralMemory"

describe("MemoryManager", () => {
	let manager: MemoryManager

	beforeEach(async () => {
		manager = new MemoryManager()
		await manager.initialize()
	})

	describe("store", () => {
		it("should store routing to correct tier based on type", async () => {
			const entry = await manager.store({
				type: "episode",
				tier: MemoryTier.EPISODIC,
				content: "Fixed a critical bug",
				metadata: { severity: "high" },
				confidence: 0.8,
				sourceAuthority: "execution",
				tags: ["bug_fix"],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.8,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			})
			expect(entry.id).toBeDefined()
			expect(entry.tier).toBe(MemoryTier.EPISODIC)

			// Query to verify it was stored in the right tier
			const results = await manager.query({ query: "bug" })
			expect(results.length).toBeGreaterThanOrEqual(1)
			expect(results.some((r) => r.content.includes("bug"))).toBe(true)
		})
	})

	describe("query", () => {
		it("should search across all tiers", async () => {
			await manager.store({
				type: "working_context",
				tier: MemoryTier.WORKING,
				content: "Current task: refactoring",
				metadata: {},
				confidence: 0.9,
				sourceAuthority: "execution",
				tags: ["working"],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.9,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 0,
				expiresAt: null,
			})
			await manager.store({
				type: "episode",
				tier: MemoryTier.EPISODIC,
				content: "Refactored module X",
				metadata: {},
				confidence: 0.7,
				sourceAuthority: "execution",
				tags: ["refactor"],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.7,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			})

			const results = await manager.query({ query: "refactor" })
			expect(results.length).toBeGreaterThanOrEqual(1)
		})

		it("should filter by specific tiers", async () => {
			await manager.store({
				type: "episode",
				tier: MemoryTier.EPISODIC,
				content: "Episode entry",
				metadata: {},
				confidence: 0.8,
				sourceAuthority: "execution",
				tags: [],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.8,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			})
			await manager.store({
				type: "pattern",
				tier: MemoryTier.SEMANTIC,
				content: "Semantic entry",
				metadata: {},
				confidence: 0.9,
				sourceAuthority: "execution",
				tags: [],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.9,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			})

			const episodicOnly = await manager.query({
				query: "entry",
				tiers: [MemoryTier.EPISODIC],
			})
			expect(episodicOnly.every((r) => r.tier === MemoryTier.EPISODIC)).toBe(true)
		})
	})

	describe("consolidate", () => {
		it("should trigger batch processing", async () => {
			// Store some entries first
			await manager.store({
				type: "episode",
				tier: MemoryTier.EPISODIC,
				content: "Episode to consolidate",
				metadata: {},
				confidence: 0.8,
				sourceAuthority: "execution",
				tags: [],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.8,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			})
			await manager.store({
				type: "pattern",
				tier: MemoryTier.SEMANTIC,
				content: "Pattern to consolidate",
				metadata: {},
				confidence: 0.9,
				sourceAuthority: "execution",
				tags: [],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.9,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			})

			const records = await manager.consolidate()
			expect(records.length).toBeGreaterThanOrEqual(2) // EPISODIC + SEMANTIC + PROCEDURAL (WORKING skipped)
			for (const record of records) {
				expect(record.tier).toBeDefined()
				expect(typeof record.entriesProcessed).toBe("number")
			}
		})

		it("should consolidate specific tier", async () => {
			const records = await manager.consolidate(MemoryTier.EPISODIC)
			expect(records).toHaveLength(1)
			expect(records[0].tier).toBe(MemoryTier.EPISODIC)
		})
	})

	describe("getTierStats", () => {
		it("should return correct counts", async () => {
			await manager.store({
				type: "episode",
				tier: MemoryTier.EPISODIC,
				content: "Test episode",
				metadata: {},
				confidence: 0.8,
				sourceAuthority: "execution",
				tags: [],
				lastAccessed: Date.now(),
				accessCount: 0,
				baseScore: 0.8,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			})

			const stats = await manager.getTierStats()
			expect(stats.has(MemoryTier.WORKING)).toBe(true)
			expect(stats.has(MemoryTier.EPISODIC)).toBe(true)
			expect(stats.has(MemoryTier.SEMANTIC)).toBe(true)
			expect(stats.has(MemoryTier.PROCEDURAL)).toBe(true)

			const episodicStats = stats.get(MemoryTier.EPISODIC)
			expect(episodicStats).toBeDefined()
			expect(episodicStats!.count).toBeGreaterThanOrEqual(1)
		})
	})
})
