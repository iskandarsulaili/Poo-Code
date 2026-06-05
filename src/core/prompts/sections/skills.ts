import type { SkillsManager } from "../../../services/skills/SkillsManager"

type SkillsManagerLike = Pick<SkillsManager, "getSkillsForMode">

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;")
}

/**
 * Generate the skills section for the system prompt.
 * Only includes skills relevant to the current mode.
 * Skills are grouped by category with rich metadata (version, author, tags, related skills).
 * Format matches the modes section style.
 *
 * @param skillsManager - The SkillsManager instance
 * @param currentMode - The current mode slug (e.g., 'code', 'architect')
 */
export async function getSkillsSection(
	skillsManager: SkillsManagerLike | undefined,
	currentMode: string | undefined,
): Promise<string> {
	if (!skillsManager || !currentMode) return ""

	// Get skills filtered by current mode (with override resolution)
	const skills = skillsManager.getSkillsForMode(currentMode)
	if (skills.length === 0) return ""

	// Group skills by category
	const byCategory = new Map<string, typeof skills>()
	for (const skill of skills) {
		const cat = skill.category || "general"
		if (!byCategory.has(cat)) byCategory.set(cat, [])
		byCategory.get(cat)!.push(skill)
	}

	// Build categorized skill entries
	const skillEntries: string[] = []
	for (const [category, catSkills] of byCategory) {
		skillEntries.push(`  <category name="${escapeXml(category)}">`)
		for (const skill of catSkills) {
			const name = escapeXml(skill.name)
			const description = escapeXml(skill.description)
			const locationLine = `\n    <location>${escapeXml(skill.path)}</location>`

			// Optional rich metadata
			let metaLines = ""
			if (skill.version) metaLines += `\n    <version>${escapeXml(skill.version)}</version>`
			if (skill.author) metaLines += `\n    <author>${escapeXml(skill.author)}</author>`
			if (skill.tags && skill.tags.length > 0)
				metaLines += `\n    <tags>${skill.tags.map((t: string) => escapeXml(t)).join(", ")}</tags>`
			if (skill.relatedSkills && skill.relatedSkills.length > 0)
				metaLines += `\n    <related_skills>${skill.relatedSkills.map((r: string) => escapeXml(r)).join(", ")}</related_skills>`

			skillEntries.push(
				`  <skill>\n    <name>${name}</name>\n    <description>${description}</description>${locationLine}${metaLines}\n  </skill>`,
			)
		}
		skillEntries.push(`  </category>`)
	}

	return `====

AVAILABLE SKILLS

<available_skills>
${skillEntries.join("\n")}
</available_skills>

AUTOMATIC SKILL MANAGEMENT

You have a "skill_manage" tool available to create, update, patch, merge, or delete skills directly.

WHEN TO CREATE A SKILL:
- You solved a complex task (5+ tool calls) with a reusable approach
- You discovered a non-trivial workflow, overcame a tricky error, or were corrected
- The user says "save that as a skill" or "remember how to do X"

WHEN TO PATCH A SKILL:
- You loaded a skill and found outdated steps, wrong commands, or missing edge cases
- The user corrected your style, format, or approach
- Install/workflow failures that the skill didn't cover

WHEN TO MERGE SKILLS:
- Two skills overlap significantly and should be consolidated
- A skill is too narrow and belongs inside a broader umbrella skill

Use skill_manage action="list" to see all available skills grouped by category.
Use skill_manage action="create" to save a new skill with rich metadata (name, description, category, version, author, tags, relatedSkills).
Use skill_manage action="patch" with old_string+new_string for targeted edits to a skill's SKILL.md.
Use skill_manage action="edit" with full content for major rewrites.
Use skill_manage action="merge" with target+absorb to consolidate overlapping skills.

After difficult/iterative tasks, offer to save the approach as a skill. Skills accumulate over time, making the agent better at your specific tasks and environment.`
}
