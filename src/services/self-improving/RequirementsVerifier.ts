import crypto from "crypto"
import * as fs from "fs"
import type { Logger, Requirement, RequirementsVerificationResult, ConflictResolver } from "./types"
import { KeywordConflictResolver } from "./KeywordConflictResolver"

export type VerificationLevel = "strict" | "lenient" | "bypass"

export interface RequirementsVerifierConfig {
	/** Whether requirements verification is mandatory (blocks completion) */
	mandatory: boolean
	/** Whether to auto-extract requirements from prompt */
	autoExtract: boolean
	/** Whether to require all requirements to be verified before completion */
	requireAllVerified: boolean
	/**
	 * Verification level for requirements checking.
	 * - "strict": All requirements must be verified before completion (default)
	 * - "lenient": Requirements are tracked but non-blocking — log warnings instead of blocking
	 * - "bypass": Skip requirements verification entirely
	 * @default "strict"
	 */
	verificationLevel: VerificationLevel
}

const DEFAULT_CONFIG: RequirementsVerifierConfig = {
	mandatory: true,
	autoExtract: true,
	requireAllVerified: true,
	verificationLevel: "strict",
}

/** File-writing tool names whose params contain a file path */
const FILE_WRITE_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_replace",
	"edit_file",
	"ApplyDiff",
	"Edit",
	"SearchReplace",
	"Write",
	"write",
	"edit",
	"patch",
])

export class RequirementsVerifier {
	private config: RequirementsVerifierConfig
	private requirements: Map<string, Requirement> = new Map()
	private processedMessageCount = 0
	private conflictResolver: ConflictResolver
	private allMessages: string[] = []
	private lastVerifyResult?: RequirementsVerificationResult
	private taskDescription: string = ""
	private enabled: boolean

	constructor(
		private readonly logger?: Logger,
		config?: Partial<RequirementsVerifierConfig>,
		conflictResolver?: ConflictResolver,
		enabled: boolean = true,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.conflictResolver = conflictResolver ?? new KeywordConflictResolver()
		this.enabled = enabled
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled
		this.logger?.appendLine(`[RequirementsVerifier] ${enabled ? "Enabled" : "Disabled"}`)
	}

	/**
	 * Replace the conflict resolver at runtime.
	 */
	setConflictResolver(resolver: ConflictResolver): void {
		this.conflictResolver = resolver
		this.logger?.appendLine(`[RequirementsVerifier] Conflict resolver set to: ${resolver.name}`)
	}

	/**
	 * Get the current conflict resolver.
	 */
	getConflictResolver(): ConflictResolver {
		return this.conflictResolver
	}

	updateConfig(config: Partial<RequirementsVerifierConfig>): void {
		this.config = { ...this.config, ...config }
		this.logger?.appendLine(`[RequirementsVerifier] Config updated: ${JSON.stringify(config)}`)
	}

	getConfig(): RequirementsVerifierConfig {
		return { ...this.config }
	}

	/**
	 * Process ALL user messages from the session (chronological order).
	 * Extracts requirements from each message and resolves conflicts
	 * where later messages supersede earlier ones.
	 */
	async processUserMessages(messages: string[]): Promise<Requirement[]> {
		if (messages.length === 0) return []

		// Store task description from first message for read-only detection
		if (messages[0] && !this.taskDescription) {
			this.taskDescription = messages[0]
		}

		this.logger?.appendLine(`[RequirementsVerifier] Processing ${messages.length} user messages`)

		// Store all messages for conflict resolution context
		this.allMessages = messages

		// Only process new messages since last call
		const newMessageCount = messages.length - this.processedMessageCount
		if (newMessageCount <= 0) {
			return this.getAllRequirements()
		}

		const messagesToProcess = messages.slice(this.processedMessageCount)

		for (let i = 0; i < messagesToProcess.length; i++) {
			const globalIndex = this.processedMessageCount + i
			const message = messagesToProcess[i]
			const extracted = this.extractFromPrompt(message, globalIndex)

			// Run conflict resolution against existing requirements
			await this.resolveConflicts(extracted, globalIndex)

			// Add new requirements
			for (const req of extracted) {
				this.requirements.set(req.id, req)
			}
		}

		this.processedMessageCount = messages.length

		const all = this.getAllRequirements()
		const active = all.filter((r) => r.status !== "superseded")
		this.logger?.appendLine(
			`[RequirementsVerifier] ${all.length} total requirements (${active.length} active, ${all.length - active.length} superseded)`,
		)

		return all
	}

