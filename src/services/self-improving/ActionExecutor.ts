import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"
import matter from "gray-matter"

import { SKILL_NAME_MAX_LENGTH } from "@roo-code/types"
import type { MemoryBackend } from "./MemoryBackend"
import type { SkillProvenance, SkillUsageStore } from "./SkillUsageStore"
import type { ImprovementAction, Logger } from "./types"

interface SkillMutationManager {
	createSkillFromContent(
		name: string,
		source: "global" | "project",
		description: string,
		content: string,
		modeSlugs?: string[],
	): Promise<string>
	updateSkillContent(name: string, source: "global" | "project", content: string, mode?: string): Promise<void>
	getSkillContent?(name: string, currentMode?: string): Promise<{ instructions: string } | null>
}

/**
 * Bundled asset reference for SKILL_CREATE_FROM_SCRATCH.
 */
interface BundledAsset {
	/** Relative path within the skill directory (e.g., "scripts/validate.sh") */
	relativePath: string
	/** File content as string */
	content: string
}

/**
 * ActionExecutor - consumes the pending action queue and executes
 * improvement actions transactionally.
 *
 * Each action type maps to a specific executor:
 * - PROMPT_ENRICHMENT: writes to MemoryStore (environment)
 * - ERROR_AVOIDANCE: writes to MemoryStore (environment, with error tags)
 * - TOOL_PREFERENCE: writes to MemoryStore (environment, with tool tags)
 * - SKILL_SUGGESTION: records in SkillUsageStore for future user approval
 * - SKILL_CREATE / SKILL_UPDATE: safely mutate agent-managed skills via SkillsManager
 *
 * Actions are removed from the queue only after successful execution.
 * Failed actions remain pending for later retry.
 */
export class ActionExecutor {
	private readonly memoryStore: MemoryBackend
	private readonly skillUsageStore: SkillUsageStore
	private readonly logger: Logger
	private readonly skillsManager?: SkillMutationManager

	constructor(
		memoryStore: MemoryBackend,
		skillUsageStore: SkillUsageStore,
		logger: Logger,
		skillsManager?: SkillMutationManager,
	) {
		this.memoryStore = memoryStore
		this.skillUsageStore = skillUsageStore
		this.logger = logger
		this.skillsManager = skillsManager
	}

	/**
	 * Execute a single improvement action.
	 * Returns true if the action was executed successfully.
	 */
	async execute(action: ImprovementAction): Promise<boolean> {
		try {
			let executed = false

			switch (action.actionType) {
				case "PROMPT_ENRICHMENT":
					executed = await this.executePromptEnrichment(action)
					break
				case "ERROR_AVOIDANCE":
					executed = await this.executeErrorAvoidance(action)
					break
				case "TOOL_PREFERENCE":
					executed = await this.executeToolPreference(action)
					break
				case "SKILL_SUGGESTION":
					executed = await this.executeSkillSuggestion(action)
					break
				case "SKILL_CREATE":
					executed = await this.executeSkillCreate(action)
					break
				case "SKILL_UPDATE":
					executed = await this.executeSkillUpdate(action)
					break
				case "SKILL_MERGE":
					executed = await this.executeSkillMerge(action)
					break
				case "SKILL_CREATE_FROM_SCRATCH":
					executed = await this.executeSkillCreateFromScratch(action)
					break
				default:
					this.logger.appendLine(`[ActionExecutor] Unknown action type: ${action.actionType}`)
					return false
			}

			this.logger.appendLine(
				`[ActionExecutor] ${executed ? "OK" : "DEF"} ${action.actionType} ${action.id} | ${(action as any).description?.substring(0, 100) ?? ""}`,
			)

			return executed
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			// Silently skip "already exists" errors — skill was already created by a prior cycle
			if (errorMsg.toLowerCase().includes("already exists")) {
				this.logger.appendLine(`[ActionExecutor] Skill already exists, skipping: ${action.id}`)
				return true // Don't count as error — skill is already present
			}
			this.logger.appendLine(`[ActionExecutor] Execution error for ${action.id}: ${errorMsg}`)
			return false
		}
	}

