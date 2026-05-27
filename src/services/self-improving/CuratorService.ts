import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Logger } from "./types"
import type { SkillTelemetryRecord, SkillUsageStore } from "./SkillUsageStore"
import { createTarGzip, extractTarGzip } from "./tarUtils"

/**
 * Curator configuration
 */
export interface CuratorConfig {
	/** Minimum interval between curator runs (ms) */
	intervalMs: number
	/** Minimum idle time since last user activity before curator runs (ms) */
	minIdleMs: number
	/** Whether to defer the first curator run */
	firstRunDeferred: boolean
	/** Days of inactivity before a skill is marked stale */
	staleAfterDays: number
	/** Days of inactivity before a stale skill is archived */
	archiveAfterDays: number
	/** Whether to create pre-run backups */
	backupsEnabled: boolean
	/** Maximum number of backup snapshots to retain */
	maxBackups: number
	/** Absolute path to the skills directory for tar.gz snapshots */
	skillsDir?: string
	/** Whether LLM review is enabled (requires LLMReviewProvider impl) */
	llmReviewEnabled: boolean
}

/**
 * Default curator configuration
 */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
	intervalMs: 3_600_000,
	minIdleMs: 300_000,
	firstRunDeferred: true,
	staleAfterDays: 14,
	archiveAfterDays: 60,
	backupsEnabled: true,
	maxBackups: 5,
	llmReviewEnabled: true,
}

/**
 * Action parsed from LLM review output.
 */
export type CuratorAction =
	| { action: "merge"; target: string; absorb: string[] }
	| { action: "archive"; name: string }
	| { action: "pin"; name: string }
	| { action: "unpin"; name: string }
	| { action: "restore"; name: string }
	| {
			action: "demote"
			name: string
			demoteTarget: "reference" | "template" | "script"
			umbrellaSkillId: string
			umbrellaSkillName: string
	  }

/**
 * Reference to a cron job file that references a skill.
 */
type CronJobReference = {
	jobId: string
	jobName: string
	skillId: string
	skillName: string
	filePath: string
}

/**
 * Curator run report
 */
export interface CuratorReport {
	runId: string
	timestamp: number
	durationMs: number
	transitions: Array<{
		skillId: string
		skillName: string
		fromState: string
		toState: string
		reason: string
	}>
	stats: {
		totalSkills: number
		activeSkills: number
		staleSkills: number
		archivedSkills: number
		pinnedSkills: number
		transitionsApplied: number
	}
	backupPath?: string
	error?: string
	/** LLM-generated actions that were applied */
	llmActions?: CuratorAction[]
	/** Pre-consolidation skill count (before LLM actions) */
	preConsolidationCount?: number
	/** Skills that were absorbed into an umbrella */
	absorbedSkills?: Array<{
		skillName: string
		absorbedInto: string
	}>
	/** Three-tier classifications for archived skills */
	classifications?: Array<{
		skillId: string
		skillName: string
		tier: ClassificationTier
		absorbedInto: string | null
		summary: string
		confidence: "high" | "medium" | "low"
	}>
	/** Cron job files that had skill references rewritten after consolidation */
	cronReferencesUpdated?: Array<{
		jobName: string
		oldSkillId: string
		newSkillId: string
	}>
}

/**
 * Three-tier classification for archived skills.
 * Mirrors Hermes-agent's classification system:
 * 1. declared — model-declared absorbed_into at delete time
 * 2. yaml_block — model's structured YAML summary block in SKILL.md
 * 3. heuristic — tool-call heuristic audit as fallback
 */
type ClassificationTier = "declared" | "yaml_block" | "heuristic" | "unclassified"

type ClassificationResult = {
	tier: ClassificationTier
	absorbedInto: string | null
	summary: string
	confidence: "high" | "medium" | "low"
}

type CuratorStatus = {
	lastRunAt: number
	firstRunDone: boolean
	config: CuratorConfig
}

/**
 * LLMReviewProvider interface — pluggable LLM reviewer for curator.
 * Default implementation logs the prompt but does not call an LLM.
 */
export interface LLMReviewProvider {
	/**
	 * Submit a curator review prompt and return structured YAML actions.
	 * @param prompt The full CURATOR_REVIEW_PROMPT + candidate table
	 * @returns Parsed CuratorAction[] or empty array if no actions
	 */
	review(prompt: string): Promise<CuratorAction[]>
}

/**
 * Default no-op LLM review provider.
 * Logs the prompt via the curator's logger but returns no actions.
 */
class NoopLLMReviewProvider implements LLMReviewProvider {
	private readonly logger: Logger

	constructor(logger: Logger) {
		this.logger = logger
	}

	async review(prompt: string): Promise<CuratorAction[]> {
		this.logger.appendLine(
			`[CuratorService] NoopLLMReviewProvider: LLM review not configured. Prompt length: ${prompt.length} chars`,
		)
		return []
	}
}

/**
 * CURATOR_REVIEW_PROMPT — markdown prompt sent to the LLM for umbrella consolidation.
 */
