import { SkillsPlatformFilter } from "../SkillsPlatformFilter"
import type { EnhancedSkillMeta } from "../types"

function createSkillMeta(overrides: Partial<EnhancedSkillMeta> = {}): EnhancedSkillMeta {
	return {
		name: "test-skill",
		version: "1.0.0",
		platforms: ["linux"],
		architectures: ["x64"],
		nodeVersion: { range: ">=18.0.0" },
		...overrides,
	} as EnhancedSkillMeta
}

describe("SkillsPlatformFilter", () => {
	describe("default constructor", () => {
		it("should detect current platform and arch", () => {
			const filter = new SkillsPlatformFilter()
			expect(filter.getPlatform()).toBe(process.platform)
			expect(filter.getArchitecture()).toBe(process.arch)
			expect(filter.getNodeVersion()).toBe(process.version)
		})
	})

	describe("setPlatform() / setArchitecture() / setNodeVersion()", () => {
		it("should allow overriding platform", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("darwin")
			expect(filter.getPlatform()).toBe("darwin")
		})

		it("should allow overriding architecture", () => {
			const filter = new SkillsPlatformFilter()
			filter.setArchitecture("arm64")
			expect(filter.getArchitecture()).toBe("arm64")
		})

		it("should allow overriding node version", () => {
			const filter = new SkillsPlatformFilter()
			filter.setNodeVersion("v20.0.0")
			expect(filter.getNodeVersion()).toBe("v20.0.0")
		})
	})

	describe("checkSkill()", () => {
		it("should return compatible for matching platform and arch", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("linux")
			filter.setArchitecture("x64")
			filter.setNodeVersion("v20.0.0")

			const result = filter.checkSkill(createSkillMeta())
			expect(result.isCompatible).toBe(true)
		})

		it("should return incompatible for mismatched platform", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("win32")
			filter.setArchitecture("x64")
			filter.setNodeVersion("v20.0.0")

			const result = filter.checkSkill(createSkillMeta())
			expect(result.isCompatible).toBe(false)
			expect(result.incompatibilityReason).toBeDefined()
		})

		it("should return incompatible for mismatched architecture", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("linux")
			filter.setArchitecture("arm64")
			filter.setNodeVersion("v20.0.0")

			const result = filter.checkSkill(createSkillMeta())
			expect(result.isCompatible).toBe(false)
		})

		it("should return incompatible for unsatisfied node version", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("linux")
			filter.setArchitecture("x64")
			filter.setNodeVersion("v14.0.0")

			const result = filter.checkSkill(createSkillMeta())
			expect(result.isCompatible).toBe(false)
		})

		it("should handle missing platform info as compatible", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("linux")
			filter.setArchitecture("x64")

			const result = filter.checkSkill(createSkillMeta({ platforms: undefined as any }))
			expect(result.isCompatible).toBe(true)
		})

		it("should handle missing node version constraint as compatible", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("linux")
			filter.setArchitecture("x64")
			filter.setNodeVersion("v20.0.0")

			const result = filter.checkSkill(createSkillMeta({ nodeVersion: undefined }))
			expect(result.isCompatible).toBe(true)
		})
	})

	describe("filterSkills()", () => {
		it("should filter compatible skills", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("linux")
			filter.setArchitecture("x64")
			filter.setNodeVersion("v20.0.0")

			const compatible = createSkillMeta()
			const incompatible = createSkillMeta({ platforms: ["win32"] })

			const result = filter.filterSkills([compatible, incompatible])
			expect(result.compatible).toHaveLength(1)
			expect(result.incompatible).toHaveLength(1)
			expect(result.compatible[0].name).toBe("test-skill")
			expect(result.incompatible[0].skill.name).toBe("test-skill")
		})

		it("should handle empty skill list", () => {
			const filter = new SkillsPlatformFilter()

			const result = filter.filterSkills([])
			expect(result.compatible).toHaveLength(0)
			expect(result.incompatible).toHaveLength(0)
		})

		it("should handle 'all' platform keyword", () => {
			const filter = new SkillsPlatformFilter()
			filter.setPlatform("darwin")

			const result = filter.checkSkill(createSkillMeta({ platforms: ["all"] }))
			expect(result.isCompatible).toBe(true)
		})
	})
})