	/**
	 * Execute a batch of actions.
	 * Returns the set of successfully executed action IDs.
	 */
	async executeBatch(actions: ImprovementAction[]): Promise<Set<string>> {
		const succeeded = new Set<string>()

		for (const action of actions) {
			const ok = await this.execute(action)
			if (ok) {
				succeeded.add(action.id)
			}
		}

		return succeeded
	}

	private async executePromptEnrichment(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		if (!summary) {
			return false
		}

		await this.memoryStore.store({
			content: summary,
			source: "learning",
			tags: ["learned", "prompt"],
		})

		return true
	}

	private async executeErrorAvoidance(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		const errorKeys = this.readStringArrayPayload(action.payload.errorKeys)

		if (!summary) {
			return false
		}

		await this.memoryStore.store({
			content: summary,
			source: "learning",
			tags: ["error-avoidance", ...errorKeys.map((key) => `error:${key}`)],
		})

		return true
	}

	private async executeToolPreference(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		const toolNames = this.readStringArrayPayload(action.payload.toolNames)

		if (!summary) {
			return false
		}

		await this.memoryStore.store({
			content: summary,
			source: "learning",
			tags: ["tool-preference", ...toolNames.map((toolName) => `tool:${toolName}`)],
		})

		return true
	}

	private async executeSkillSuggestion(action: ImprovementAction): Promise<boolean> {
		const summary = this.readStringPayload(action.payload.summary)
		if (!summary) {
			return false
		}

		const skillName = this.readStringPayload(action.payload.skillName) ?? summary
		const skillId =
			this.readStringPayload(action.payload.skillId) ??
			`suggested:${crypto.createHash("sha256").update(skillName.toLowerCase()).digest("hex").slice(0, 16)}`
		const createdBy = this.readSkillProvenance(action.payload.createdBy) ?? "agent"

		this.skillUsageStore.getOrCreate(skillId, skillName, createdBy)
		this.logger.appendLine(`[ActionExecutor] Skill suggestion recorded: ${summary}`)

		return true
	}

	private async executeSkillCreate(action: ImprovementAction): Promise<boolean> {
		if (!this.skillsManager) {
			this.logger.appendLine("[ActionExecutor] skillsManager not available — deferring SKILL_CREATE")
			return false
		}

		const skillName = this.readStringPayload(action.payload.skillName)
		const description = this.readStringPayload(action.payload.description)
		const content = this.readStringPayload(action.payload.content)
		const source = this.readSkillSource(action.payload.source)
		const modeSlugs = this.readStringArrayPayload(action.payload.modeSlugs)
		const skillId = this.readStringPayload(action.payload.skillId) ?? this.buildSkillId(skillName, source)
		const createdBy = this.readSkillProvenance(action.payload.createdBy) ?? "agent"

		if (!skillName || !description || !content || !source || !skillId) {
			return false
		}

		// Validate skill name format — with defense-in-depth truncation
		const safeName = this.enforceSafeSkillName(skillName)
		const { validateSkillName } = await import("@roo-code/types")
		const validation = validateSkillName(safeName)
		if (!validation.valid) {
			this.logger.appendLine(
				`[ActionExecutor] SKILL_CREATE invalid skill name "${safeName}" (original: "${skillName}"): ${validation.error}`,
			)
			return false
		}

		// If name was truncated, patch the content's frontmatter name to match safeName
		const resolvedContent = safeName !== skillName ? this.patchFrontmatterName(content, safeName) : content

		await this.skillsManager.createSkillFromContent(safeName, source, description, resolvedContent, modeSlugs)
		this.skillUsageStore.getOrCreate(skillId, safeName, createdBy)
		this.logger.appendLine(`[ActionExecutor] Skill created: ${safeName}`)
		return true
	}