const CURATOR_REVIEW_PROMPT = `You are a skill curator for an agent skill library. Review the following candidate skills and recommend consolidation actions.

Return ONLY valid YAML with a top-level "actions" key. Each action must be one of:

1. **merge** — absorb several overlapping/duplicate skills into an umbrella skill
   {action: merge, target: "umbrella-name", absorb: ["skill-a", "skill-b"]}

2. **archive** — mark a skill for archival (low usage, no recent activity)
   {action: archive, name: "skill-x"}

3. **pin** — protect a skill from auto-mutation
   {action: pin, name: "skill-y"}

4. **unpin** — allow auto-mutation on a previously pinned skill
   {action: unpin, name: "skill-z"}

5. **restore** — bring an archived skill back to active
   {action: restore, name: "skill-w"}

6. **demote** — move a narrow/specific skill under an umbrella as a reference, template, or script
   {action: demote, name: "skill-v", demoteTarget: "reference", umbrellaSkillId: "umbrella-id", umbrellaSkillName: "umbrella-name"}
   demoteTarget must be one of: "reference", "template", "script"

Rules:
- Only recommend merges for skills with clear overlap in purpose or domain.
- The "target" of a merge is the umbrella skill name (existing or new).
- Skills listed in "absorb" will be marked as absorbed_into the target.
- Prefer pinning high-value skills that should not be mutated.
- Archive skills that are stale, unused, or superseded.
- Use **demote** for narrow skills that are a subset of an umbrella's domain.
  The skill's content is moved into a subdirectory (references/, templates/, or scripts/)
  under the umbrella skill directory, and the original skill is marked as absorbed.

Now review the following candidate table:
`

/**
 * CuratorService — telemetry-driven skill lifecycle management.
 */
export class CuratorService {
	private readonly baseDir: string
	private readonly statePath: string
	private readonly backupsDir: string
	private readonly reportsDir: string
	private readonly skillUsageStore: SkillUsageStore
	private readonly logger: Logger
	private config: CuratorConfig
	private lastRunAt = 0
	private firstRunDone = false
	private initialized = false
	private llmProvider: LLMReviewProvider

	constructor(baseDir: string, skillUsageStore: SkillUsageStore, logger: Logger, config?: Partial<CuratorConfig>) {
		this.baseDir = path.join(baseDir, "self-improving", "curator")
		this.statePath = path.join(this.baseDir, "state.json")
		this.backupsDir = path.join(this.baseDir, "backups")
		this.reportsDir = path.join(this.baseDir, "reports")
		this.skillUsageStore = skillUsageStore
		this.logger = logger
		this.config = { ...DEFAULT_CURATOR_CONFIG, ...config }
		this.llmProvider = new NoopLLMReviewProvider(logger)
	}

	/**
	 * Set a custom LLM review provider (e.g. one that calls an actual LLM).
	 */
	setLLMReviewProvider(provider: LLMReviewProvider): void {
		this.llmProvider = provider
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		try {
			await fs.mkdir(this.backupsDir, { recursive: true })
			await fs.mkdir(this.reportsDir, { recursive: true })
			await this.loadState()
			this.logger.appendLine("[CuratorService] Initialized")
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
		}
	}

	shouldRun(now: number, lastUserActivityAt?: number): boolean {
		if (this.config.firstRunDeferred && !this.firstRunDone && this.lastRunAt === 0) {
			return false
		}

		if (now - this.lastRunAt < this.config.intervalMs) {
			return false
		}

		if (typeof lastUserActivityAt === "number" && now - lastUserActivityAt < this.config.minIdleMs) {
			return false
		}

		return true
	}

	async run(now: number, lastUserActivityAt?: number): Promise<CuratorReport> {
		await this.initialize()

		const startedAt = Date.now()
		const runId = crypto.randomUUID()
		const report: CuratorReport = {
			runId,
			timestamp: now,
			durationMs: 0,
			transitions: [],
			stats: {
				totalSkills: 0,
				activeSkills: 0,
				staleSkills: 0,
				archivedSkills: 0,
				pinnedSkills: 0,
				transitionsApplied: 0,
			},
		}

		try {
			if (this.shouldDeferFirstRun()) {
				this.firstRunDone = true
				await this.saveState()
				report.error = "Skipped: first-run deferral"
				report.durationMs = Date.now() - startedAt
				await this.writeReport(report)
				return report
			}

			if (!this.shouldRun(now, lastUserActivityAt)) {
				report.error = "Skipped: gates not satisfied"
				report.durationMs = Date.now() - startedAt
				await this.writeReport(report)
				return report
			}

			// Set lastRunAt immediately to prevent concurrent runs
			this.lastRunAt = now

			if (this.config.backupsEnabled) {
				report.backupPath = await this.createBackup(runId)
			}

			this.assignStats(report)
			report.preConsolidationCount = report.stats.totalSkills
			const { transitions, classifications } = await this.applyDeterministicTransitions()
			report.transitions = transitions
			if (classifications.length > 0) {
				report.classifications = classifications
			}
			await this.runCuratorReview(report)
			report.stats.transitionsApplied = report.transitions.length + (report.llmActions?.length ?? 0)
			this.assignStats(report)

			this.firstRunDone = true
			await this.saveState()

			report.durationMs = Date.now() - startedAt
			await this.writeReport(report)
			this.logger.appendLine(
				`[CuratorService] Run ${runId}: ${report.transitions.length} transitions, ${report.llmActions?.length ?? 0} llm-actions in ${report.durationMs}ms`,
			)
		} catch (error) {
			report.error = error instanceof Error ? error.message : String(error)
			report.durationMs = Date.now() - startedAt
			this.logger.appendLine(`[CuratorService] Run error: ${report.error}`)
			await this.writeReport(report)
		}

		return report
	}

