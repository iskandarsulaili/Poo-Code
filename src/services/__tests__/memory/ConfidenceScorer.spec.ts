import { describe, it, expect, beforeEach } from "vitest"
import { ConfidenceScorer } from "../../memory/ConfidenceScorer"
import { ConfidenceParams, MemoryEntry, MemoryTier, SourceAuthority } from "../../memory/types"

describe("ConfidenceScorer", () => {
	let scorer: ConfidenceScorer

	beforeEach(() => {
		scorer = new ConfidenceScorer()
	})

	describe("calculateScore", () => {
		it("fresh entry (no decay) should return base score ≈ baseScore", () => {
			const params: ConfidenceParams = {
				baseScore: 0.8,
				sourceAuthority: "execution",
				consistency: 1.0,
				ageMs: 0,
				tierDecayRate: 0.1,
			}
			const score = scorer.calculateScore(params)
			// baseScore * 1.0 * 1.0 * 1.0 = 0.8
			expect(score).toBeCloseTo(0.8, 3)
		})

		it("recent usage boosts score (recency factor near 1)", () => {
			const params: ConfidenceParams = {
				baseScore: 0.8,
				sourceAuthority: "execution",
				consistency: 1.0,
				ageMs: 60_000, // 1 minute ago — very recent
				tierDecayRate: 0.1,
			}
			const score = scorer.calculateScore(params)
			// ~0.8 * e^(-0.1 * 1/1440) * 1.0 * 1.0 ≈ 0.7999
			expect(score).toBeGreaterThan(0.79)
			expect(score).toBeLessThanOrEqual(0.8)
		})

		it("old entry with high decay should have lower score", () => {
			const params: ConfidenceParams = {
				baseScore: 0.8,
				sourceAuthority: "execution",
				consistency: 1.0,
				ageMs: 30 * 86_400_000, // 30 days old
				tierDecayRate: 0.1,
			}
			const score = scorer.calculateScore(params)
			// recency = e^(-0.1 * 30) = e^(-3) ≈ 0.0498
			// score = 0.8 * 0.0498 ≈ 0.04
			expect(score).toBeLessThan(0.1)
			expect(score).toBeGreaterThan(0)
		})

		it("multiple reinforcements increase consistency multiplier", () => {
			const params: ConfidenceParams = {
				baseScore: 0.8,
				sourceAuthority: "execution",
				consistency: 1.0, // high consistency
				ageMs: 0,
				tierDecayRate: 0.1,
			}
			const highConsistency = scorer.calculateScore(params)

			const lowConsistencyParams: ConfidenceParams = {
				baseScore: 0.8,
				sourceAuthority: "execution",
				consistency: 0.5, // some contradictory observations
				ageMs: 0,
				tierDecayRate: 0.1,
			}
			const lowConsistency = scorer.calculateScore(lowConsistencyParams)

			expect(highConsistency).toBeGreaterThan(lowConsistency)
		})

		it("authority weight should affect score", () => {
			const baseParams: ConfidenceParams = {
				baseScore: 0.8,
				sourceAuthority: "execution",
				consistency: 1.0,
				ageMs: 0,
				tierDecayRate: 0.1,
			}
			const executionScore = scorer.calculateScore(baseParams)

			const llmParams: ConfidenceParams = {
				...baseParams,
				sourceAuthority: "llm",
			}
			const llmScore = scorer.calculateScore(llmParams)

			// execution weight = 1.0, llm weight = 0.7
			expect(executionScore).toBeGreaterThan(llmScore)
			expect(llmScore).toBeCloseTo(0.8 * 0.7, 3)
		})
	})

	describe("recencyFactor", () => {
		it("should return 1.0 for age of 0", () => {
			expect(scorer.recencyFactor(0.1, 0)).toBe(1.0)
		})

		it("should decrease with age", () => {
			const recent = scorer.recencyFactor(0.1, 0)
			const old = scorer.recencyFactor(0.1, 30 * 86_400_000)
			expect(old).toBeLessThan(recent)
		})
	})

	describe("updateConfidence", () => {
		it("should boost confidence on reinforcement", () => {
			const entry: MemoryEntry = {
				id: "test-1",
				tier: MemoryTier.EPISODIC,
				type: "episode",
				content: "test",
				metadata: {},
				confidence: 0.5,
				sourceAuthority: "execution",
				tags: [],
				createdAt: Date.now() - 86_400_000,
				lastAccessed: Date.now() - 86_400_000,
				accessCount: 1,
				baseScore: 0.8,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			}
			const newScore = scorer.updateConfidence(entry, true)
			expect(newScore).toBeGreaterThan(entry.confidence)
			expect(newScore).toBeLessThanOrEqual(1)
		})

		it("should decay confidence without reinforcement", () => {
			const entry: MemoryEntry = {
				id: "test-1",
				tier: MemoryTier.EPISODIC,
				type: "episode",
				content: "test",
				metadata: {},
				confidence: 0.8,
				sourceAuthority: "execution",
				tags: [],
				createdAt: Date.now() - 30 * 86_400_000,
				lastAccessed: Date.now() - 30 * 86_400_000,
				accessCount: 1,
				baseScore: 0.8,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			}
			const newScore = scorer.updateConfidence(entry, false)
			expect(newScore).toBeLessThan(entry.confidence)
		})
	})

	describe("calculateConsistency", () => {
		it("should return 1.0 when no contradictory observations", () => {
			expect(scorer.calculateConsistency(0, 5)).toBe(1.0)
		})

		it("should return 0.5 when all observations are contradictory", () => {
			expect(scorer.calculateConsistency(5, 5)).toBe(0.5)
		})
	})

	describe("decayScores", () => {
		it("should decay all entries in a tier", () => {
			const entry: MemoryEntry = {
				id: "test-1",
				tier: MemoryTier.EPISODIC,
				type: "episode",
				content: "test",
				metadata: {},
				confidence: 0.8,
				sourceAuthority: "execution",
				tags: [],
				createdAt: Date.now(),
				lastAccessed: Date.now() - 30 * 86_400_000,
				accessCount: 1,
				baseScore: 0.8,
				tierDecayRate: 0.1,
				contradictoryObservations: 0,
				totalObservations: 1,
				expiresAt: null,
			}
			const decayed = scorer.decayScores([entry], MemoryTier.EPISODIC)
			expect(decayed[0].confidence).toBeLessThan(entry.confidence)
			expect(decayed[0].lastAccessed).toBeGreaterThan(entry.lastAccessed)
		})
	})
})