	private async executeSkillUpdate(action: ImprovementAction): Promise<boolean> {
		if (!this.skillsManager) {
			return false
		}

		const skillName = this.readStringPayload(action.payload.skillName)
		const content = this.readStringPayload(action.payload.content)
		const source = this.readSkillSource(action.payload.source)
		const mode = this.readStringPayload(action.payload.mode)
		const skillId = this.readStringPayload(action.payload.skillId) ?? this.buildSkillId(skillName, source)

		if (!skillName || !content || !source || !skillId) {
			return false
		}

		// Validate skill name format — with defense-in-depth truncation
		const safeName = this.enforceSafeSkillName(skillName)
		const { validateSkillName } = await import("@roo-code/types")
		const validation = validateSkillName(safeName)
		if (!validation.valid) {
			this.logger.appendLine(
				`[ActionExecutor] SKILL_UPDATE invalid skill name "${safeName}" (original: "${skillName}"): ${validation.error}`,
			)
			return false
		}

		// If name was truncated, patch the content's frontmatter name to match safeName
		const resolvedContent = safeName !== skillName ? this.patchFrontmatterName(content, safeName) : content

		// Deduplication check: skip update if skill content hasn't changed
		if (this.skillsManager.getSkillContent) {
			try {
				const existing = await this.skillsManager.getSkillContent(skillName, mode)
				if (existing && existing.instructions.trim() === resolvedContent.trim()) {
					this.logger.appendLine(`[ActionExecutor] Skill content unchanged for ${skillName}, skipping update`)
					return false
				}
			} catch {
				// If we can't read the existing content, proceed with update
				this.logger.appendLine(
					`[ActionExecutor] Could not read existing skill content for ${skillName}, proceeding with update`,
				)
			}
		}

		await this.skillsManager.updateSkillContent(safeName, source, resolvedContent, mode)
		this.skillUsageStore.getOrCreate(skillId, safeName, "agent")
		await this.skillUsageStore.bumpPatch(skillId)
		this.logger.appendLine(`[ActionExecutor] Skill updated: ${safeName}`)
		return true
	}

	private async executeSkillMerge(action: ImprovementAction): Promise<boolean> {
		const umbrellaName = this.readStringPayload(action.payload.umbrellaName)
		const absorbNamesRaw = action.payload.absorbNames
		const absorbNames: string[] = Array.isArray(absorbNamesRaw)
			? absorbNamesRaw.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
			: []
		const newContent = this.readStringPayload(action.payload.content)

		if (!umbrellaName || absorbNames.length === 0) {
			return false
		}

		// Validate umbrella skill name format — with defense-in-depth truncation
		const safeName = this.enforceSafeSkillName(umbrellaName)
		const { validateSkillName } = await import("@roo-code/types")
		const validation = validateSkillName(safeName)
		if (!validation.valid) {
			this.logger.appendLine(
				`[ActionExecutor] SKILL_MERGE invalid umbrella name "${safeName}" (original: "${umbrellaName}"): ${validation.error}`,
			)
			return false
		}

		// 1. Create or update the umbrella skill
		if (newContent) {
			const source = this.readSkillSource(action.payload.source) ?? "global"
			const skillId = `skill:${source}:${safeName}`
			const description =
				this.readStringPayload(action.payload.description) ?? `Umbrella skill merging ${absorbNames.join(", ")}`
			const modeSlugs = this.readStringArrayPayload(action.payload.modeSlugs)

			if (this.skillsManager) {
				const existing = this.skillUsageStore.get(skillId)
				if (existing) {
					await this.skillsManager.updateSkillContent(safeName, source, newContent, modeSlugs[0])
					await this.skillUsageStore.bumpPatch(skillId)
				} else {
					await this.skillsManager.createSkillFromContent(
						safeName,
						source,
						description,
						newContent,
						modeSlugs,
					)
					this.skillUsageStore.getOrCreate(skillId, safeName, "agent")
				}
			} else {
				this.skillUsageStore.getOrCreate(skillId, safeName, "agent")
			}
		}

		// 2. Mark each absorbed skill
		for (const absorbName of absorbNames) {
			const source = this.readSkillSource(action.payload.source) ?? "global"
			const absorbId = `skill:${source}:${absorbName}`
			this.skillUsageStore.setAbsorbedInto(absorbId, safeName)
			await this.skillUsageStore.transitionState(absorbId, "archived")
			this.logger.appendLine(`[ActionExecutor] Merged ${absorbName} into ${safeName}`)
		}

		this.logger.appendLine(`[ActionExecutor] Merge complete: ${absorbNames.length} skills → ${safeName}`)
		return true
	}