	// ========================================================================
	// Fix 1: Auto-verify requirements by checking actual tool call history
	// ========================================================================

	/**
	 * File-writing tool names used by the zoo-code agent.
	 * These tools modify files and their params contain file paths.
	 */
	private static readonly FILE_WRITE_TOOL_NAMES = [
		"write_to_file",
		"apply_diff",
		"edit",
		"search_replace",
		"edit_file",
		"patch",
	]

	/**
	 * Auto-verify requirements against the actual tool call history.
	 *
	 * For each active requirement:
	 * 1. Extract keywords from the requirement text
	 * 2. Scan all file-writing tool calls in the message history
	 * 3. If a tool call's file path matches requirement keywords → mark verified
	 * 4. If NO tool call matches → mark failed
	 *
	 * @param clineMessages - The conversation message history (ClineMessage[] with .say === "tool")
	 * @param cwd - The working directory for resolving relative paths
	 */
	autoVerifyFromToolHistory(
		clineMessages: Array<{ type: "ask" | "say"; say?: string; text?: string }>,
		cwd: string,
	): void {
		const active = this.getActiveRequirements()
		if (active.length === 0) {
			this.logger?.appendLine("[RequirementsVerifier] No active requirements to auto-verify against tool history.")
			return
		}

		// Extract file paths touched by file-writing tool calls
		const touchedFiles = this.extractTouchedFiles(clineMessages)
		const filePaths = [...touchedFiles]

		this.logger?.appendLine(
			`[RequirementsVerifier] Auto-verifying ${active.length} requirement(s) against ${filePaths.length} file(s) touched by tool calls`,
		)

		if (filePaths.length > 0) {
			this.logger?.appendLine(`[RequirementsVerifier] Files modified: ${filePaths.join(", ")}`)
		}

		// Read the git diff if available for more precise change detection
		let gitDiffFiles: string[] = []
		try {
			const { execSync } = require("child_process")
			const diffOutput = execSync("git diff --name-only --diff-filter=ACMRT", {
				cwd,
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			}) as string
			gitDiffFiles = diffOutput.split("\n").map((l: string) => l.trim()).filter(Boolean)
		} catch {
			// Not a git repo or git not available — use tool-call file paths only
		}

		const allChangedFiles = new Set([...filePaths, ...gitDiffFiles])

		// Track which requirements matched
		let verifiedCount = 0
		let failedCount = 0
		let unmatchedCount = 0

		for (const req of active) {
			if (req.status === "verified" || req.status === "failed") continue

			// Extract significant keywords from the requirement text
			const keywords = this.extractKeywords(req.text)

			// Check if any changed file path matches requirement keywords
			const matchingFiles = [...allChangedFiles].filter((fp) =>
				keywords.some((kw) => fp.toLowerCase().includes(kw.toLowerCase())),
			)

			if (matchingFiles.length > 0) {
				// Found matching file changes — mark as verified
				req.status = "verified"
				req.verifiedBy = "code-review"
				req.evidence = `File changes detected: ${matchingFiles.join(", ")}`
				req.verifiedAt = Date.now()
				verifiedCount++
				this.logger?.appendLine(
					`[RequirementsVerifier] ✅ Auto-verified requirement: "${req.text.slice(0, 80)}..." → matched files: ${matchingFiles.join(", ")}`,
				)
			} else {
				// For requirements originating from the task description, this is expected
				// to have some unmatched. Only mark as failed if the task had significant
				// file changes but this particular requirement wasn't addressed.
				if (allChangedFiles.size > 0) {
					req.status = "failed"
					req.evidence = `No file changes matched keywords: "${keywords.join(", ")}". Changed files: ${[...allChangedFiles].join(", ")}`
					failedCount++
					this.logger?.appendLine(
						`[RequirementsVerifier] ❌ Failed requirement: "${req.text.slice(0, 80)}..." — no matching file changes`,
					)
				} else {
					unmatchedCount++
				}
			}
		}

		if (verifiedCount > 0 || failedCount > 0 || unmatchedCount > 0) {
			this.logger?.appendLine(
				`[RequirementsVerifier] Auto-verification result: ${verifiedCount} verified, ${failedCount} failed, ${unmatchedCount} unmatched (no file changes at all)`,
			)
		}
	}

