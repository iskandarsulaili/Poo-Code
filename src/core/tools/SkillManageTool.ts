import * as fs from "fs/promises"
import * as path from "path"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import type { SkillMetadata } from "../../shared/skills"
import { getGlobalRooDirectory } from "../../services/roo-config"
import { validateSkillName } from "@roo-code/types"

// Hermes-style skill_manage: create/patch/edit/delete/merge/list
interface SkillManageParams {
	action: "create" | "patch" | "edit" | "delete" | "merge" | "list"
	name?: string
	description?: string
	content?: string
	source?: "global" | "project"
	mode_slugs?: string[]
	category?: string
	version?: string
	author?: string
	tags?: string[]
	related_skills?: string[]
	old_string?: string
	new_string?: string
	replace_all?: boolean
	target?: string
	absorb?: string[]
}

export class SkillManageTool extends BaseTool<"skill_manage"> {
	readonly name = "skill_manage" as const

	async execute(params: SkillManageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { action } = params
		const { pushToolResult } = callbacks

		try {
			const provider = task.providerRef.deref()
			const skillsManager = provider?.getSkillsManager()

			if (!skillsManager) {
				pushToolResult(formatResponse.toolError("Skills Manager not available"))
				return
			}

			switch (action) {
				case "create":
					await this.handleCreate(params, task, callbacks, skillsManager)
					break
				case "patch":
					await this.handlePatch(params, task, callbacks, skillsManager)
					break
				case "edit":
					await this.handleEdit(params, task, callbacks, skillsManager)
					break
				case "delete":
					await this.handleDelete(params, task, callbacks, skillsManager)
					break
				case "merge":
					await this.handleMerge(params, task, callbacks, skillsManager)
					break
				case "list":
					await this.handleList(params, task, callbacks, skillsManager)
					break
				default:
					pushToolResult(formatResponse.toolError(`Unknown action: ${action}`))
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			pushToolResult(formatResponse.toolError(`skill_manage failed: ${msg}`))
		}
	}

	private async handleCreate(
		params: SkillManageParams,
		task: Task,
		callbacks: ToolCallbacks,
		skillsManager: any,
	): Promise<void> {
		const {
			name,
			description,
			content,
			source = "global",
			mode_slugs,
			category,
			version,
			author,
			tags,
			related_skills,
		} = params
		const { askApproval, pushToolResult } = callbacks

		if (!name || !description) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("skill_manage", "name, description"))
			return
		}