	/**
	 * Execute SKILL_CREATE_FROM_SCRATCH — creates a full specialized skill
	 * with proper frontmatter, instructions, and optional bundled assets.
	 *
	 * Payload fields:
	 * - name: skill name (validated per agentskills.io spec)
	 * - description: skill description
	 * - instructions: full markdown body (without frontmatter)
	 * - modeSlugs?: string[] — mode restrictions
	 * - tools?: string[] — tool references for the skill
	 * - assets?: BundledAsset[] — referenced scripts/assets to bundle
	 * - source: "global" | "project"
	 */
	private async executeSkillCreateFromScratch(action: ImprovementAction): Promise<boolean> {
		if (!this.skillsManager) {
			this.logger.appendLine("[ActionExecutor] skillsManager not available — deferring SKILL_CREATE_FROM_SCRATCH")
			return false
		}

		const name = this.readStringPayload(action.payload.name)
		const description = this.readStringPayload(action.payload.description)
		const instructions = this.readStringPayload(action.payload.instructions)
		const source = this.readSkillSource(action.payload.source)
		const modeSlugs = this.readStringArrayPayload(action.payload.modeSlugs)
		const tools = this.readStringArrayPayload(action.payload.tools)
		const assets = this.readAssetsPayload(action.payload.assets)
		const skillId = this.readStringPayload(action.payload.skillId) ?? this.buildSkillId(name, source)
		const createdBy = this.readSkillProvenance(action.payload.createdBy) ?? "agent"

		if (!name || !description || !instructions || !source || !skillId) {
			this.logger.appendLine(
				`[ActionExecutor] SKILL_CREATE_FROM_SCRATCH missing required fields: name=${!!name} desc=${!!description} instr=${!!instructions} source=${!!source}`,
			)
			return false
		}

		// Validate skill name format — with defense-in-depth truncation
		const safeName = this.enforceSafeSkillName(name)
		const { validateSkillName } = await import("@roo-code/types")
		const validation = validateSkillName(safeName)
		if (!validation.valid) {
			this.logger.appendLine(
				`[ActionExecutor] SKILL_CREATE_FROM_SCRATCH invalid skill name "${safeName}" (original: "${name}"): ${validation.error}`,
			)
			return false
		}

		// Use truncated safeName for the actual skill creation
		const resolvedName = safeName !== name ? safeName : name

		// Build full SKILL.md content with frontmatter (using resolved name)
		const domains = this.readStringArrayPayload(action.payload.domains)
		const versatilityScore = this.readNumberPayload(action.payload.versatilityScore)
		const crossDomainPatterns = this.readStringArrayPayload(action.payload.crossDomainPatterns)

		const frontmatterParts = [`name: ${resolvedName}`, `description: ${description}`]
		if (modeSlugs.length > 0) {
			frontmatterParts.push("modeSlugs:")
			for (const slug of modeSlugs) {
				frontmatterParts.push(`  - ${slug}`)
			}
		}
		if (tools.length > 0) {
			frontmatterParts.push("tools:")
			for (const tool of tools) {
				frontmatterParts.push(`  - ${tool}`)
			}
		}
		if (domains.length > 0) {
			frontmatterParts.push("domains:")
			for (const d of domains) {
				frontmatterParts.push(`  - ${d}`)
			}
		}
		if (versatilityScore !== undefined) {
			frontmatterParts.push(`versatilityScore: ${versatilityScore}`)
		}
		if (crossDomainPatterns.length > 0) {
			frontmatterParts.push("crossDomainPatterns:")
			for (const p of crossDomainPatterns) {
				frontmatterParts.push(`  - ${p}`)
			}
		}

		const resolvedContent = `---
${frontmatterParts.join("\n")}
---

${instructions.trim()}
`

		// Create the skill via SkillsManager
		await this.skillsManager.createSkillFromContent(resolvedName, source, description, resolvedContent, modeSlugs)

		// Bundle referenced assets if provided
		if (assets.length > 0) {
			await this.bundleAssets(resolvedName, source, assets)
		}

		this.skillUsageStore.getOrCreate(skillId, resolvedName, createdBy)
		this.logger.appendLine(`[ActionExecutor] Specialized skill created from scratch: ${resolvedName}`)
		return true
	}

