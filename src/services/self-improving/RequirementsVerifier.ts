import crypto from "crypto"
import type { Logger, Requirement, RequirementsVerificationResult } from "./types"

export interface RequirementsVerifierConfig {
	/** Whether requirements verification is mandatory (blocks completion) */
	mandatory: boolean
	/** Whether to auto-extract requirements from prompt */
	autoExtract: boolean
	/** Whether to require all requirements to be verified before completion */
	requireAllVerified: boolean
}

const DEFAULT_CONFIG: RequirementsVerifierConfig = {
	mandatory: true,
	autoExtract: true,
	requireAllVerified: true,
}

export class RequirementsVerifier {
	private config: RequirementsVerifierConfig
	private requirements: Map<string, Requirement> = new Map()

	constructor(
		private readonly logger?: Logger,
		config?: Partial<RequirementsVerifierConfig>,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	updateConfig(config: Partial<RequirementsVerifierConfig>): void {
		this.config = { ...this.config, ...config }
		this.logger?.appendLine(`[RequirementsVerifier] Config updated: ${JSON.stringify(config)}`)
	}

	getConfig(): RequirementsVerifierConfig {
		return { ...this.config }
	}

	/**
	 * Extract requirements from a user prompt using heuristic parsing.
	 * Looks for bullet points, numbered lists, "must", "should", "need", "require" patterns.
	 */
	extractFromPrompt(prompt: string): Requirement[] {
		const extracted: Requirement[] = []
		const lines = prompt.split("\n")

		let currentCategory: Requirement["category"] = "functional"

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue

			// Detect category headers
			const categoryMatch = trimmed.match(
				/^(?:#+\s*)?(functional|non-functional|constraint|goal|edge.case|security|compliance|performance|reliability)/i,
			)
			if (categoryMatch) {
				const cat = categoryMatch[1].toLowerCase().replace(/[\s-]/g, "-")
				if (cat === "edge-case" || cat === "edge.case") currentCategory = "edge-case"
				else if (cat === "non-functional") currentCategory = "non-functional"
				else currentCategory = cat as Requirement["category"]
				continue
			}

			// Extract bullet points and numbered items
			const itemMatch = trimmed.match(/^[-*•]\s+(.+)/)
			const numMatch = trimmed.match(/^\d+[.)]\s+(.+)/)
			const reqText = itemMatch?.[1] || numMatch?.[1]

			if (reqText) {
				extracted.push(this.createRequirement(reqText, currentCategory))
				continue
			}

			// Extract sentences with requirement keywords
			const keywordMatch = trimmed.match(
				/(?:must|should|need|require|shall|will|ensure|verify|check|validate|support|implement|add|create|build|fix|refactor)\s.+[.!]/i,
			)
			if (keywordMatch && trimmed.length > 10 && trimmed.length < 500) {
				extracted.push(this.createRequirement(trimmed, currentCategory))
			}
		}

		// If no structured requirements found, treat the whole prompt as one requirement
		if (extracted.length === 0 && prompt.trim().length > 0) {
			extracted.push(this.createRequirement(prompt.trim(), "goal"))
		}

		// Store extracted requirements
		for (const req of extracted) {
			this.requirements.set(req.id, req)
		}

		this.logger?.appendLine(`[RequirementsVerifier] Extracted ${extracted.length} requirements from prompt`)
		return extracted
	}

	/**
	 * Manually add a requirement
	 */
	addRequirement(text: string, category: Requirement["category"] = "functional"): Requirement {
		const req = this.createRequirement(text, category)
		this.requirements.set(req.id, req)
		return req
	}

	/**
	 * Mark a requirement as verified with evidence
	 */
	verifyRequirement(id: string, verifiedBy: Requirement["verifiedBy"], evidence: string): boolean {
		const req = this.requirements.get(id)
		if (!req) return false

		req.status = "verified"
		req.verifiedBy = verifiedBy
		req.evidence = evidence
		req.verifiedAt = Date.now()
		return true
	}

	/**
	 * Mark a requirement as failed
	 */
	failRequirement(id: string, evidence: string): boolean {
		const req = this.requirements.get(id)
		if (!req) return false

		req.status = "failed"
		req.evidence = evidence
		req.verifiedAt = Date.now()
		return true
	}

	/**
	 * Get all requirements
	 */
	getAllRequirements(): Requirement[] {
		return Array.from(this.requirements.values())
	}

	/**
	 * Get requirements by status
	 */
	getRequirementsByStatus(status: Requirement["status"]): Requirement[] {
		return this.getAllRequirements().filter((r) => r.status === status)
	}

	/**
	 * Run full verification — check all requirements
	 * Returns a comprehensive result
	 */
	async verify(): Promise<RequirementsVerificationResult> {
		const all = this.getAllRequirements()
		const verified = all.filter((r) => r.status === "verified")
		const failed = all.filter((r) => r.status === "failed")
		const pending = all.filter((r) => r.status === "pending" || r.status === "skipped")

		const passed = failed.length === 0 && (pending.length === 0 || !this.config.requireAllVerified)

		let summary: string
		if (all.length === 0) {
			summary = "No requirements extracted"
		} else if (passed) {
			summary = `All ${all.length} requirements verified (${verified.length} passed, ${failed.length} failed, ${pending.length} pending)`
		} else {
			summary = `${failed.length}/${all.length} requirements failed: ${failed.map((r) => r.text.slice(0, 80)).join("; ")}`
		}

		return { passed, total: all.length, verified, failed, pending, summary }
	}

	/**
	 * Reset all requirements
	 */
	reset(): void {
		this.requirements.clear()
	}

	private createRequirement(text: string, category: Requirement["category"]): Requirement {
		return {
			id: crypto.randomUUID(),
			text,
			category,
			status: "pending",
		}
	}
}