	async getLatestReport(): Promise<CuratorReport | null> {
		try {
			const entries = await fs.readdir(this.reportsDir, { withFileTypes: true })
			const candidates = await Promise.all(
				entries
					.filter((entry) => entry.isDirectory())
					.map(async (entry) => {
						const runPath = path.join(this.reportsDir, entry.name, "run.json")
						const stats = await fs.stat(runPath)
						return { runPath, mtimeMs: stats.mtimeMs }
					}),
			)

			if (candidates.length === 0) {
				return null
			}

			candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
			const raw = await fs.readFile(candidates[0].runPath, "utf-8")
			return JSON.parse(raw) as CuratorReport
		} catch {
			return null
		}
	}

	getConfig(): Readonly<CuratorConfig> {
		return this.config
	}

	setConfig(config: Partial<CuratorConfig>): void {
		this.config = { ...this.config, ...config }
	}

	getStatus(): CuratorStatus {
		return {
			lastRunAt: this.lastRunAt,
			firstRunDone: this.firstRunDone,
			config: { ...this.config },
		}
	}

	/**
	 * Restore a backup from a tar.gz file.
	 * Moves the current skill directory aside (as a new backup for undoability)
	 * and extracts the chosen backup into place.
	 *
	 * @param backupPath Absolute path to the .tar.gz backup file
	 * @returns true if restore succeeded, false otherwise
	 */
	async restoreBackup(backupPath: string): Promise<boolean> {
		if (!this.config.skillsDir) {
			this.logger.appendLine("[CuratorService] restoreBackup: no skillsDir configured")
			return false
		}

		try {
			await fs.access(backupPath)
		} catch {
			this.logger.appendLine(`[CuratorService] restoreBackup: backup not found: ${backupPath}`)
			return false
		}

		try {
			const skillsDir = this.config.skillsDir
			const timestamp = Date.now()
			const undoBackupName = `pre-restore-${timestamp}.tar.gz`
			const undoBackupPath = path.join(this.backupsDir, undoBackupName)

			// Move current skill dir into a new tar.gz backup (undo safety net)
			this.logger.appendLine(`[CuratorService] Saving pre-restore snapshot to ${undoBackupPath}`)
			const currentFiles: Array<{ path: string; content: Buffer }> = []
			await this.collectFilesRecursive(skillsDir, skillsDir, currentFiles)
			await createTarGzip(currentFiles, undoBackupPath)

			// Remove current skill dir contents
			await this.clearDirectory(skillsDir)

			// Extract the chosen backup
			this.logger.appendLine(`[CuratorService] Restoring from ${backupPath}`)
			await extractTarGzip(backupPath, skillsDir)

			this.logger.appendLine("[CuratorService] Restore complete")
			return true
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Restore error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return false
		}
	}

	// ──── Private helpers ────

	private async loadState(): Promise<void> {
		try {
			const raw = await fs.readFile(this.statePath, "utf-8")
			const parsed = JSON.parse(raw) as Partial<CuratorStatus>
			this.lastRunAt = typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : 0
			this.firstRunDone = parsed.firstRunDone === true
		} catch {
			this.lastRunAt = 0
			this.firstRunDone = false
		}
	}

