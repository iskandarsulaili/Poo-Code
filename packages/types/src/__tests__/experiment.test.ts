import { describe, it, expect } from "vitest"
import { experimentIds, experimentIdsSchema, experimentsSchema } from "../experiment.js"
import type { ExperimentId, Experiments } from "../experiment.js"

describe("@roo-code/types/experiment", () => {
	// ── experimentIds array ──────────────────────────────────────────────

	describe("experimentIds", () => {
		const ALL_EXPECTED_IDS = [
			"preventFocusDisruption",
			"imageGeneration",
			"runSlashCommand",
			"customTools",
			"selfImproving",
			"selfImprovingAutoSkills",
			"selfImprovingAutoMode",
			"selfImprovingReviewTeam",
			"selfImprovingFullTrust",
			"selfImprovingQuestionEvaluation",
			"selfImprovingPromptQuality",
			"selfImprovingToolPreference",
			"selfImprovingSkillMerge",
			"selfImprovingPersistCounts",
			"selfImprovingCodeIndex",
			"oneShotOrchestrator",
			"kaizenOrchestrator",
			"preventionEngine",
			"cascadeTracker",
			"resilienceService",
			"toolErrorHealer",
			"verificationEngine",
			"requirementsVerification",
			"recoveryContext",
			"selfImprovingSpecializedSkills",
			"taskPatternLearning",
		] as const

		it("contains all expected experiment IDs", () => {
			expect(experimentIds).toHaveLength(ALL_EXPECTED_IDS.length)
			for (const id of ALL_EXPECTED_IDS) {
				expect(experimentIds).toContain(id)
			}
		})

		it("is a readonly tuple", () => {
			// Type-level: must be 'as const' to support z.enum()
			expect(Array.isArray(experimentIds)).toBe(true)
		})

		it("contains no duplicate IDs", () => {
			const unique = new Set(experimentIds)
			expect(unique.size).toBe(experimentIds.length)
		})

		it("contains only lowercase camelCase strings", () => {
			for (const id of experimentIds) {
				expect(id).toMatch(/^[a-z]+(?:[A-Z][a-z]+)*$/)
			}
		})
	})

	// ── experimentIdsSchema ──────────────────────────────────────────────

	describe("experimentIdsSchema", () => {
		it("accepts any valid experiment ID", () => {
			for (const id of experimentIds) {
				const result = experimentIdsSchema.safeParse(id)
				expect(result.success).toBe(true)
			}
		})

		it("rejects an unknown experiment ID", () => {
			const result = experimentIdsSchema.safeParse("nonExistentExperiment")
			expect(result.success).toBe(false)
		})

		it("rejects empty string", () => {
			const result = experimentIdsSchema.safeParse("")
			expect(result.success).toBe(false)
		})

		it("rejects null", () => {
			const result = experimentIdsSchema.safeParse(null)
			expect(result.success).toBe(false)
		})

		it("rejects undefined", () => {
			const result = experimentIdsSchema.safeParse(undefined)
			expect(result.success).toBe(false)
		})

		it("rejects numbers", () => {
			const result = experimentIdsSchema.safeParse(42)
			expect(result.success).toBe(false)
		})
	})

	// ── experimentsSchema ────────────────────────────────────────────────

	describe("experimentsSchema", () => {
		it("accepts an empty object (all optional)", () => {
			const result = experimentsSchema.safeParse({})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data).toEqual({})
			}
		})

		it("accepts partial experiment flags", () => {
			const result = experimentsSchema.safeParse({
				imageGeneration: true,
				selfImproving: false,
			})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.imageGeneration).toBe(true)
				expect(result.data.selfImproving).toBe(false)
			}
		})

		it("accepts all experiment flags set to true", () => {
			const allTrue: Record<string, boolean> = {}
			for (const id of experimentIds) {
				allTrue[id] = true
			}
			const result = experimentsSchema.safeParse(allTrue)
			expect(result.success).toBe(true)
		})

		it("accepts all experiment flags set to false", () => {
			const allFalse: Record<string, boolean> = {}
			for (const id of experimentIds) {
				allFalse[id] = false
			}
			const result = experimentsSchema.safeParse(allFalse)
			expect(result.success).toBe(true)
		})

		it("rejects non-boolean experiment flag values", () => {
			const result = experimentsSchema.safeParse({
				selfImproving: "yes",
			})
			expect(result.success).toBe(false)
		})

		it("accepts lenientModes array", () => {
			const result = experimentsSchema.safeParse({
				lenientModes: ["research", "ask"],
			})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.lenientModes).toEqual(["research", "ask"])
			}
		})

		it("accepts verificationLevel enum values", () => {
			const validLevels = ["strict", "lenient", "bypass"] as const
			for (const level of validLevels) {
				const result = experimentsSchema.safeParse({ verificationLevel: level })
				expect(result.success).toBe(true)
				if (result.success) {
					expect(result.data.verificationLevel).toBe(level)
				}
			}
		})

		it("rejects invalid verificationLevel", () => {
			const result = experimentsSchema.safeParse({ verificationLevel: "super-strict" })
			expect(result.success).toBe(false)
		})

		it("accepts verificationLevels record", () => {
			const result = experimentsSchema.safeParse({
				verificationLevels: {
					code: "strict",
					ask: "lenient",
					research: "bypass",
				},
			})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.verificationLevels).toEqual({
					code: "strict",
					ask: "lenient",
					research: "bypass",
				})
			}
		})

		it("rejects verificationLevels with invalid values", () => {
			const result = experimentsSchema.safeParse({
				verificationLevels: {
					code: "invalid",
				},
			})
			expect(result.success).toBe(false)
		})

		it("accepts all verification gate config fields (booleans + timeout only)", () => {
			const result = experimentsSchema.safeParse({
				verificationCheckBuild: true,
				verificationCheckLint: false,
				verificationCheckTypes: true,
				verificationCheckTests: false,
				verificationTimeoutMs: 30000,
			})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.verificationCheckBuild).toBe(true)
				expect(result.data.verificationTimeoutMs).toBe(30000)
			}
		})

		it("accepts verificationTimeoutMs >= 1000", () => {
			const result = experimentsSchema.safeParse({ verificationTimeoutMs: 5000 })
			expect(result.success).toBe(true)
		})

		it("rejects verificationTimeoutMs < 1000", () => {
			const result = experimentsSchema.safeParse({ verificationTimeoutMs: 500 })
			expect(result.success).toBe(false)
		})

		it("rejects verificationTimeoutMs as string", () => {
			const result = experimentsSchema.safeParse({ verificationTimeoutMs: "5000" })
			expect(result.success).toBe(false)
		})

		it("strips unknown top-level keys by default", () => {
			// zod.object() strips unknown keys by default (not strict)
			const result = experimentsSchema.safeParse({
				unknownField: "should not be here",
			})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data).not.toHaveProperty("unknownField")
			}
		})

		it("infer type is assignable to Experiments", () => {
			// Compile-time type check — will error if type inference is wrong
			const data: Experiments = {
				imageGeneration: true,
				selfImproving: false,
				lenientModes: ["research"],
				verificationLevel: "strict",
			}
			expect(data.imageGeneration).toBe(true)
		})

		it("infer type allows undefined optional fields", () => {
			const data: Experiments = {}
			expect(data.imageGeneration).toBeUndefined()
		})
	})

	// ── ExperimentId type ────────────────────────────────────────────────

	describe("ExperimentId type", () => {
		it("is assignable from string literals matching experimentIds", () => {
			const id: ExperimentId = "selfImproving"
			expect(id).toBe("selfImproving")
		})

		it("is assignable from experimentIds array members", () => {
			const id: ExperimentId = experimentIds[0]
			expect(experimentIds.includes(id)).toBe(true)
		})
	})
})
