/**
 * Skill metadata for discovery (loaded at startup)
 */
export interface SkillMetadata {
	name: string // Required: skill identifier
	description: string // Required: when to use this skill
	path: string // Absolute path to SKILL.md
	source: "global" | "project" // Where the skill was discovered
	/**
	 * @deprecated Use modeSlugs instead. Kept for backward compatibility.
	 * If set, skill is only available in this mode.
	 */
	mode?: string
	/**
	 * Mode slugs where this skill is available.
	 * - undefined or empty array means the skill is available in all modes ("Any mode").
	 * - An array with one or more mode slugs restricts the skill to those modes.
	 */
	modeSlugs?: string[]
	/** Optional category for organizing skills (e.g., "software-development", "devops") */
	category?: string
	/** Optional version (semver) */
	version?: string
	/** Optional author */
	author?: string
	/** Optional tags for discovery */
	tags?: string[]
	/** Optional related skill names for cross-referencing */
	relatedSkills?: string[]
}

/**
 * Full skill content (loaded on activation)
 */
export interface SkillContent extends SkillMetadata {
	instructions: string // Full markdown body
}