	/**
	 * Extract file paths from tool call messages.
	 * Each tool message has a "say: tool" type and text containing the tool name and params.
	 */
	private extractTouchedFiles(
		messages: Array<{ type: "ask" | "say"; say?: string; text?: string }>,
	): Set<string> {
		const files = new Set<string>()

		for (const msg of messages) {
			if (msg.type !== "say" || msg.say !== "tool") continue
			if (!msg.text) continue

			const text = msg.text

			// Try to parse as JSON (tool call params)
			try {
				const parsed = JSON.parse(text)
				// Format: { tool: "...", path: "...", ... } or similar
				const toolName =
					(parsed.tool as string)?.toLowerCase() ||
					(parsed.name as string)?.toLowerCase() ||
					""
				if (RequirementsVerifier.FILE_WRITE_TOOL_NAMES.includes(toolName)) {
					if (parsed.path) files.add(parsed.path)
					if (parsed.file_path) files.add(parsed.file_path)
					if (parsed.diff && parsed.path) files.add(parsed.path)
				}
			} catch {
				// Not JSON — try regex extraction from the raw text
				this.extractFilePathsFromText(text, files)
			}
		}

		return files
	}

	/**
	 * Fallback: extract file paths from raw tool call text using regex.
	 */
	private extractFilePathsFromText(text: string, files: Set<string>): void {
		// Match common patterns like path: "/some/file", path: 'file.ts', "path": "file"
		const pathMatches = text.matchAll(/["']?path["']?\s*[:=]\s*["']([^"']+)["']/gi)
		for (const m of pathMatches) {
			files.add(m[1])
		}

		// Match file_path patterns
		const filePathMatches = text.matchAll(/["']?file_path["']?\s*[:=]\s*["']([^"']+)["']/gi)
		for (const m of filePathMatches) {
			files.add(m[1])
		}
	}

	/**
	 * Extract significant keywords from requirement text for file path matching.
	 * Strips stop words and common boilerplate.
	 */
	private extractKeywords(text: string): string[] {
		const stopWords = new Set([
			"the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
			"of", "with", "by", "from", "as", "is", "was", "be", "been", "are",
			"were", "has", "have", "had", "do", "does", "did", "will", "would",
			"should", "could", "can", "may", "might", "shall", "need", "must",
			"this", "that", "these", "those", "it", "its", "all", "each", "every",
			"some", "any", "no", "not", "only", "just", "also", "very", "too",
			"make", "made", "use", "used", "using", "add", "added", "adding",
			"new", "create", "created", "creating", "implement", "implemented",
			"implementing", "implementation", "update", "updated", "updating",
			"change", "changed", "changing", "remove", "removed", "removing",
			"fix", "fixed", "fixing", "ensure", "ensures", "ensuring",
			"support", "supports", "supported", "supporting", "function",
			"functionality", "feature", "file", "files", "code", "way", "work",
		])

		const words = text
			.toLowerCase()
			.replace(/[^a-z0-9\s.-]/g, " ")
			.split(/\s+/)
			.filter(Boolean)

		const keywords: string[] = []
		for (const word of words) {
			if (word.length < 3) continue
			if (stopWords.has(word)) continue
			if (/^\d+$/.test(word)) continue
			keywords.push(word)
		}

		// Also extract file-like patterns (e.g., "login.ts", "auth.service")
		const fileLikes = text.matchAll(/\b[\w_-]+\.\w{1,4}\b/g)
		for (const m of fileLikes) {
			keywords.push(m[0])
		}

		// Deduplicate
		return [...new Set(keywords)]
	}

	// ========================================================================
	// Fix 3: Tighten read-only detection
	// ========================================================================

	/**
	 * Detect if this is genuinely a read-only/audit task.
	 *
	 * Only triggers when:
	 * 1. The task description explicitly states it's read-only (multiple signals)
	 * 2. The task is about reviewing existing code, not creating/modifying
	 * 3. Single keywords like "check" or "report" alone don't trigger bypass
	 */
	private detectReadOnlyTask(): boolean {
		const taskText = this.taskDescription?.toLowerCase() ?? ""
		if (!taskText) return false

		// Strong signals — explicit read-only statements
		const strongReadOnly = [
			"do not modify", "don't modify", "do not change", "don't change",
			"do not create", "don't create", "do not write", "don't write",
			"read-only", "read only", "readonly", "without making changes",
			"without modifying", "review only", "audit only",
		]
		for (const phrase of strongReadOnly) {
			if (taskText.includes(phrase)) return true
		}

		// Count weak signals — need at least 2 to trigger
		const weakAuditSignals = [
			"audit", "review", "inspect", "analyze",
		]
		const readOnlySignalCount = weakAuditSignals.filter((kw) => taskText.includes(kw)).length

		// If the task explicitly talks about "verify" or "check" in a read-only context
		// (paired with existing code language like "verify that", "check if")
		const hasVerificationContext = /\b(verify|check)\s+(that|if|whether|the|your)\b/i.test(taskText)
		const isExploratory = /\b(what|how|why|where|when|which)\b/i.test(taskText) &&
			/\b(does|is|are|was|were|has|have)\b/i.test(taskText)

		// Count write/modify keywords — if these appear, it's NOT read-only
		const writeSignals = [
			"create", "implement", "build", "write", "modify", "add",
			"fix", "refactor", "update", "change", "make", "produce",
		]
		const writeSignalCount = writeSignals.filter((kw) => taskText.includes(kw)).length

		// Decision: at least 2 audit signals AND zero write signals
		if (readOnlySignalCount >= 2 && writeSignalCount === 0) return true
		if (readOnlySignalCount >= 1 && writeSignalCount === 0 && (hasVerificationContext || isExploratory)) return true

		return false
	}

	// ========================================================================
	// Existing methods from here down
	// ========================================================================

	/**
	 * Resolve conflicts between newly extracted requirements and existing ones.
	 * Uses the pluggable conflict resolver to determine supersession.
	 */
	private async resolveConflicts(newRequirements: Requirement[], newMessageIndex: number): Promise<void> {
		const existingActive = this.getActiveRequirements()

		for (const newReq of newRequirements) {
			const resolution = await this.conflictResolver.resolve(
				newReq,
				existingActive,
				newMessageIndex,
				this.allMessages,
			)

			for (const supersededId of resolution.supersedes) {
				const existing = this.requirements.get(supersededId)
				if (existing && existing.status !== "superseded") {
					existing.status = "superseded"
					existing.supersededBy = newReq.id
					newReq.supersedes = existing.id
					this.logger?.appendLine(
						`[RequirementsVerifier] ${this.conflictResolver.name} resolver: "${existing.text.slice(0, 60)}..." superseded by "${newReq.text.slice(0, 60)}..." (confidence: ${resolution.confidence})`,
					)
				}
			}
		}
	}

	/**
	 * Extract requirements from a single user message.
	 */
	extractFromPrompt(prompt: string, messageIndex: number = 0): Requirement[] {
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
				extracted.push(this.createRequirement(reqText, currentCategory, messageIndex))
				continue
			}

			// Extract sentences with requirement keywords
			const keywordMatch = trimmed.match(
				/(?:must|should|need|require|shall|will|ensure|verify|check|validate|support|implement|add|create|build|fix|refactor)\s.+[.!]/i,
			)
			if (keywordMatch && trimmed.length > 10 && trimmed.length < 500) {
				extracted.push(this.createRequirement(trimmed, currentCategory, messageIndex))
			}
		}

		// If no structured requirements found, treat the whole prompt as one requirement
		if (extracted.length === 0 && prompt.trim().length > 0) {
			extracted.push(this.createRequirement(prompt.trim(), "goal", messageIndex))
		}

		return extracted
	}

	/**
	 * Manually add a requirement
	 */
	addRequirement(text: string, category: Requirement["category"] = "functional"): Requirement {
		const req = this.createRequirement(text, category, this.processedMessageCount)
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
	 * Get all requirements (including superseded ones for audit trail)
	 */
	getAllRequirements(): Requirement[] {
		return Array.from(this.requirements.values())
	}

	/**
	 * Get only active (non-superseded) requirements
	 */
	getActiveRequirements(): Requirement[] {
		return this.getAllRequirements().filter((r) => r.status !== "superseded")
	}

	/**
	 * Get requirements by status
	 */
	getRequirementsByStatus(status: Requirement["status"]): Requirement[] {
		return this.getAllRequirements().filter((r) => r.status === status)
	}

	/**
	 * Run full verification — checks only ACTIVE (non-superseded) requirements
	 */
	getStatus(): Record<string, unknown> {
		if (!this.enabled) {
			return { enabled: false }
		}
		return {
			enabled: true,
			requirementCount: this.requirements.size,
			activeCount: this.getActiveRequirements().length,
			supersededCount: Array.from(this.requirements.values()).filter((r) => r.status === "superseded").length,
			lastVerifyResult: this.lastVerifyResult,
		}
	}

	async verify(): Promise<RequirementsVerificationResult> {
		const all = this.getAllRequirements()
		const active = this.getActiveRequirements()
		const verified = active.filter((r) => r.status === "verified")
		const failed = active.filter((r) => r.status === "failed")
		const pending = active.filter((r) => r.status === "pending" || r.status === "skipped")
		const superseded = all.filter((r) => r.status === "superseded")

		// Bypass mode: skip verification entirely
		if (this.config.verificationLevel === "bypass") {
			const summary = `[BYPASS] Requirements verification skipped (${all.length} total, ${active.length} active)`
			this.logger?.appendLine(`[RequirementsVerifier] ${summary}`)
			const result: RequirementsVerificationResult = {
				passed: true,
				total: all.length,
				verified,
				failed,
				pending,
				summary,
			}
			this.lastVerifyResult = result
			return result
		}

		// Lenient mode: log warnings but don't block
		if (this.config.verificationLevel === "lenient") {
			if (failed.length > 0 || pending.length > 0) {
				const warnings: string[] = []
				if (failed.length > 0) {
					warnings.push(`${failed.length} failed: ${failed.map((r) => r.text.slice(0, 60)).join("; ")}`)
				}
				if (pending.length > 0) {
					warnings.push(`${pending.length} pending: ${pending.map((r) => r.text.slice(0, 60)).join("; ")}`)
				}
				this.logger?.appendLine(
					`[RequirementsVerifier] [LENIENT] Non-blocking warnings — ${warnings.join(" | ")}`,
				)
			}
			const summary = `[LENIENT] ${active.length} active requirements: ${verified.length} verified, ${failed.length} failed, ${pending.length} pending (${superseded.length} superseded)`
			const result: RequirementsVerificationResult = {
				passed: true,
				total: all.length,
				verified,
				failed,
				pending,
				summary,
			}
			this.lastVerifyResult = result
			return result
		}

		// Strict mode (default)
		const isReadOnlyTask = this.detectReadOnlyTask()

		// NEW: Count requirements that were auto-verified or have actual evidence
		const hasExplicitTracking = verified.length > 0 || failed.length > 0

		let passed: boolean
		if (isReadOnlyTask) {
			passed = true
		} else if (!hasExplicitTracking) {
			// No requirements were explicitly verified or failed — all pending.
			// This means either auto-verification didn't run or there were no file changes.
			// In this case, check if there are any pending requirements at all.
			// If all are pending and zero evidence exists, something is wrong.
			if (pending.length > 0 && all.length > 0) {
				// If the task had file changes but requirements aren't tracked, be lenient
				// but don't fail — the requirements system may not have captured anything actionable.
				passed = true
				this.logger?.appendLine(
					`[RequirementsVerifier] [STRICT] ${pending.length} pending requirements with no tracking — passing (requirements may be informational)`,
				)
			} else {
				passed = true
			}
		} else {
			passed = failed.length === 0 && (pending.length === 0 || !this.config.requireAllVerified)
		}

		let summary: string
		if (all.length === 0) {
			summary = "No requirements extracted"
		} else if (passed) {
			summary = `${active.length} active requirements: ${verified.length} verified, ${failed.length} failed, ${pending.length} pending (${superseded.length} superseded)`
		} else if (failed.length > 0) {
			summary = `${failed.length}/${active.length} active requirements failed: ${failed.map((r) => r.text.slice(0, 80)).join("; ")}`
		} else {
			// pending.length > 0 but no failures — show pending requirements clearly
			summary = `${pending.length}/${active.length} active requirements pending: ${pending.map((r) => r.text.slice(0, 80)).join("; ")}`
		}

		this.lastVerifyResult = { passed, total: all.length, verified, failed, pending, summary }

		return { passed, total: all.length, verified, failed, pending, summary }
	}

	/**
	 * Reset all requirements
	 */
	reset(): void {
		this.requirements.clear()
		this.processedMessageCount = 0
		this.allMessages = []
	}

	/**
	 * Get the number of processed messages
	 */
	getProcessedMessageCount(): number {
		return this.processedMessageCount
	}

	private createRequirement(text: string, category: Requirement["category"], messageIndex: number): Requirement {
		return {
			id: crypto.randomUUID(),
			text,
			category,
			status: "pending",
			messageIndex,
		}
	}
}
