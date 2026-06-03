/**
 * Skills System Enhancement — Type Definitions
 *
 * Defines extended types for F7: Skills System Enhancement feature.
 * Supports skill composition, dependency resolution, and platform filtering.
 */

import type { SkillMetadata } from "@zoodotdev/types"

/**
 * Composition mode — how skills are chained together.
 */
export type CompositionMode = "pipeline" | "inheritance" | "group"

/**
 * A skill composition entry — chains multiple skills together.
 * Supports three composition modes:
 * - pipeline: sequential execution, output feeds next input
 * - inheritance: child inherits/extends parent skill
 * - group: parallel execution of independent skills
 */
export interface SkillComposition {
	/** Unique composition ID */
	id: string
	/** Human-readable composition name */
	name: string
	/** Composition mode */
	mode: CompositionMode
	/** Ordered list of skill names to execute */
	skillChain: string[]
	/** Optional data flow mappings between skill outputs and inputs */
	dataFlow?: DataFlowMapping[]
	/** Whether to stop on first failure in the chain */
	stopOnFailure: boolean
	/** Timestamp of creation (epoch ms) */
	createdAt: number
}

/**
 * Data flow mapping between skills in a composition chain.
 */
export interface DataFlowMapping {
	/** Source skill name */
	fromSkill: string
	/** Target skill name */
	toSkill: string
	/** Key-value mapping: outputKey -> inputKey */
	mapping: Record<string, string>
}

/**
 * Composition execution context passed between skills.
 */
export interface CompositionContext {
	/** Upstream outputs available as inputs */
	upstreamOutputs: Record<string, unknown>
	/** Current composition metadata */
	composition: SkillComposition
	/** Index in the chain currently executing */
	currentIndex: number
}

/**
 * Result of a composition execution.
 */
export interface CompositionResult {
	/** Composition ID */
	compositionId: string
	/** Whether the entire composition succeeded */
	success: boolean
	/** Per-skill results keyed by skill name */
	skillResults: Record<string, unknown>
	/** Error messages keyed by skill name (only on failure) */
	errors: Record<string, string>
	/** Duration of execution in ms */
	durationMs: number
}

/**
 * A dependency between two skills.
 */
export interface SkillDependency {
	/** Skill that depends on another */
	dependentSkill: string
	/** Skill that must run first */
	requiredSkill: string
	/** Whether this dependency is optional (suggested but not required) */
	optional: boolean
	/** Description of why this dependency exists */
	reason: string
}

/**
 * A resolved dependency chain (topologically sorted).
 */
export interface ResolvedDependencyChain {
	/** Ordered list of skill names (dependencies first, dependents last) */
	order: string[]
	/** Any cycles that were detected */
	cycles: string[][]
	/** Any unresolved dependencies (missing required skills) */
	unresolved: string[]
}

/**
 * Platform compatibility information for a skill.
 */
export interface SkillPlatformInfo {
	/** Skill name */
	skillName: string
	/** Platforms this skill is compatible with */
	supportedPlatforms: string[]
	/** Platforms this skill explicitly does NOT support */
	unsupportedPlatforms: string[]
	/** Current platform being evaluated */
	currentPlatform: string
	/** Whether the skill is compatible with the current platform */
	isCompatible: boolean
	/** Reason for incompatibility (if applicable) */
	incompatibilityReason?: string
}

/**
 * Architecture filter criteria.
 */
export interface ArchFilter {
	/** CPU architectures to include */
	architectures?: string[]
}

/**
 * Node.js version range constraint (semver range).
 */
export interface NodeVersionConstraint {
	/** Node.js version range (e.g., ">=18.0.0", "^20.0.0") */
	range: string
}

/**
 * Extended skill metadata including composition and dep info.
 */
export interface EnhancedSkillMeta extends SkillMetadata {
	/** Skill version */
	version: string
	/** Category path (e.g., "testing/unit") */
	category: string
	/** Platforms this skill supports (empty = all platforms) */
	platforms: string[]
	/** CPU architectures supported (empty = all arches) */
	architectures?: string[]
	/** Node.js version constraint */
	nodeVersion?: NodeVersionConstraint
	/** Dependencies on other skills */
	dependencies: SkillDependency[]
	/** Tags for discovery */
	tags: string[]
	/** Whether this skill is deprecated */
	deprecated: boolean
}

/**
 * Platform filter result for a batch of skills.
 */
export interface PlatformFilterResult {
	/** Skills that passed the filter */
	compatible: EnhancedSkillMeta[]
	/** Skills that were filtered out, with reasons */
	incompatible: Array<{
		skill: EnhancedSkillMeta
		reason: string
	}>
}

/**
 * Errors thrown by skills operations.
 */
export class SkillsError extends Error {
	constructor(
		message: string,
		public readonly code: SkillsErrorCode,
	) {
		super(message)
		this.name = "SkillsError"
	}
}

/**
 * Categorised error codes for skills operations.
 */
export type SkillsErrorCode =
	| "COMPOSITION_CYCLE"
	| "UNRESOLVED_DEPENDENCY"
	| "PLATFORM_MISMATCH"
	| "SKILL_NOT_FOUND"
	| "CHAIN_EXECUTION_FAILED"
	| "COMPOSITION_NOT_FOUND"
	| "DATA_FLOW_MISMATCH"
