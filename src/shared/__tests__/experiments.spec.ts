// npx vitest run shared/__tests__/experiments.spec.ts

import { EXPERIMENT_IDS, experimentConfigsMap, experimentDefault, experiments } from "../experiments"
import type { ExperimentId } from "@roo-code/types"

describe("EXPERIMENT_IDS", () => {
	const ALL_KEYS = [
		"PREVENT_FOCUS_DISRUPTION",
		"IMAGE_GENERATION",
		"RUN_SLASH_COMMAND",
		"CUSTOM_TOOLS",
		"SELF_IMPROVING",
		"SELF_IMPROVING_AUTO_SKILLS",
		"SELF_IMPROVING_AUTO_MODE",
		"SELF_IMPROVING_REVIEW_TEAM",
		"SELF_IMPROVING_FULL_TRUST",
		"SELF_IMPROVING_QUESTION_EVALUATION",
		"SELF_IMPROVING_PROMPT_QUALITY",
		"SELF_IMPROVING_TOOL_PREFERENCE",
		"SELF_IMPROVING_SKILL_MERGE",
		"SELF_IMPROVING_PERSIST_COUNTS",
		"SELF_IMPROVING_CODE_INDEX",
		"ONE_SHOT_ORCHESTRATOR",
		"KAIZEN_ORCHESTRATOR",
		"PREVENTION_ENGINE",
		"CASCADE_TRACKER",
		"RESILIENCE_SERVICE",
		"TOOL_ERROR_HEALER",
		"VERIFICATION_ENGINE",
		"REQUIREMENTS_VERIFICATION",
		"RECOVERY_CONTEXT",
		"SELF_IMPROVING_SPECIALIZED_SKILLS",
		"TASK_PATTERN_LEARNING",
		"PARALLEL_EXECUTION",
		"STRUCTURED_OUTPUT_PARSING",
		"DEPENDENCY_GRAPH",
		"MULTI_ROOT_WORKSPACE",
	] as const

	it("has all expected keys", () => {
		const keys = Object.keys(EXPERIMENT_IDS)
		expect(keys).toHaveLength(ALL_KEYS.length)
		for (const key of ALL_KEYS) {
			expect(EXPERIMENT_IDS).toHaveProperty(key)
		}
	})

	it("maps each key to a string in camelCase", () => {
		for (const key of ALL_KEYS) {
			const value = EXPERIMENT_IDS[key as keyof typeof EXPERIMENT_IDS]
			expect(typeof value).toBe("string")
			expect(value).toMatch(/^[a-z]+(?:[A-Z][a-z]+)*$/)
		}
	})

	it("maps each key to the corresponding lowercase experiment ID", () => {
		expect(EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION).toBe("preventFocusDisruption")
		expect(EXPERIMENT_IDS.IMAGE_GENERATION).toBe("imageGeneration")
		expect(EXPERIMENT_IDS.RUN_SLASH_COMMAND).toBe("runSlashCommand")
		expect(EXPERIMENT_IDS.CUSTOM_TOOLS).toBe("customTools")
		expect(EXPERIMENT_IDS.SELF_IMPROVING).toBe("selfImproving")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS).toBe("selfImprovingAutoSkills")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_AUTO_MODE).toBe("selfImprovingAutoMode")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_REVIEW_TEAM).toBe("selfImprovingReviewTeam")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_FULL_TRUST).toBe("selfImprovingFullTrust")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_QUESTION_EVALUATION).toBe("selfImprovingQuestionEvaluation")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_PROMPT_QUALITY).toBe("selfImprovingPromptQuality")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_TOOL_PREFERENCE).toBe("selfImprovingToolPreference")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_SKILL_MERGE).toBe("selfImprovingSkillMerge")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_PERSIST_COUNTS).toBe("selfImprovingPersistCounts")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_CODE_INDEX).toBe("selfImprovingCodeIndex")
		expect(EXPERIMENT_IDS.ONE_SHOT_ORCHESTRATOR).toBe("oneShotOrchestrator")
		expect(EXPERIMENT_IDS.KAIZEN_ORCHESTRATOR).toBe("kaizenOrchestrator")
		expect(EXPERIMENT_IDS.PREVENTION_ENGINE).toBe("preventionEngine")
		expect(EXPERIMENT_IDS.CASCADE_TRACKER).toBe("cascadeTracker")
		expect(EXPERIMENT_IDS.RESILIENCE_SERVICE).toBe("resilienceService")
		expect(EXPERIMENT_IDS.TOOL_ERROR_HEALER).toBe("toolErrorHealer")
		expect(EXPERIMENT_IDS.VERIFICATION_ENGINE).toBe("verificationEngine")
		expect(EXPERIMENT_IDS.REQUIREMENTS_VERIFICATION).toBe("requirementsVerification")
		expect(EXPERIMENT_IDS.RECOVERY_CONTEXT).toBe("recoveryContext")
		expect(EXPERIMENT_IDS.SELF_IMPROVING_SPECIALIZED_SKILLS).toBe("selfImprovingSpecializedSkills")
		expect(EXPERIMENT_IDS.TASK_PATTERN_LEARNING).toBe("taskPatternLearning")
	})

	it("has no duplicate values", () => {
		const values = Object.values(EXPERIMENT_IDS)
		const unique = new Set(values)
		expect(unique.size).toBe(values.length)
	})
})