		// Validate skill name format
		const validation = validateSkillName(name)
		if (!validation.valid) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(
					`Skill name must be 1-64 characters, lowercase alphanumeric with hyphens (got ${name.length})`,
				),
			)
			return
		}

		// Build rich frontmatter
		const frontmatterParts: string[] = [`name: ${name}`, `description: "${description}"`]
		if (version) frontmatterParts.push(`version: ${version}`)
		if (author) frontmatterParts.push(`author: ${author}`)
		if (category) frontmatterParts.push(`category: ${category}`)
		if (tags && tags.length > 0) frontmatterParts.push(`tags: [${tags.join(", ")}]`)
		if (related_skills && related_skills.length > 0)
			frontmatterParts.push(`related_skills: [${related_skills.join(", ")}]`)
		if (mode_slugs && mode_slugs.length > 0) frontmatterParts.push(`mode_slugs: [${mode_slugs.join(", ")}]`)

		// Build full SKILL.md content
		const mdBody = content?.trim() || `# ${name}\n\n${description}\n`
		const fullContent = `---\n${frontmatterParts.join("\n")}\n---\n\n${mdBody}\n`

		// Approval
		const approveMsg = JSON.stringify({
			tool: "skill_manage",
			action: "create",
			skill: name,
			description,
			source,
			category: category || "none",
		})
		const approved = await askApproval("tool", approveMsg)
		if (!approved) {
			pushToolResult(`User declined skill creation: "${name}"`)
			return
		}

		task.consecutiveMistakeCount = 0

		// Determine skill directory with category support
		const provider = task.providerRef.deref()
		let baseDir: string
		if (source === "global") {
			baseDir = getGlobalRooDirectory()
		} else {
			if (!provider?.cwd) {
				throw new Error("No workspace open for project skill")
			}
			baseDir = path.join(provider.cwd, ".roo")
		}

		const skillsDir = path.join(baseDir, "skills")
		// If category provided, nest under category dir
		const skillDir = category ? path.join(skillsDir, category, name) : path.join(skillsDir, name)

		const skillMdPath = path.join(skillDir, "SKILL.md")

		// Check if already exists
		try {
			await fs.access(skillMdPath)
			pushToolResult(formatResponse.toolError(`Skill already exists at ${skillMdPath}`))
			return
		} catch {
			// Good — doesn't exist yet
		}

		await fs.mkdir(skillDir, { recursive: true })
		await fs.writeFile(skillMdPath, fullContent, "utf-8")
		await skillsManager.discoverSkills()

		pushToolResult(`Skill created: "${name}" at ${skillMdPath}${category ? ` (category: ${category})` : ""}`)
	}

	private async handlePatch(
		params: SkillManageParams,
		task: Task,
		callbacks: ToolCallbacks,
		skillsManager: any,
	): Promise<void> {
		const { name, old_string, new_string, replace_all } = params
		const { askApproval, pushToolResult } = callbacks

		if (!name || old_string === undefined || old_string === null) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("skill_manage", "name, old_string"))
			return
		}

		// Validate skill name format
		const nameValidation = validateSkillName(name)
		if (!nameValidation.valid) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(
					`Skill name must be 1-64 characters, lowercase alphanumeric with hyphens (got ${name.length})`,
				),
			)
			return
		}

		// Find the skill file
		const skillPath = await this.resolveSkillPath(name, task, skillsManager)
		if (!skillPath) {
			pushToolResult(formatResponse.toolError(`Skill not found: "${name}"`))
			return
		}

		const content = await fs.readFile(skillPath, "utf-8")

		// Find and replace
		if (!replace_all) {
			const idx = content.indexOf(old_string!)
			if (idx === -1) {
				pushToolResult(
					formatResponse.toolError(`Could not find "${old_string!.substring(0, 50)}..." in ${name}`),
				)
				return
			}
			const secondIdx = content.indexOf(old_string!, idx + 1)
			if (secondIdx !== -1) {
				pushToolResult(
					formatResponse.toolError(
						`Found multiple matches for the search string. Use replace_all=true to replace all, or provide more context to make the match unique.`,
					),
				)
				return
			}
		}

		const replacement = new_string ?? ""
		const newContent = replace_all
			? content.split(old_string!).join(replacement)
			: content.replace(old_string!, replacement)

		if (newContent === content) {
			pushToolResult("No changes made — old_string not found or identical content")
			return
		}

		// Approval
		const approveMsg = JSON.stringify({ tool: "skill_manage", action: "patch", skill: name })
		const approved = await askApproval("tool", approveMsg)
		if (!approved) {
			pushToolResult(`User declined patch for: "${name}"`)
			return
		}

		task.consecutiveMistakeCount = 0
		await fs.writeFile(skillPath, newContent, "utf-8")
		await skillsManager.discoverSkills()

		pushToolResult(`Skill patched: "${name}" (${skillPath})`)
	}

	private async handleEdit(
		params: SkillManageParams,
		task: Task,
		callbacks: ToolCallbacks,
		skillsManager: any,
	): Promise<void> {
		const { name, content } = params
		const { askApproval, pushToolResult } = callbacks

		if (!name || !content) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("skill_manage", "name, content"))
			return
		}

		// Validate skill name format
		const nameValidation = validateSkillName(name)
		if (!nameValidation.valid) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(
					`Skill name must be 1-64 characters, lowercase alphanumeric with hyphens (got ${name.length})`,
				),
			)
			return
		}

		const skillPath = await this.resolveSkillPath(name, task, skillsManager)
		if (!skillPath) {
			pushToolResult(formatResponse.toolError(`Skill not found: "${name}"`))
			return
		}

		// Approval
		const approveMsg = JSON.stringify({ tool: "skill_manage", action: "edit", skill: name })
		const approved = await askApproval("tool", approveMsg)
		if (!approved) {
			pushToolResult(`User declined edit for: "${name}"`)
			return
		}

		task.consecutiveMistakeCount = 0
		await fs.writeFile(skillPath, content, "utf-8")
		await skillsManager.discoverSkills()

		pushToolResult(`Skill edited: "${name}" (${skillPath})`)
	}

	private async handleDelete(
		params: SkillManageParams,
		task: Task,
		callbacks: ToolCallbacks,
		skillsManager: any,
	): Promise<void> {
		const { name, absorb } = params
		const { askApproval, pushToolResult } = callbacks

		if (!name) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("skill_manage", "name"))
			return
		}

		// Validate skill name format
		const nameValidation = validateSkillName(name)
		if (!nameValidation.valid) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(
					`Skill name must be 1-64 characters, lowercase alphanumeric with hyphens (got ${name.length})`,
				),
			)
			return
		}

		const skillPath = await this.resolveSkillPath(name, task, skillsManager)
		if (!skillPath) {
			pushToolResult(formatResponse.toolError(`Skill not found: "${name}"`))
			return
		}

		const skillDir = path.dirname(skillPath)
		const absorbedMsg = absorb && absorb.length > 0 ? ` (absorbed_into: ${absorb.join(", ")})` : ""

		// Approval
		const approveMsg = JSON.stringify({
			tool: "skill_manage",
			action: "delete",
			skill: name,
			absorbed_into: absorb || undefined,
		})
		const approved = await askApproval("tool", approveMsg)
		if (!approved) {
			pushToolResult(`User declined deletion of: "${name}"`)
			return
		}

		task.consecutiveMistakeCount = 0

		// Delete skill directory recursively
		await fs.rm(skillDir, { recursive: true, force: true })
		await skillsManager.discoverSkills()

		pushToolResult(`Skill deleted: "${name}"${absorbedMsg}`)
	}

	private async handleMerge(
		params: SkillManageParams,
		task: Task,
		callbacks: ToolCallbacks,
		skillsManager: any,
	): Promise<void> {
		const { target, absorb } = params
		const { askApproval, pushToolResult } = callbacks

		if (!target || !absorb || absorb.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("skill_manage", "target, absorb"))
			return
		}

		// Validate target skill name format
		const targetValidation = validateSkillName(target)
		if (!targetValidation.valid) {
			task.consecutiveMistakeCount++
			task.recordToolError("skill_manage")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(
					`Skill name must be 1-64 characters, lowercase alphanumeric with hyphens (got ${target.length})`,
				),
			)
			return
		}

		// Resolve target skill path
		const targetPath = await this.resolveSkillPath(target, task, skillsManager)
		if (!targetPath) {
			pushToolResult(formatResponse.toolError(`Target skill not found: "${target}"`))
			return
		}

		// Read target content
		let targetContent = await fs.readFile(targetPath, "utf-8")

		// Append absorbed skills content
		for (const absorbedName of absorb) {
			const absorbedPath = await this.resolveSkillPath(absorbedName, task, skillsManager)
			if (!absorbedPath) {
				pushToolResult(formatResponse.toolError(`Absorbed skill not found: "${absorbedName}"`))
				return
			}

			const absorbedContent = await fs.readFile(absorbedPath, "utf-8")
			targetContent += `\n\n---\n\n## Merged from: ${absorbedName}\n\n${absorbedContent}`
		}

		// Approval
		const approveMsg = JSON.stringify({
			tool: "skill_manage",
			action: "merge",
			target,
			absorb,
		})
		const approved = await askApproval("tool", approveMsg)
		if (!approved) {
			pushToolResult(`User declined merge into: "${target}"`)
			return
		}

		task.consecutiveMistakeCount = 0

		// Write merged content
		await fs.writeFile(targetPath, targetContent, "utf-8")

		// Delete absorbed skills
		for (const absorbedName of absorb) {
			const absorbedPath = await this.resolveSkillPath(absorbedName, task, skillsManager)
			if (absorbedPath) {
				await fs.rm(path.dirname(absorbedPath), { recursive: true, force: true })
			}
		}

		await skillsManager.discoverSkills()
		pushToolResult(`Skills merged: ${absorb.join(", ")} → "${target}"`)
	}

	private async handleList(
		_params: SkillManageParams,
		task: Task,
		callbacks: ToolCallbacks,
		skillsManager: any,
	): Promise<void> {
		const { pushToolResult } = callbacks
		const skills: SkillMetadata[] = skillsManager.getSkillsMetadata()

		if (skills.length === 0) {
			pushToolResult("No skills available.")
			return
		}

		// Group by category
		const byCategory = new Map<string, SkillMetadata[]>()
		for (const skill of skills) {
			const cat = skill.category || "uncategorized"
			if (!byCategory.has(cat)) byCategory.set(cat, [])
			byCategory.get(cat)!.push(skill)
		}

		const lines: string[] = []
		for (const [cat, catSkills] of byCategory) {
			lines.push(`\n# ${cat}`)
			for (const s of catSkills) {
				const modeInfo = s.modeSlugs?.length ? ` [modes: ${s.modeSlugs.join(", ")}]` : ""
				const tagInfo = s.tags?.length ? ` tags: ${s.tags.join(", ")}` : ""
				const versionInfo = s.version ? ` v${s.version}` : ""
				lines.push(`  • ${s.name}${versionInfo} — ${s.description}${modeInfo}${tagInfo}`)
			}
		}

		pushToolResult(lines.join("\n"))
	}

	/**
	 * Resolve a skill name to its SKILL.md path by searching all known skills.
	 */
	private async resolveSkillPath(name: string, task: Task, skillsManager: any): Promise<string | null> {
		const skills: SkillMetadata[] = skillsManager.getSkillsMetadata()
		const match = skills.find((s: SkillMetadata) => s.name === name)
		return match?.path ?? null
	}
}

// Export singleton
export const skillManageTool = new SkillManageTool()