	/**
	 * Bundle referenced assets into the skill directory.
	 */
	private async bundleAssets(skillName: string, source: "global" | "project", assets: BundledAsset[]): Promise<void> {
		try {
			// Determine skill directory path
			const { getGlobalRooDirectory } = await import("../roo-config")
			let baseDir: string
			if (source === "global") {
				baseDir = getGlobalRooDirectory()
			} else {
				// For project skills, we need the cwd — best-effort
				baseDir = process.cwd()
			}

			const skillDir = path.join(baseDir, "skills", skillName)
			await fs.mkdir(skillDir, { recursive: true })

			for (const asset of assets) {
				const assetPath = path.join(skillDir, asset.relativePath)
				await fs.mkdir(path.dirname(assetPath), { recursive: true })
				await fs.writeFile(assetPath, asset.content, "utf-8")
				this.logger.appendLine(`[ActionExecutor] Bundled asset: ${asset.relativePath}`)
			}
		} catch (error) {
			this.logger.appendLine(
				`[ActionExecutor] Asset bundling error for "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Parse bundled assets from payload.
	 */
	private readAssetsPayload(value: unknown): BundledAsset[] {
		if (!Array.isArray(value)) {
			return []
		}

		return value.filter(
			(item): item is BundledAsset =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as any).relativePath === "string" &&
				typeof (item as any).content === "string",
		)
	}

	private readStringPayload(value: unknown): string | undefined {
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	}

	private readStringArrayPayload(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return []
		}

		return Array.from(
			new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)),
		)
	}

	private readNumberPayload(value: unknown): number | undefined {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value
		}
		if (typeof value === "string") {
			const parsed = Number(value)
			if (Number.isFinite(parsed)) {
				return parsed
			}
		}
		return undefined
	}

	private readSkillProvenance(value: unknown): SkillProvenance | undefined {
		return value === "agent" || value === "user" || value === "bundled" || value === "hub" || value === "unknown"
			? value
			: undefined
	}

	private readSkillSource(value: unknown): "global" | "project" | undefined {
		return value === "global" || value === "project" ? value : undefined
	}

	private buildSkillId(skillName: string | undefined, source: "global" | "project" | undefined): string | undefined {
		return skillName && source ? `skill:${source}:${skillName}` : undefined
	}

	/**
	 * Defense-in-depth: ensure a skill name is safe before passing to validateSkillName.
	 * Truncates and normalizes the name if it exceeds SKILL_NAME_MAX_LENGTH (64 chars)
	 * or contains consecutive hyphens. Uses DJB2 hash suffix like ImprovementApplier.truncateSkillName.
	 */
	private enforceSafeSkillName(name: string): string {
		// Normalize consecutive hyphens and strip leading/trailing hyphens
		let normalized = name.replace(/--+/g, "-").replace(/^-+|-+$/g, "")
		if (normalized.length === 0) {
			normalized = "skill"
		}
		if (normalized.length <= SKILL_NAME_MAX_LENGTH) {
			return normalized
		}
		// DJB2 hash for deterministic 8-char hex suffix
		let hash = 5381
		for (let i = 0; i < normalized.length; i++) {
			hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0
		}
		const hashHex = (hash >>> 0).toString(16).padStart(8, "0")
		let truncated = normalized.slice(0, SKILL_NAME_MAX_LENGTH - 9)
		truncated = truncated.replace(/-+$/, "")
		return `${truncated}-${hashHex}`
	}

	/**
	 * Patch the frontmatter `name` field in SKILL.md content to a new name.
	 * Uses gray-matter for reliable YAML frontmatter manipulation.
	 */
	private patchFrontmatterName(content: string, newName: string): string {
		const parsed = matter(content)
		parsed.data.name = newName
		return matter.stringify(parsed.content, parsed.data)
	}
}
