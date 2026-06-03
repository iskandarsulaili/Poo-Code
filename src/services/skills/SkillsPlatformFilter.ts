/**
 * SkillsPlatformFilter — Filters skills by platform, architecture, and Node.js version.
 *
 * Checks each skill's platform metadata against the current runtime
 * to determine compatibility. Supports:
 * - OS platform filtering (linux, darwin, win32, etc.)
 * - CPU architecture filtering (x64, arm64, etc.)
 * - Node.js version range constraints (semver)
 *
 * Uses os.platform() and os.arch() and process.version by default.
 */

import { satisfies } from "semver"
import os from "node:os"
import { type EnhancedSkillMeta, type PlatformFilterResult, type SkillPlatformInfo, SkillsError } from "./types"

/**
 * Platform filter with multi-dimensional compatibility checking.
 *
 * Usage:
 * ```ts
 * const filter = new SkillsPlatformFilter()
 * const result = filter.checkSkill(skillMeta)
 * if (!result.isCompatible) { ... }
 * const compatible = filter.filterSkills(allSkills)
 * ```
 */
export class SkillsPlatformFilter {
	private currentPlatform: string
	private currentArch: string
	private nodeVersion: string

	constructor() {
		this.currentPlatform = os.platform()
		this.currentArch = os.arch()
		this.nodeVersion = process.version
	}

	/**
	 * Override the detected platform (useful for testing).
	 */
	setPlatform(platform: string): void {
		this.currentPlatform = platform
	}

	/**
	 * Override the detected architecture (useful for testing).
	 */
	setArchitecture(arch: string): void {
		this.currentArch = arch
	}

	/**
	 * Override the Node.js version (useful for testing).
	 */
	setNodeVersion(version: string): void {
		this.nodeVersion = version
	}

	/**
	 * Get the current platform.
	 */
	getPlatform(): string {
		return this.currentPlatform
	}

	/**
	 * Get the current architecture.
	 */
	getArchitecture(): string {
		return this.currentArch
	}

	/**
	 * Get the current Node.js version.
	 */
	getNodeVersion(): string {
		return this.nodeVersion
	}

	/**
	 * Check whether a skill meta is compatible with the current runtime.
	 * Evaluates platform, architecture, and Node.js version constraints.
	 */
	checkSkill(skill: EnhancedSkillMeta): SkillPlatformInfo {
		const reasons: string[] = []

		// Check platform compatibility
		const platformCompatible = this.evaluatePlatform(skill, reasons)

		// Check architecture compatibility
		const archCompatible = this.evaluateArchitecture(skill, reasons)

		// Check Node.js version
		const nodeCompatible = this.evaluateNodeVersion(skill, reasons)

		const isCompatible = platformCompatible && archCompatible && nodeCompatible

		return {
			skillName: skill.name,
			supportedPlatforms: skill.platforms ?? [],
			unsupportedPlatforms: this.computeUnsupportedPlatforms(skill),
			currentPlatform: this.currentPlatform,
			isCompatible,
			incompatibilityReason: isCompatible ? undefined : reasons.join("; "),
		}
	}

	/**
	 * Filter a list of skills to only compatible ones.
	 * Returns a PlatformFilterResult with both compatible and incompatible lists.
	 */
	filterSkills(skills: EnhancedSkillMeta[]): PlatformFilterResult {
		const compatible: EnhancedSkillMeta[] = []
		const incompatible: Array<{ skill: EnhancedSkillMeta; reason: string }> = []

		for (const skill of skills) {
			const result = this.checkSkill(skill)
			if (result.isCompatible) {
				compatible.push(skill)
			} else {
				incompatible.push({
					skill,
					reason: result.incompatibilityReason ?? "Unknown incompatibility",
				})
			}
		}

		return { compatible, incompatible }
	}

	/**
	 * Evaluate platform compatibility.
	 * Empty platform list = compatible with all.
	 * "all" keyword = compatible with all.
	 */
	private evaluatePlatform(skill: EnhancedSkillMeta, reasons: string[]): boolean {
		const platforms = skill.platforms

		if (!platforms || platforms.length === 0) {
			return true // No constraints = compatible with all
		}

		if (platforms.includes("all")) {
			return true
		}

		if (platforms.includes(this.currentPlatform)) {
			return true
		}

		reasons.push(`Platform "${this.currentPlatform}" not in supported list: [${platforms.join(", ")}]`)
		return false
	}

	/**
	 * Evaluate architecture compatibility.
	 */
	private evaluateArchitecture(skill: EnhancedSkillMeta, reasons: string[]): boolean {
		const architectures = skill.architectures

		if (!architectures || architectures.length === 0) {
			return true // No constraints = compatible with all
		}

		if (architectures.includes("all")) {
			return true
		}

		if (architectures.includes(this.currentArch)) {
			return true
		}

		reasons.push(`Architecture "${this.currentArch}" not in supported list: [${architectures.join(", ")}]`)
		return false
	}

	/**
	 * Evaluate Node.js version constraint using semver.
	 */
	private evaluateNodeVersion(skill: EnhancedSkillMeta, reasons: string[]): boolean {
		const versionConstraint = skill.nodeVersion

		if (!versionConstraint?.range) {
			return true // No constraint = compatible
		}

		try {
			const isSatisfied = satisfies(this.nodeVersion, versionConstraint.range)
			if (!isSatisfied) {
				reasons.push(
					`Node.js version "${this.nodeVersion}" does not satisfy constraint "${versionConstraint.range}"`,
				)
			}
			return isSatisfied
		} catch {
			reasons.push(`Invalid semver range "${versionConstraint.range}" — cannot evaluate`)
			return false
		}
	}

	/**
	 * Compute unsupported platforms for the info result.
	 */
	private computeUnsupportedPlatforms(skill: EnhancedSkillMeta): string[] {
		if (skill.platforms?.includes("all") || !skill.platforms?.length) {
			return []
		}

		const allPlatforms = ["linux", "darwin", "win32", "freebsd", "openbsd", "sunos", "android"]
		return allPlatforms.filter((p) => !skill.platforms!.includes(p))
	}

	/**
	 * Validate skill metadata for required fields before platform checking.
	 * Throws SkillsError if metadata is invalid.
	 */
	validateSkillMeta(skill: EnhancedSkillMeta): void {
		if (!skill.name) {
			throw new SkillsError("Skill name is required", "SKILL_NOT_FOUND")
		}
		if (skill.platforms && !Array.isArray(skill.platforms)) {
			throw new SkillsError(`Invalid platforms for skill "${skill.name}": must be an array`, "PLATFORM_MISMATCH")
		}
		if (skill.nodeVersion?.range && typeof skill.nodeVersion.range !== "string") {
			throw new SkillsError(
				`Invalid nodeVersion range for skill "${skill.name}": must be a string`,
				"PLATFORM_MISMATCH",
			)
		}
	}
}