	private async saveState(): Promise<void> {
		try {
			await safeWriteJson(
				this.statePath,
				{
					lastRunAt: this.lastRunAt,
					firstRunDone: this.firstRunDone,
				},
				{ prettyPrint: true },
			)
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Save state error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private shouldDeferFirstRun(): boolean {
		return this.config.firstRunDeferred && !this.firstRunDone && this.lastRunAt === 0
	}

	/**
	 * Create a tar.gz backup of skills directory.
	 * Falls back to JSON snapshot if skillsDir is not configured.
	 */
	private async createBackup(runId: string): Promise<string> {
		if (this.config.skillsDir) {
			return this.createTarBackup(runId)
		}
		return this.createJsonSnapshotBackup(runId)
	}

	private async createTarBackup(runId: string): Promise<string> {
		const backupName = `backup-${Date.now()}-${runId}.tar.gz`
		const backupPath = path.join(this.backupsDir, backupName)

		const skillsDir = this.config.skillsDir!
		const files: Array<{ path: string; content: Buffer }> = []

		try {
			await this.collectFilesRecursive(skillsDir, skillsDir, files)
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Warning: could not read skills dir ${skillsDir}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Build manifest
		const manifest = {
			createdAt: Date.now(),
			runId,
			type: "curator-backup",
			skillCount: files.length,
			files: files.map((f) => f.path),
			curatorState: {
				lastRunAt: this.lastRunAt,
				firstRunDone: this.firstRunDone,
			},
			skillUsage: this.skillUsageStore.getAll(),
		}

		const manifestJson = Buffer.from(JSON.stringify(manifest, null, "\t"), "utf-8")

		// Add manifest as first entry (sort ensures it's readable/identifiable)
		files.unshift({
			path: "manifest.json",
			content: manifestJson,
		})

		await createTarGzip(files, backupPath)

		await this.cleanupOldBackups()
		return backupPath
	}

	private async createJsonSnapshotBackup(runId: string): Promise<string> {
		const backupDir = path.join(this.backupsDir, `backup-${Date.now()}-${runId}`)
		await fs.mkdir(backupDir, { recursive: true })
		await safeWriteJson(
			path.join(backupDir, "snapshot.json"),
			{
				createdAt: Date.now(),
				curatorState: {
					lastRunAt: this.lastRunAt,
					firstRunDone: this.firstRunDone,
				},
				skillUsage: this.skillUsageStore.getAll(),
			},
			{ prettyPrint: true },
		)
		await this.cleanupOldBackups()
		return backupDir
	}

	private async collectFilesRecursive(
		baseDir: string,
		currentDir: string,
		acc: Array<{ path: string; content: Buffer }>,
	): Promise<void> {
		const entries = await fs.readdir(currentDir, { withFileTypes: true })
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name)
			if (entry.isDirectory()) {
				await this.collectFilesRecursive(baseDir, fullPath, acc)
			} else if (entry.isFile()) {
				const relativePath = path.relative(baseDir, fullPath)
				const content = await fs.readFile(fullPath)
				acc.push({ path: relativePath, content })
			}
		}
	}

	private async clearDirectory(dir: string): Promise<void> {
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true })
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name)
				if (entry.isDirectory()) {
					await fs.rm(fullPath, { recursive: true, force: true })
				} else {
					await fs.unlink(fullPath)
				}
			}
		} catch {
			// Best effort
		}
	}

	/**
	 * Cleanup old backups.
	 * Supports both directory-based (JSON snapshot) and file-based (tar.gz) backups.
	 */
	private async cleanupOldBackups(): Promise<void> {
		try {
			const entries = await fs.readdir(this.backupsDir, { withFileTypes: true })
			const backups: Array<{ path: string; mtimeMs: number }> = []

			for (const entry of entries) {
				if (entry.name.startsWith("backup-") && entry.isDirectory()) {
					const backupPath = path.join(this.backupsDir, entry.name)
					const stats = await fs.stat(backupPath)
					backups.push({ path: backupPath, mtimeMs: stats.mtimeMs })
				} else if (entry.name.endsWith(".tar.gz") && entry.isFile()) {
					const backupPath = path.join(this.backupsDir, entry.name)
					const stats = await fs.stat(backupPath)
					backups.push({ path: backupPath, mtimeMs: stats.mtimeMs })
				}
			}

			backups.sort((left, right) => right.mtimeMs - left.mtimeMs)
			for (const staleBackup of backups.slice(this.config.maxBackups)) {
				const stat = await fs.stat(staleBackup.path)
				if (stat.isDirectory()) {
					await fs.rm(staleBackup.path, { recursive: true, force: true })
				} else {
					await fs.unlink(staleBackup.path)
				}
			}
		} catch {
			// Best-effort retention cleanup.
		}
	}

	private assignStats(report: CuratorReport): void {
		const stats = this.skillUsageStore.getStats()
		report.stats.totalSkills = stats.total
		report.stats.activeSkills = stats.active
		report.stats.staleSkills = stats.stale
		report.stats.archivedSkills = stats.archived
		report.stats.pinnedSkills = stats.pinned
	}

	private async applyDeterministicTransitions(): Promise<{
		transitions: CuratorReport["transitions"]
		classifications: NonNullable<CuratorReport["classifications"]>
	}> {
		const transitions: CuratorReport["transitions"] = []
		const classifications: NonNullable<CuratorReport["classifications"]> = []

		for (const candidate of this.skillUsageStore.getStaleCandidates(this.config.staleAfterDays)) {
			if (this.isProtected(candidate)) {
				continue
			}

			await this.skillUsageStore.transitionState(candidate.skillId, "stale")
			transitions.push({
				skillId: candidate.skillId,
				skillName: candidate.skillName,
				fromState: "active",
				toState: "stale",
				reason: `No activity for ${this.config.staleAfterDays} days`,
			})
		}

		for (const candidate of this.skillUsageStore.getArchiveCandidates(this.config.archiveAfterDays)) {
			if (this.isProtected(candidate)) {
				continue
			}

			await this.skillUsageStore.transitionState(candidate.skillId, "archived")

			// Classify the archived skill using three-tier classification
			const skillDir = this.config.skillsDir
				? path.join(this.config.skillsDir, candidate.skillId)
				: path.join(this.baseDir, "skills", candidate.skillId)
			const classification = await this.classifyArchivedSkill(candidate.skillId, candidate.skillName, skillDir)
			classifications.push({
				skillId: candidate.skillId,
				skillName: candidate.skillName,
				...classification,
			})

			transitions.push({
				skillId: candidate.skillId,
				skillName: candidate.skillName,
				fromState: "stale",
				toState: "archived",
				reason: `No activity for ${this.config.archiveAfterDays} days`,
			})
		}

		return { transitions, classifications }
	}

	private isProtected(record: SkillTelemetryRecord): boolean {
		return record.pinned || record.createdBy !== "agent"
	}

	/**
	 * Three-tier classification for an archived skill.
	 *
	 * Tier 1 (declared): Check for absorbed_into declaration in the skill usage store
	 *   (set by skill_manage delete or curator merge/demote actions).
	 *
	 * Tier 2 (yaml_block): Parse YAML front matter from the skill's SKILL.md for
	 *   an absorbed_into field.
	 *
	 * Tier 3 (heuristic): Fallback heuristic audit — check if the skill name
	 *   suggests it may be an umbrella candidate.
	 */
	private async classifyArchivedSkill(
		skillId: string,
		skillName: string,
		skillDir: string,
	): Promise<ClassificationResult> {
		// Tier 1: Check for absorbed_into declaration (from skill_manage delete / curator merge)
		const record = this.skillUsageStore.get(skillId)
		if (record?.absorbedInto) {
			return {
				tier: "declared",
				absorbedInto: record.absorbedInto,
				summary: `Explicitly absorbed into "${record.absorbedInto}"`,
				confidence: "high",
			}
		}

		// Tier 2: Check for structured YAML summary block in SKILL.md
		const skillMdPath = path.join(skillDir, "SKILL.md")
		try {
			const content = await fs.readFile(skillMdPath, "utf-8")
			const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/)
			if (yamlMatch) {
				const yamlBlock = yamlMatch[1]
				const absorbedMatch = yamlBlock.match(/absorbed_into:\s*["']?(.+?)["']?\s*$/)
				if (absorbedMatch) {
					return {
						tier: "yaml_block",
						absorbedInto: absorbedMatch[1].trim(),
						summary: `YAML front matter declares absorption into "${absorbedMatch[1].trim()}"`,
						confidence: "medium",
					}
				}
			}
		} catch {
			// SKILL.md doesn't exist or can't be read — fall through to heuristic
		}

		// Tier 3: Heuristic audit — check for umbrella skill references in name
		const umbrellaMatch = skillName.match(/^(umb|parent|umbrella)[-_]/i)
		if (umbrellaMatch) {
			return {
				tier: "heuristic",
				absorbedInto: null,
				summary: `Skill name suggests it may be an umbrella candidate: "${skillName}"`,
				confidence: "low",
			}
		}

		return {
			tier: "unclassified",
			absorbedInto: null,
			summary: "No classification data available",
			confidence: "low",
		}
	}

	/**
	 * Run LLM-based curator review.
	 * Builds the candidate table, submits it to the LLM provider,
	 * executes returned YAML actions, and records results in the report.
	 */
	private async runCuratorReview(report: CuratorReport): Promise<void> {
		try {
			const candidates = this.skillUsageStore.getAgentCreatedForReview()
			if (candidates.length === 0) {
				return
			}

			const pinned = this.skillUsageStore.getAgentCreatedPinned()
			const candidateTable = this.renderCandidateList(candidates, pinned)
			this.logger.appendLine(
				`[CuratorService] LLM review: ${candidates.length} agent-created candidates, ${pinned.length} pinned`,
			)

			// Build the full prompt
			const prompt =
				CURATOR_REVIEW_PROMPT + "\n" + candidateTable + "\n\nReturn ONLY valid YAML with an 'actions' key."

			// Submit to the LLM provider (default NoopLLMReviewProvider logs but returns [])
			const actions = await this.llmProvider.review(prompt)
			if (actions.length === 0) {
				this.logger.appendLine("[CuratorService] No LLM actions returned")
				return
			}

			report.llmActions = actions
			const absorbedSkills: CuratorReport["absorbedSkills"] = []
			const llmClassifications: NonNullable<CuratorReport["classifications"]> = []

			for (const action of actions) {
				switch (action.action) {
					case "merge": {
						// Absorb skills into umbrella target
						for (const skillName of action.absorb) {
							const record = this.findRecordBySkillName(skillName)
							if (!record || record.pinned) {
								this.logger.appendLine(
									`[CuratorService] Merge: cannot absorb "${skillName}" — not found or pinned`,
								)
								continue
							}

							const prevState = record.state
							// Archive the skill in the store (persists state + archivedAt)
							await this.skillUsageStore.archive(record.skillId)
							// Set absorbedInto on the record (persists via setAbsorbedInto)
							await this.skillUsageStore.setAbsorbedInto(record.skillId, action.target)

							absorbedSkills.push({
								skillName: record.skillName,
								absorbedInto: action.target,
							})

							// Classify the merged skill
							const skillDir = this.config.skillsDir
								? path.join(this.config.skillsDir, record.skillId)
								: path.join(this.baseDir, "skills", record.skillId)
							const classification = await this.classifyArchivedSkill(
								record.skillId,
								record.skillName,
								skillDir,
							)
							llmClassifications.push({
								skillId: record.skillId,
								skillName: record.skillName,
								...classification,
							})

							report.transitions.push({
								skillId: record.skillId,
								skillName: record.skillName,
								fromState: prevState,
								toState: "archived",
								reason: `Absorbed into umbrella skill "${action.target}"`,
							})
						}

						// Rewrite cron references for each absorbed skill
						const cronRefs: NonNullable<CuratorReport["cronReferencesUpdated"]> = []
						for (const skillName of action.absorb) {
							const absorbedRecord = this.findRecordBySkillName(skillName)
							if (absorbedRecord) {
								const refs = await this.rewriteSkillRefs(
									absorbedRecord.skillId,
									action.target,
									action.target,
								)
								cronRefs.push(...refs)
							}
						}
						if (cronRefs.length > 0) {
							report.cronReferencesUpdated = [...(report.cronReferencesUpdated ?? []), ...cronRefs]
						}
						break
					}

					case "archive": {
						const record = this.findRecordBySkillName(action.name)
						if (!record || record.pinned) {
							this.logger.appendLine(
								`[CuratorService] Archive: cannot archive "${action.name}" — not found or pinned`,
							)
							continue
						}
						await this.skillUsageStore.transitionState(record.skillId, "archived")

						// Classify the LLM-archived skill
						const skillDir = this.config.skillsDir
							? path.join(this.config.skillsDir, record.skillId)
							: path.join(this.baseDir, "skills", record.skillId)
						const classification = await this.classifyArchivedSkill(
							record.skillId,
							record.skillName,
							skillDir,
						)
						llmClassifications.push({
							skillId: record.skillId,
							skillName: record.skillName,
							...classification,
						})

						report.transitions.push({
							skillId: record.skillId,
							skillName: record.skillName,
							fromState: record.state,
							toState: "archived",
							reason: "LLM review: low-value / superseded skill",
						})
						break
					}

					case "pin": {
						const record = this.findRecordBySkillName(action.name)
						if (!record) {
							this.logger.appendLine(`[CuratorService] Pin: skill "${action.name}" not found`)
							continue
						}
						await this.skillUsageStore.pin(record.skillId)
						break
					}

					case "unpin": {
						const record = this.findRecordBySkillName(action.name)
						if (!record) {
							this.logger.appendLine(`[CuratorService] Unpin: skill "${action.name}" not found`)
							continue
						}
						await this.skillUsageStore.unpin(record.skillId)
						break
					}

					case "restore": {
						const record = this.findRecordBySkillName(action.name)
						if (!record) {
							this.logger.appendLine(`[CuratorService] Restore: skill "${action.name}" not found`)
							continue
						}
						await this.skillUsageStore.restore(record.skillId)
						report.transitions.push({
							skillId: record.skillId,
							skillName: record.skillName,
							fromState: "archived",
							toState: "active",
							reason: "LLM review: restored from archival",
						})
						break
					}

					case "demote": {
						const record = this.findRecordBySkillName(action.name)
						if (!record || record.pinned) {
							this.logger.appendLine(
								`[CuratorService] Demote: cannot demote "${action.name}" — not found or pinned`,
							)
							continue
						}
						const prevState = record.state
						await this.executeDemotion(action)
						// Archive the skill in the store and mark as absorbed
						await this.skillUsageStore.archive(record.skillId)
						await this.skillUsageStore.setAbsorbedInto(record.skillId, action.umbrellaSkillName)

						absorbedSkills.push({
							skillName: record.skillName,
							absorbedInto: action.umbrellaSkillName,
						})

						// Classify the demoted skill
						const skillDir = this.config.skillsDir
							? path.join(this.config.skillsDir, record.skillId)
							: path.join(this.baseDir, "skills", record.skillId)
						const classification = await this.classifyArchivedSkill(
							record.skillId,
							record.skillName,
							skillDir,
						)
						llmClassifications.push({
							skillId: record.skillId,
							skillName: record.skillName,
							...classification,
						})

						report.transitions.push({
							skillId: record.skillId,
							skillName: record.skillName,
							fromState: prevState,
							toState: "archived",
							reason: `Demoted to ${action.demoteTarget} under umbrella "${action.umbrellaSkillName}"`,
						})

						// Rewrite cron references for the demoted skill
						const demoteRefs = await this.rewriteSkillRefs(
							record.skillId,
							action.umbrellaSkillId,
							action.umbrellaSkillName,
						)
						if (demoteRefs.length > 0) {
							report.cronReferencesUpdated = [...(report.cronReferencesUpdated ?? []), ...demoteRefs]
						}
						break
					}
				}
			}

			if (absorbedSkills.length > 0) {
				report.absorbedSkills = absorbedSkills
			}

			// Merge LLM review classifications into report
			if (llmClassifications.length > 0) {
				if (report.classifications) {
					report.classifications.push(...llmClassifications)
				} else {
					report.classifications = llmClassifications
				}
			}

			this.logger.appendLine(
				`[CuratorService] LLM review applied: ${actions.length} actions (${absorbedSkills.length} absorbed, ${llmClassifications.length} classified)`,
			)
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Review error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Find a telemetry record by skill name (case-sensitive).
	 */
	private findRecordBySkillName(skillName: string): SkillTelemetryRecord | undefined {
		const all = this.skillUsageStore.getAll()
		return all.find((r) => r.skillName === skillName)
	}

	/**
	 * Find cron job files that reference a given skill ID.
	 * Scans for a "cron" directory adjacent to the skills directory
	 * and checks JSON/YAML/YML files for the skill ID or name.
	 */
	private async findCronReferences(skillId: string): Promise<CronJobReference[]> {
		const references: CronJobReference[] = []

		// Check for cron directory in the workspace (adjacent to skillsDir)
		const cronDir = path.join(this.config.skillsDir ?? this.baseDir, "..", "cron")
		try {
			await fs.access(cronDir)
		} catch {
			return references // No cron directory exists
		}

		// Scan cron job files for skill references
		const entries = await fs.readdir(cronDir, { withFileTypes: true })
		for (const entry of entries) {
			if (
				!entry.isFile() ||
				(!entry.name.endsWith(".json") && !entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))
			) {
				continue
			}

			const filePath = path.join(cronDir, entry.name)
			try {
				const content = await fs.readFile(filePath, "utf-8")
				if (content.includes(skillId) || content.includes(skillId.replace(/[_-]/g, " "))) {
					references.push({
						jobId: entry.name.replace(/\.(json|yaml|yml)$/, ""),
						jobName: entry.name,
						skillId,
						skillName: skillId,
						filePath,
					})
				}
			} catch {
				continue
			}
		}

		return references
	}

	/**
	 * Rewrite skill references in cron job files after consolidation.
	 * Surgically updates all cron files that reference the old skill ID/name
	 * to point to the new skill ID/name.
	 */
	private async rewriteSkillRefs(
		oldSkillId: string,
		newSkillId: string,
		newSkillName: string,
	): Promise<Array<{ jobName: string; oldSkillId: string; newSkillId: string }>> {
		const references = await this.findCronReferences(oldSkillId)
		if (references.length === 0) return []

		this.logger.appendLine(
			`[CuratorService] Rewriting ${references.length} cron reference(s) for skill "${oldSkillId}" → "${newSkillId}"`,
		)

		const updatedRefs: Array<{ jobName: string; oldSkillId: string; newSkillId: string }> = []

		for (const ref of references) {
			try {
				let content = await fs.readFile(ref.filePath, "utf-8")

				// Replace skill references — escape regex special chars in IDs
				const escapedOldId = oldSkillId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				content = content.replace(new RegExp(escapedOldId, "g"), newSkillId)

				// Also replace name variants with flexible separators
				const namePattern = oldSkillId.replace(/[_-]/g, "[ _-]?")
				content = content.replace(new RegExp(namePattern, "g"), newSkillName)

				await fs.writeFile(ref.filePath, content, "utf-8")
				this.logger.appendLine(`  ✓ Updated cron reference in "${ref.jobName}"`)

				updatedRefs.push({
					jobName: ref.jobName,
					oldSkillId,
					newSkillId,
				})
			} catch (err) {
				this.logger.appendLine(
					`  ✗ Failed to update cron reference in "${ref.jobName}": ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		return updatedRefs
	}

	/**
	 * Execute a demotion action: move skill content into a subdirectory
	 * (references/, templates/, or scripts/) under the umbrella skill directory,
	 * remove the original skill directory, and mark the skill as absorbed.
	 */
	private async executeDemotion(action: CuratorAction): Promise<void> {
		if (action.action !== "demote") return

		const { name, demoteTarget, umbrellaSkillId, umbrellaSkillName } = action
		if (!demoteTarget || !umbrellaSkillId) return

		const skillsDir = this.config.skillsDir
		if (!skillsDir) {
			this.logger.appendLine("[CuratorService] executeDemotion: no skillsDir configured")
			return
		}

		// Find the skill record to get its skillId for the source directory
		const record = this.findRecordBySkillName(name)
		if (!record) {
			this.logger.appendLine(`[CuratorService] executeDemotion: skill "${name}" not found`)
			return
		}

		const sourcePath = path.join(skillsDir, record.skillId)
		const umbrellaPath = path.join(skillsDir, umbrellaSkillId)
		const targetDir = path.join(umbrellaPath, `${demoteTarget}s`)

		try {
			// Create target subdirectory under umbrella
			await fs.mkdir(targetDir, { recursive: true })

			// Move skill content to target subdirectory, prefixing files with skill name
			const files = await fs.readdir(sourcePath)
			for (const file of files) {
				const filePath = path.join(sourcePath, file)
				const stat = await fs.stat(filePath)
				if (stat.isFile()) {
					await fs.rename(filePath, path.join(targetDir, `${name}-${file}`))
				}
			}

			// Remove original skill directory
			await fs.rm(sourcePath, { recursive: true, force: true })

			this.logger.appendLine(
				`Demoted skill "${name}" to ${demoteTarget} under "${umbrellaSkillName || umbrellaSkillId}"`,
			)
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Demotion error for "${name}": ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Render a candidate list for LLM review, showing agent-created skills
	 * and separately listing pinned skills that are excluded from mutations.
	 * Format mirrors Hermes' _render_candidate_list().
	 * Also shows absorbed_into status if set.
	 */
	private renderCandidateList(candidates: SkillTelemetryRecord[], pinned: SkillTelemetryRecord[]): string {
		const lines: string[] = []
		const now = Date.now()

		lines.push("## Agent-Created Skills (candidates for review)")
		lines.push("")
		lines.push("| name | state | pinned | absorbed_into | frequency | use | view | patch | last_activity |")
		lines.push("|------|-------|--------|---------------|-----------|-----|------|-------|---------------|")

		for (const skill of candidates) {
			const lastActivity =
				skill.lastActivityAt > 0
					? `${Math.round((now - skill.lastActivityAt) / (24 * 60 * 60 * 1000))}d ago`
					: "never"
			const absorbedInto = (skill as any).absorbedInto ?? ""
			lines.push(
				`| ${skill.skillName} | ${skill.state} | ${skill.pinned ? "yes" : "no"} | ${absorbedInto} | ` +
					`${skill.useCount} | ${skill.useCount} | ${skill.viewCount} | ${skill.patchCount} | ${lastActivity} |`,
			)
		}

		lines.push("")
		lines.push(`## Pinned Agent-Created Skills (excluded from mutations)`)
		lines.push("")

		if (pinned.length > 0) {
			for (const skill of pinned) {
				lines.push(`- ${skill.skillName} (${skill.state})`)
			}
		} else {
			lines.push("(none)")
		}

		return lines.join("\n")
	}

	private async writeReport(report: CuratorReport): Promise<void> {
		try {
			const runDir = path.join(this.reportsDir, report.runId)
			await fs.mkdir(runDir, { recursive: true })
			await safeWriteJson(path.join(runDir, "run.json"), report, { prettyPrint: true })
			await fs.writeFile(path.join(runDir, "REPORT.md"), this.buildReportMarkdown(report), "utf-8")
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Report write error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Build a structured markdown report including consolidation decisions,
	 * merge/absorption info, and pre/post skill counts.
	 */
	private buildReportMarkdown(report: CuratorReport): string {
		const lines = [
			`# Curator Run Report: ${report.runId}`,
			"",
			`**Timestamp**: ${new Date(report.timestamp).toISOString()}`,
			`**Duration**: ${report.durationMs}ms`,
			"",
			"## Summary",
			"",
			"| Metric | Value |",
			"|--------|-------|",
			`| Total Skills | ${report.stats.totalSkills} |`,
			`| Active | ${report.stats.activeSkills} |`,
			`| Stale | ${report.stats.staleSkills} |`,
			`| Archived | ${report.stats.archivedSkills} |`,
			`| Pinned | ${report.stats.pinnedSkills} |`,
			`| Transitions Applied | ${report.stats.transitionsApplied} |`,
		]

		if (typeof report.preConsolidationCount === "number") {
			lines.push(`| Pre-Consolidation Count | ${report.preConsolidationCount} |`)
			const delta = report.preConsolidationCount - report.stats.totalSkills
			const sign = delta >= 0 ? "-" : "+"
			lines.push(`| Net Change | ${sign}${Math.abs(delta)} |`)
		}

		lines.push("")

		if (report.transitions.length > 0) {
			lines.push("## Transitions", "", "| Skill | From | To | Reason |", "|-------|------|----|--------|")
			for (const transition of report.transitions) {
				lines.push(
					`| ${transition.skillName} | ${transition.fromState} | ${transition.toState} | ${transition.reason} |`,
				)
			}
			lines.push("")
		}

		// ── Consolidation Decisions ──
		if (report.llmActions && report.llmActions.length > 0) {
			lines.push("## Consolidation Decisions (LLM)")
			lines.push("")

			for (const action of report.llmActions) {
				switch (action.action) {
					case "merge":
						lines.push(
							`- **Merge**: \`${action.target}\` absorbs ${action.absorb.map((a) => `\`${a}\``).join(", ")}`,
						)
						break
					case "archive":
						lines.push(`- **Archive**: \`${action.name}\``)
						break
					case "pin":
						lines.push(`- **Pin**: \`${action.name}\``)
						break
					case "unpin":
						lines.push(`- **Unpin**: \`${action.name}\``)
						break
					case "restore":
						lines.push(`- **Restore**: \`${action.name}\``)
						break
					case "demote":
						lines.push(
							`- **Demote**: \`${action.name}\` → ${action.demoteTarget} under \`${action.umbrellaSkillName}\``,
						)
						break
				}
			}
			lines.push("")
		}

		// ── Absorbed Skills ──
		if (report.absorbedSkills && report.absorbedSkills.length > 0) {
			lines.push("## Absorbed Skills")
			lines.push("")
			lines.push("| Skill | Absorbed Into |")
			lines.push("|-------|---------------|")
			for (const absorbed of report.absorbedSkills) {
				lines.push(`| ${absorbed.skillName} | ${absorbed.absorbedInto} |`)
			}
			lines.push("")

			// Why they were merged (generic rationale since LLM doesn't provide per-skill reasoning here)
			lines.push(
				"These skills were identified by the LLM curator as overlapping, duplicate, or subsets " +
					"of an umbrella skill. They have been archived and marked as absorbed into their respective " +
					"umbrella target.",
			)
			lines.push("")
		}

		// ── Archived Skill Classifications ──
		if (report.classifications && report.classifications.length > 0) {
			lines.push("## Archived Skill Classifications")
			lines.push("")
			lines.push("| Skill | Tier | Absorbed Into | Confidence | Summary |")
			lines.push("|-------|------|---------------|------------|---------|")
			for (const classification of report.classifications) {
				const absorbedDisplay = classification.absorbedInto ?? "—"
				lines.push(
					`| ${classification.skillName} | ${classification.tier} | ${absorbedDisplay} | ${classification.confidence} | ${classification.summary} |`,
				)
			}
			lines.push("")
		}

		// ── Cron References Updated ──
		if (report.cronReferencesUpdated && report.cronReferencesUpdated.length > 0) {
			lines.push("## Cron References Updated")
			lines.push("")
			lines.push("| Job File | Old Skill | New Skill |")
			lines.push("|----------|-----------|-----------|")
			for (const ref of report.cronReferencesUpdated) {
				lines.push(`| ${ref.jobName} | ${ref.oldSkillId} | ${ref.newSkillId} |`)
			}
			lines.push("")
		}

		if (report.backupPath) {
			lines.push(`**Backup**: ${report.backupPath}`, "")
		}

		if (report.error) {
			lines.push("## Error", "", report.error, "")
		}

		return lines.join("\n")
	}
}
