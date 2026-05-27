import type { LearnedPattern } from "./types"
import type { Logger } from "./types"
import type { ModeFactoryService } from "./ModeFactoryService"
import type { PatternAnalyzer } from "./PatternAnalyzer"

export interface AutoModeConfig {
	enabled: boolean
	autoCreateModes: boolean
	autoHeal: boolean
	minPatternConfidence: number
	minPatternFrequency: number
	reviewIntervalMs: number
}

const DEFAULT_CONFIG: AutoModeConfig = {
	enabled: true,
	autoCreateModes: true,
	autoHeal: true,
	minPatternConfidence: 0.3,
	minPatternFrequency: 2,
	reviewIntervalMs: 30000,
}

export class AutoModeOrchestrator {
	private logger: Logger
	private modeFactory: ModeFactoryService | null = null
	private patternAnalyzer: PatternAnalyzer | null = null
	private config: AutoModeConfig
	private autoReviewTimer: ReturnType<typeof setInterval> | null = null
	private lastModeCreationTime: number = 0
	private createdModeSlugs: Set<string> = new Set()

	/** Callback to retrieve current patterns from the learning store */
	private getPatterns: (() => LearnedPattern[]) | null = null

	constructor(logger: Logger, config?: Partial<AutoModeConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	setModeFactory(factory: ModeFactoryService): void {
		this.modeFactory = factory
	}

	setPatternAnalyzer(analyzer: PatternAnalyzer): void {
		this.patternAnalyzer = analyzer
	}

	/**
	 * Register a callback to retrieve patterns from the learning store.
	 * This avoids coupling to SelfImprovingManager directly.
	 */
	setPatternProvider(provider: () => LearnedPattern[]): void {
		this.getPatterns = provider
	}

	getConfig(): AutoModeConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<AutoModeConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[AutoMode] Config updated: ${JSON.stringify(updates)}`)
	}

	async start(): Promise<void> {
		if (!this.config.enabled) {
			this.logger.appendLine("[AutoMode] Auto mode is disabled, not starting")
			return
		}

		this.logger.appendLine("[AutoMode] Starting auto mode orchestrator")

		if (this.autoReviewTimer) {
			clearInterval(this.autoReviewTimer)
		}
		this.autoReviewTimer = setInterval(() => {
			this.onAutoReviewTick().catch((error) => {
				this.logger.appendLine(
					`[AutoMode] Auto review tick error: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
		}, this.config.reviewIntervalMs)

		this.logger.appendLine(`[AutoMode] Auto review timer started (interval: ${this.config.reviewIntervalMs}ms)`)
	}

	stop(): void {
		if (this.autoReviewTimer) {
			clearInterval(this.autoReviewTimer)
			this.autoReviewTimer = null
		}
		this.logger.appendLine("[AutoMode] Auto mode orchestrator stopped")
	}

	/**
	 * Called after each task completion to trigger auto mode processing.
	 */
	async onTaskCompleted(success: boolean): Promise<void> {
		if (!this.config.enabled) return

		if (!success && this.config.autoHeal) {
			await this.autoHeal()
		}

		if (this.config.autoCreateModes) {
			const now = Date.now()
			if (now - this.lastModeCreationTime > 5 * 60 * 1000) {
				await this.autoCreateModes()
				this.lastModeCreationTime = now
			}
		}
	}

	/**
	 * Auto-heal: detect failure patterns and log the trigger.
	 * The pattern analyzer picks up failure events during the next review cycle.
	 */
	private async autoHeal(): Promise<void> {
		if (!this.patternAnalyzer) {
			this.logger.appendLine("[AutoMode] Cannot auto-heal: PatternAnalyzer not set")
			return
		}

		this.logger.appendLine("[AutoMode] Auto-heal: failure detected, queued for pattern analysis")
	}

	/**
	 * Auto-create custom modes from high-confidence patterns.
	 */
	private async autoCreateModes(): Promise<void> {
		if (!this.modeFactory) {
			this.logger.appendLine("[AutoMode] Cannot create modes: ModeFactory not set")
			return
		}

		if (!this.getPatterns) {
			this.logger.appendLine("[AutoMode] Cannot create modes: pattern provider not set")
			return
		}

		try {
			const allPatterns = this.getPatterns()
			const candidatePatterns = this.getCandidatePatterns(allPatterns)

			if (candidatePatterns.length === 0) {
				this.logger.appendLine("[AutoMode] No candidate patterns for mode creation")
				return
			}

			this.logger.appendLine(`[AutoMode] Found ${candidatePatterns.length} candidate patterns for mode creation`)

			const created = await this.modeFactory.createModesFromPatterns(candidatePatterns)

			for (const slug of created) {
				this.createdModeSlugs.add(slug)
			}

			if (created.length > 0) {
				this.logger.appendLine(`[AutoMode] Created ${created.length} custom modes: ${created.join(", ")}`)
			}
		} catch (error) {
			this.logger.appendLine(
				`[AutoMode] Auto-create modes error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private getCandidatePatterns(patterns: LearnedPattern[]): LearnedPattern[] {
		return patterns.filter((p) => {
			if (!p.context?.toolNames || p.context.toolNames.length === 0) return false
			if ((p.confidenceScore ?? 0) < this.config.minPatternConfidence) return false
			if ((p.frequency ?? 0) < this.config.minPatternFrequency) return false
			const slug = this.deriveSlugFromPattern(p)
			if (slug && this.createdModeSlugs.has(slug)) return false
			return true
		})
	}

	private deriveSlugFromPattern(pattern: LearnedPattern): string | null {
		const toolNames = pattern.context?.toolNames
		if (!toolNames || toolNames.length === 0) return null
		const base = toolNames.slice(0, 2).join("-")
		const sanitized = base.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()
		const truncated = sanitized.slice(0, 64)
		return truncated.replace(/^-+|-+$/g, "") || null
	}

	/**
	 * Called on the auto review timer tick.
	 * Triggers auto-mode-specific processing after reviews.
	 */
	private async onAutoReviewTick(): Promise<void> {
		if (this.config.autoCreateModes) {
			const now = Date.now()
			if (now - this.lastModeCreationTime > 5 * 60 * 1000) {
				await this.autoCreateModes()
				this.lastModeCreationTime = now
			}
		}
	}

	/**
	 * Get the current auto mode status for display.
	 */
	getStatus(): Record<string, unknown> {
		return {
			autoModeEnabled: this.config.enabled,
			autoCreateModes: this.config.autoCreateModes,
			autoHeal: this.config.autoHeal,
			reviewIntervalMs: this.config.reviewIntervalMs,
			createdModes: this.createdModeSlugs.size,
			createdModeSlugs: Array.from(this.createdModeSlugs),
			lastModeCreation: this.lastModeCreationTime
				? new Date(this.lastModeCreationTime).toLocaleTimeString()
				: "never",
		}
	}
}
