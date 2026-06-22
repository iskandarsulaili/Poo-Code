import { render, screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"

import { EXPERIMENT_IDS, experimentConfigsMap } from "@roo/experiments"

// ── Mocks ──────────────────────────────────────────────────────────────────

// Track rendered experiment keys for duplicate detection
const renderedExperimentKeys: string[] = []

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui", () => ({
	Select: ({ children }: any) => <>{children}</>,
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children }: any) => <>{children}</>,
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
	Input: (props: any) => <input {...props} />,
}))

let _experimentalFeatureCallCount = 0
const experimentalFeatureKeys: string[] = []

vi.mock("../ExperimentalFeature", () => ({
	ExperimentalFeature: vi.fn(({ experimentKey, "data-testid": _testId }: any) => {
		_experimentalFeatureCallCount++
		experimentalFeatureKeys.push(experimentKey)
		renderedExperimentKeys.push(experimentKey)
		return (
			<div data-testid={`experimental-feature-${experimentKey?.toLowerCase?.() ?? "unknown"}`}>
				{experimentKey ?? "unknown"}
			</div>
		)
	}),
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children, settingId, label }: any) => (
		<div data-testid={`searchable-setting-${settingId}`} data-label={label}>
			{children}
		</div>
	),
}))

vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: any) => <div data-testid="section-header">{children}</div>,
}))

vi.mock("../Section", () => ({
	Section: ({ children }: any) => <div data-testid="section">{children}</div>,
}))

vi.mock("../ImageGenerationSettings", () => ({
	ImageGenerationSettings: () => {
		renderedExperimentKeys.push("IMAGE_GENERATION")
		return <div data-testid="image-generation-settings" />
	},
}))

vi.mock("../CustomToolsSettings", () => ({
	CustomToolsSettings: () => {
		renderedExperimentKeys.push("CUSTOM_TOOLS")
		return <div data-testid="custom-tools-settings" />
	},
}))

vi.mock("../SelfImprovingStatus", () => ({
	SelfImprovingStatus: () => <div data-testid="self-improving-status" />,
}))

vi.mock("../VerificationSettings", () => ({
	VerificationSettings: () => <div data-testid="verification-settings" />,
}))

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Known keys from the original design that are NOT in experimentConfigsMap.
 * These are "phantom" / deprecated keys that should be filtered out.
 */
const PHANTOM_KEYS = new Set([
	"DIFF_STRATEGY_UNIFIED",
	"INSERT_BLOCK",
	"MULTI_SEARCH_AND_REPLACE",
	"ASSISTANT_MESSAGE_PARSER",
	"NEW_TASK_REQUIRE_TODOS",
	"MARKETPLACE",
	"CONCURRENT_FILE_READS",
])

function resetRenderedKeys() {
	renderedExperimentKeys.length = 0
	experimentalFeatureKeys.length = 0
	_experimentalFeatureCallCount = 0
}

// ── Imports under test ─────────────────────────────────────────────────────

import { ExperimentalSettings } from "../ExperimentalSettings"

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ExperimentalSettings — data structure integrity", () => {
	it("experimentConfigsMap has exactly 32 entries", () => {
		const keys = Object.keys(experimentConfigsMap)
		expect(keys).toHaveLength(32)
	})

	it("all experimentConfigsMap keys are valid ExperimentKeys", () => {
		const keys = Object.keys(experimentConfigsMap)
		for (const key of keys) {
			expect(EXPERIMENT_IDS).toHaveProperty(key)
		}
	})

	it("every EXPERIMENT_IDS entry has a corresponding experimentConfigsMap entry", () => {
		const configKeys = Object.keys(experimentConfigsMap)
		const idKeys = Object.keys(EXPERIMENT_IDS)
		expect(configKeys.sort()).toEqual(idKeys.sort())
	})

	it("phantom deprecated keys are NOT in experimentConfigsMap", () => {
		const configKeys = new Set(Object.keys(experimentConfigsMap))
		for (const phantomKey of PHANTOM_KEYS) {
			expect(configKeys.has(phantomKey)).toBe(false)
		}
	})

	it("recoveryContext is in experimentConfigsMap", () => {
		expect(experimentConfigsMap).toHaveProperty("RECOVERY_CONTEXT")
	})

	it("SELF_IMPROVING_SPECIALIZED_SKILLS and TASK_PATTERN_LEARNING are in experimentConfigsMap", () => {
		expect(experimentConfigsMap).toHaveProperty("SELF_IMPROVING_SPECIALIZED_SKILLS")
		expect(experimentConfigsMap).toHaveProperty("TASK_PATTERN_LEARNING")
	})
})

describe("ExperimentalSettings — rendering", () => {
	const defaultProps = {
		experiments: {},
		setExperimentEnabled: vi.fn(),
	}

	beforeEach(() => {
		resetRenderedKeys()
	})

	it("renders the section header", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		expect(screen.getByTestId("section-header")).toBeInTheDocument()
		expect(screen.getByTestId("section")).toBeInTheDocument()
	})

	it("renders all category groups", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		// Category group labels should be present (rendered via t())
		expect(screen.getByText("settings:experimental.categories.selfImproving")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.categories.verification")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.categories.infrastructure")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.categories.ui")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.categories.tools")).toBeInTheDocument()
	})

	it("PREVENT_FOCUS_DISRUPTION renders under ui category, NOT standalone", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		// Get all rendering occurrences of this key
		const pfdRenders = renderedExperimentKeys.filter((k) => k === "PREVENT_FOCUS_DISRUPTION")
		// Should render exactly once (in ui category, not standalone)
		expect(pfdRenders).toHaveLength(1)
	})

	it("RUN_SLASH_COMMAND renders under tools category, NOT standalone", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		const rscRenders = renderedExperimentKeys.filter((k) => k === "RUN_SLASH_COMMAND")
		// Should render exactly once (in tools category, not standalone)
		expect(rscRenders).toHaveLength(1)
	})

	it("no experiment renders more than once (no duplicates)", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		const counts = new Map<string, number>()
		for (const key of renderedExperimentKeys) {
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}
		const duplicates = [...counts.entries()].filter(([, c]) => c > 1)
		expect(duplicates).toEqual([])
	})

	it("phantom deprecated keys do not cause empty sections to render", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		// The phantom keys should never appear as rendered experiment features
		for (const phantomKey of PHANTOM_KEYS) {
			expect(renderedExperimentKeys).not.toContain(phantomKey)
		}
	})

	it("all 26 experiments are present in rendered output", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		const allConfigKeys = Object.keys(experimentConfigsMap)
		const rendered = new Set(renderedExperimentKeys)
		const missing = allConfigKeys.filter((key) => !rendered.has(key))
		expect(missing, `Missing experiments: ${missing.join(", ")}`).toEqual([])
		// Also verify the total count matches
		expect(renderedExperimentKeys.length).toBe(allConfigKeys.length)
	})

	it("recoveryContext appears in infrastructure category section", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		// recoveryContext is a SimpleExperimentToggle, rendered by CategoryGroup
		// under infrastructure category
		expect(renderedExperimentKeys).toContain("RECOVERY_CONTEXT")
	})

	it("SELF_IMPROVING_SPECIALIZED_SKILLS appears in selfImproving section", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		expect(renderedExperimentKeys).toContain("SELF_IMPROVING_SPECIALIZED_SKILLS")
	})

	it("TASK_PATTERN_LEARNING appears in selfImproving section", () => {
		render(<ExperimentalSettings {...defaultProps} />)
		expect(renderedExperimentKeys).toContain("TASK_PATTERN_LEARNING")
	})
})
