import type OpenAI from "openai"

const SKILL_MANAGE_DESCRIPTION = `Create, update, patch, merge, delete, or list skills. Skills are reusable procedures that improve the agent over time.

Use this tool when:
- You've solved a complex task (5+ tool calls) and want to save the approach as a skill
- You discovered a non-trivial workflow, fixed a tricky error, or were corrected by the user
- An existing skill has outdated steps, wrong commands, or missing edge cases
- Two skills overlap and should be merged
- A skill is no longer relevant and should be pruned

ACTIONS:
- "create" — Create a new skill with SKILL.md content (supports name, description, category, version, author, tags, relatedSkills, modeSlugs, content)
- "patch" — Find-and-replace within a skill's SKILL.md (use old_string + new_string). Prefer over "edit" for targeted updates.
- "edit" — Rewrite the entire SKILL.md content. Use only for major overhauls.
- "delete" — Remove a skill entirely.
- "merge" — Merge one or more skills into a target skill. The content of absorbed skills is consolidated into the target.
- "list" — List all available skills with their metadata.

After difficult/iterative tasks, offer to save the approach as a skill. Skills accumulate over time, making the agent better at specific tasks.`

const MODE_SLUGS_DESCRIPTION = `Optional array of mode slugs restricting this skill to specific modes. Empty or omitted means available in all modes.`

const CATEGORY_DESCRIPTION = `Optional category for organizing skills (e.g., "software-development", "devops", "mlops", "data-science", "creative", "research"). Creates a subdirectory grouping.`

const TAGS_DESCRIPTION = `Optional comma-separated tags for discovery (e.g., "testing,android,ci")`

const RELATED_SKILLS_DESCRIPTION = `Optional comma-separated names of related skills for cross-referencing`

export default {
	type: "function",
	function: {
		name: "skill_manage",
		description: SKILL_MANAGE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Action to perform: create, patch, edit, delete, merge, or list",
					enum: ["create", "patch", "edit", "delete", "merge", "list"],
				},
				name: {
					type: "string",
					description: "Skill name (lowercase, hyphens, 1-64 chars). Required for all actions except list.",
				},
				description: {
					type: ["string", "null"],
					description: "Skill description (when to use this skill). Required for create.",
				},
				content: {
					type: ["string", "null"],
					description:
						"Full SKILL.md content (YAML frontmatter + markdown body). Required for create and edit.",
				},
				source: {
					type: ["string", "null"],
					description:
						'Skill storage location: "global" (~/.roo/skills/) or "project" (.roo/skills/). Default: global.',
					enum: ["global", "project"],
				},
				mode_slugs: {
					type: ["array", "null"],
					items: { type: "string" },
					description: MODE_SLUGS_DESCRIPTION,
				},
				category: {
					type: ["string", "null"],
					description: CATEGORY_DESCRIPTION,
				},
				version: {
					type: ["string", "null"],
					description: "Optional semantic version (e.g., 1.0.0)",
				},
				author: {
					type: ["string", "null"],
					description: "Optional author name",
				},
				tags: {
					type: ["array", "null"],
					items: { type: "string" },
					description: TAGS_DESCRIPTION,
				},
				related_skills: {
					type: ["array", "null"],
					items: { type: "string" },
					description: RELATED_SKILLS_DESCRIPTION,
				},
				old_string: {
					type: ["string", "null"],
					description: "Text to find (for patch action). Must be unique within the file.",
				},
				new_string: {
					type: ["string", "null"],
					description: "Replacement text (for patch action). Pass empty string to delete.",
				},
				replace_all: {
					type: ["boolean", "null"],
					description: "Replace all occurrences instead of requiring a unique match (patch action only).",
				},
				target: {
					type: ["string", "null"],
					description: "Target skill name for merge action — the skill that absorbs others.",
				},
				absorb: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Skills to absorb into the target (merge action).",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