describe("experimentConfigsMap", () => {
	it("has all experiment keys", () => {
		const keys = Object.keys(experimentConfigsMap)
		const expectedKeys = Object.keys(EXPERIMENT_IDS)
		expect(keys).toHaveLength(expectedKeys.length)
		for (const key of expectedKeys) {
			expect(experimentConfigsMap).toHaveProperty(key)
		}
	})

	it("has all experiments enabled by default", () => {
		for (const key of Object.keys(experimentConfigsMap) as Array<keyof typeof experimentConfigsMap>) {
			expect(experimentConfigsMap[key].enabled).toBe(true)
		}
	})

	it("each entry has the correct shape", () => {
		for (const config of Object.values(experimentConfigsMap)) {
			expect(config).toHaveProperty("enabled")
			expect(typeof config.enabled).toBe("boolean")
		}
	})

	it("contains only ExperimentConfig objects", () => {
		for (const config of Object.values(experimentConfigsMap)) {
			expect(config).toHaveProperty("enabled")
			expect(typeof config.enabled).toBe("boolean")
		}
	})
})

describe("experimentDefault", () => {
	it("has all experiment IDs as keys", () => {
		const ids = Object.keys(experimentDefault) as ExperimentId[]
		expect(ids).toHaveLength(Object.keys(EXPERIMENT_IDS).length)
	})

	it("has all experiments defaulting to true", () => {
		for (const id of Object.keys(experimentDefault) as ExperimentId[]) {
			expect(experimentDefault[id]).toBe(true)
		}
	})

	it("has default value of true for all entries", () => {
		for (const id of Object.keys(experimentDefault) as ExperimentId[]) {
			expect(experimentDefault[id]).toBe(true)
		}
	})

	it("derives each default from the corresponding configMap entry", () => {
		// Verify that experimentDefault[experimentId] === configMap entry's enabled
		for (const key of Object.keys(experimentConfigsMap) as Array<keyof typeof experimentConfigsMap>) {
			const experimentId = EXPERIMENT_IDS[key]
			const expected = experimentConfigsMap[key].enabled
			expect(experimentDefault[experimentId as ExperimentId]).toBe(expected)
		}
	})
})

describe("experiments.get()", () => {
	it("returns the config for a known experiment key", () => {
		const config = experiments.get("PREVENT_FOCUS_DISRUPTION")
		expect(config).toBeDefined()
		expect(config?.enabled).toBe(true)
	})

	it("returns the config for SELF_IMPROVING", () => {
		const config = experiments.get("SELF_IMPROVING")
		expect(config).toBeDefined()
		expect(config?.enabled).toBe(true)
	})

	it("returns undefined for an unknown key", () => {
		// @ts-expect-error — testing runtime behaviour for unknown keys
		const config = experiments.get("NON_EXISTENT_KEY")
		expect(config).toBeUndefined()
	})

	it("returns correct config for all known keys", () => {
		for (const key of Object.keys(EXPERIMENT_IDS) as Array<keyof typeof experimentConfigsMap>) {
			const config = experiments.get(key)
			expect(config).toBeDefined()
			expect(config).toHaveProperty("enabled")
			expect(typeof config!.enabled).toBe("boolean")
		}
	})
})

describe("experiments.isEnabled()", () => {
	it("returns true when experiment is explicitly enabled", () => {
		const config = { imageGeneration: true }
		expect(experiments.isEnabled(config, "imageGeneration")).toBe(true)
	})

	it("returns false when experiment is explicitly disabled", () => {
		const config = { imageGeneration: false }
		expect(experiments.isEnabled(config, "imageGeneration")).toBe(false)
	})

	it("falls back to experimentDefault when config has no entry", () => {
		const config = {}
		// preventFocusDisruption defaults to true
		expect(experiments.isEnabled(config, "preventFocusDisruption")).toBe(true)
	})

	it("returns undefined for unknown experiment ID not in experimentDefault", () => {
		const config = {}
		const result = experiments.isEnabled(config, "nonExistentExperiment" as ExperimentId)
		// Falls through to experimentDefault which has no entry → returns undefined
		expect(result).toBeUndefined()
	})

	it("respects explicit false over default true", () => {
		const config = { selfImproving: false }
		expect(experiments.isEnabled(config, "selfImproving")).toBe(false)
	})

	it("respects explicit true over default true", () => {
		const config = { selfImproving: true }
		expect(experiments.isEnabled(config, "selfImproving")).toBe(true)
	})

	it("works correctly for selfImprovingAutoSkills", () => {
		const config = { selfImprovingAutoSkills: true }
		expect(experiments.isEnabled(config, "selfImprovingAutoSkills")).toBe(true)
	})

	it("works correctly for customTools", () => {
		const config = { customTools: false }
		expect(experiments.isEnabled(config, "customTools")).toBe(false)
	})

	it("works for all experiment IDs with default config", () => {
		const config = {}
		const allIds = Object.values(EXPERIMENT_IDS)
		for (const id of allIds) {
			const result = experiments.isEnabled(config, id)
			expect(result).toBe(experimentDefault[id])
		}
	})

	it("works for all experiment IDs with explicit false", () => {
		const config: Record<string, boolean> = {}
		for (const id of Object.values(EXPERIMENT_IDS)) {
			config[id] = false
		}
		for (const id of Object.values(EXPERIMENT_IDS)) {
			expect(experiments.isEnabled(config, id)).toBe(false)
		}
	})
})
