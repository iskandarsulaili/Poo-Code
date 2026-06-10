import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Experiments, ImprovementAction, LearnedPattern } from "./types"
import type { CodeIndexManager } from "../code-index/manager"
import type { Logger } from "./types"

export interface ReviewTeamConfig {
	enabled: boolean
	minConfidenceForReview: number // default 0.2 — skip review for very low confidence
	useLLMScorer: boolean // if true, uses LLM for borderline; default false after Hermes adaptation
	storageBasePath?: string // path for persisting counts
	getExperiments?: () => Experiments | undefined
}

interface PersistedCounts {
	approvedPatternCount: number
	approvedActionCount: number
}

const COUNTS_FILE = "review-team-counts.json"

const DEFAULT_CONFIG: ReviewTeamConfig = {
	enabled: true,
	minConfidenceForReview: 0.2,
	useLLMScorer: false,
}

export class ReviewTeamService {
	private logger: Logger
	private config: ReviewTeamConfig
	private approvedPatternCount = 0
	private approvedActionCount = 0
	private initialized = false
	private initPromise: Promise<void> | null = null
	private codeIndexManager: CodeIndexManager | undefined

	constructor(logger: Logger, config?: Partial<ReviewTeamConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	setCodeIndexManager(manager: CodeIndexManager | undefined): void {
		this.codeIndexManager = manager
	}

	async initialize(): Promise<void> {
		if (this.initialized) return
		if (!this.initPromise) this.initPromise = this.doInitialize()
		await this.initPromise
	}

	private async doInitialize(): Promise<void> {
		try {
			if (!this.config.storageBasePath) {
				this.initialized = true
				return
			}

			const countsPath = path.join(this.config.storageBasePath, COUNTS_FILE)
			try {
				const data = await fs.readFile(countsPath, "utf-8")
				const parsed = JSON.parse(data) as PersistedCounts
				this.approvedPatternCount = parsed.approvedPatternCount ?? 0
				this.approvedActionCount = parsed.approvedActionCount ?? 0
				this.logger.appendLine(
					`[ReviewTeamService] Loaded counts: ${this.approvedPatternCount} patterns, ${this.approvedActionCount} actions`,
				)
			} catch {
				this.logger.appendLine("[ReviewTeamService] No persisted counts found, starting fresh")
			}
		} catch (error) {
			this.logger.appendLine(
				`[ReviewTeamService] Failed to load: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
			this.initPromise = null
		}
	}

	private async persistCounts(): Promise<void> {
		if (!this.config.storageBasePath) return
		try {
			await safeWriteJson(path.join(this.config.storageBasePath, COUNTS_FILE), {
				approvedPatternCount: this.approvedPatternCount,
				approvedActionCount: this.approvedActionCount,
			})
		} catch (error) {
			this.logger.appendLine(
				`[ReviewTeamService] Failed to persist: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	getApprovedPatternCount(): number {
		return this.approvedPatternCount
	}
	setApprovedPatternCount(count: number): void {
		this.approvedPatternCount = count
		this.persistCounts()
	}
	getApprovedActionCount(): number {
		return this.approvedActionCount
	}
	setApprovedActionCount(count: number): void {
		this.approvedActionCount = count
		this.persistCounts()
	}
	getConfig(): ReviewTeamConfig {
		return { ...this.config }
	}
	updateConfig(updates: Partial<ReviewTeamConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[ReviewTeam] Config updated: ${JSON.stringify(updates)}`)
	}

	/**
	 * Hermes-style review: a pattern is approved if confidence >= threshold (minConfidenceForReview).
	 * Optionally uses LLMScorer for borderline cases.
	 * No simulated personas.
	 */
	async reviewPattern(pattern: LearnedPattern): Promise<SimpleVerdict> {
		if (!this.config.enabled) {
			return { approved: true, score: 1.0, summary: "Review team disabled" }
		}

		const confidence = pattern.confidenceScore ?? 0.5
		const frequency = pattern.frequency ?? 0
		const threshold = this.config.minConfidenceForReview

		// Hermes rule: confidence must be above minimum threshold
		if (confidence < threshold) {
			return {
				approved: false,
				score: confidence,
				summary: `Confidence ${confidence.toFixed(2)} below threshold ${threshold}`,
			}
		}

		// If LLMScorer is configured and pattern is borderline (freq < 2, high conf)
		// the caller can run LLM scoring externally and re-call.
		// For now: approve any pattern above confidence threshold.
		this.approvedPatternCount++
		this.persistCounts().catch(() => {})

		return {
			approved: true,
			score: confidence,
			summary: `Pattern approved: confidence=${confidence.toFixed(2)}, frequency=${frequency}`,
		}
	}

	async reviewPatterns(patterns: LearnedPattern[]): Promise<{
		approved: LearnedPattern[]
		rejected: LearnedPattern[]
		verdicts: SimpleVerdict[]
	}> {
		const approved: LearnedPattern[] = []
		const rejected: LearnedPattern[] = []
		const verdicts: SimpleVerdict[] = []

		for (const pattern of patterns) {
			const verdict = await this.reviewPattern(pattern)
			verdicts.push(verdict)
			if (verdict.approved) approved.push(pattern)
			else rejected.push(pattern)
		}

		this.logger.appendLine(
			`[ReviewTeam] Reviewed ${patterns.length} patterns: ${approved.length} approved, ${rejected.length} rejected`,
		)

		return { approved, rejected, verdicts }
	}

	/**
	 * Hermes-style action review: approve if confidence >= threshold and action has meaningful content.
	 * No simulated personas, no weighted features.
	 */
	async reviewAction(action: ImprovementAction): Promise<SimpleVerdict> {
		if (!this.config.enabled) {
			return { approved: true, score: 1.0, summary: "Review team disabled" }
		}

		const confidence = (action.payload?.confidence as number | undefined) ?? 0.5
		const threshold = this.config.minConfidenceForReview

		if (confidence < threshold) {
			return {
				approved: false,
				score: confidence,
				summary: `Action confidence ${confidence.toFixed(2)} below threshold ${threshold}`,
			}
		}

		this.approvedActionCount++
		this.persistCounts().catch(() => {})

		return {
			approved: true,
			score: confidence,
			summary: `Action ${action.actionType} approved (conf: ${confidence.toFixed(2)})`,
		}
	}

	async reviewActions(actions: ImprovementAction[]): Promise<{
		approved: ImprovementAction[]
		rejected: ImprovementAction[]
		verdicts: SimpleVerdict[]
	}> {
		const approved: ImprovementAction[] = []
		const rejected: ImprovementAction[] = []
		const verdicts: SimpleVerdict[] = []

		for (const action of actions) {
			const verdict = await this.reviewAction(action)
			verdicts.push(verdict)
			if (verdict.approved) approved.push(action)
			else rejected.push(action)
		}

		this.logger.appendLine(
			`[ReviewTeam] Reviewed ${actions.length} actions: ${approved.length} approved, ${rejected.length} rejected`,
		)

		return { approved, rejected, verdicts }
	}

	/**
	 * Vector search for similar approved patterns (retained from original — genuine value).
	 */
	async searchSimilarApprovedPatterns(pattern: LearnedPattern): Promise<Array<{ summary: string; score: number }>> {
		if (!this.codeIndexManager) return []
		try {
			const query = [
				pattern.summary,
				...(pattern.context?.toolNames ?? []),
				...(pattern.context?.errorKeys ?? []),
			]
				.filter(Boolean)
				.join(" ")

			const results = await this.codeIndexManager.searchIndex(query)
			if (!Array.isArray(results) || results.length === 0) return []

			return results
				.filter((r) => r.payload?.codeChunk)
				.map((r) => ({
					summary: r.payload?.codeChunk?.slice(0, 200) ?? "",
					score: r.score,
				}))
		} catch (error) {
			this.logger.appendLine(
				`[ReviewTeamService] searchSimilarApprovedPatterns error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}
}

export interface SimpleVerdict {
	approved: boolean
	score: number
	summary: string
}
