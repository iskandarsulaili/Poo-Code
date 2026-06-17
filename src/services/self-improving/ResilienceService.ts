import type { Logger } from "./types"
import type { ClassifiedError } from "./ErrorClassifier"
import { ErrorCategory, ErrorClassifier } from "./ErrorClassifier"
import type { CodeIndexAdapter } from "./CodeIndexAdapter"
import type { VectorStoreSearchResult } from "../code-index/interfaces/vector-store"
import type { Experiments } from "@roo-code/types"
import type { QuestionEvaluatorService } from "./QuestionEvaluatorService"

export interface ResilienceConfig {
	enabled: boolean
	maxRetries: number
	baseDelayMs: number
	maxDelayMs: number
	jitterFactor: number
	autoRecover: boolean
	recoveryCommands: string[]
	persistState: boolean
}

export interface RecoveryState {
	consecutiveFailures: number
	/** Separate counter for streaming failures to prevent cross-contamination
	 *  with tool/mistake failures. Streaming failures have their own retry budget
	 *  so that consecutive mistakes don't exhaust the streaming retry limit. */
	streamingFailureCount: number
	lastFailureType: string | null
	lastFailureTime: number | null
	lastSuccessfulTool: string | null
	recoveryAttempts: number
	isInRecoveryMode: boolean
}

const DEFAULT_CONFIG: ResilienceConfig = {
	enabled: true,
	maxRetries: 5,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	jitterFactor: 0.1,
	autoRecover: true,
	recoveryCommands: [
		"break down the task into smaller steps",
		"simplify the approach",
		"try a different strategy",
		"verify tool parameters before calling",
	],
	persistState: true,
}

export class ResilienceService {
	private logger: Logger
	private config: ResilienceConfig
	private state: RecoveryState
	private codeIndexAdapter: CodeIndexAdapter | undefined
	private questionEvaluator: QuestionEvaluatorService | undefined
	private errorClassifier: ErrorClassifier

	constructor(logger: Logger, config?: Partial<ResilienceConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.state = this.getInitialState()
		this.errorClassifier = new ErrorClassifier()
	}

	setCodeIndexAdapter(adapter: CodeIndexAdapter | undefined): void {
		this.codeIndexAdapter = adapter
	}

	/**
	 * Set the QuestionEvaluatorService for contextual recovery answer generation.
	 * Used by the "Zoo is having trouble" pipeline to generate review-gated answers.
	 */
	setQuestionEvaluator(evaluator: QuestionEvaluatorService | undefined): void {
		this.questionEvaluator = evaluator
	}

	getConfig(): ResilienceConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<ResilienceConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[Resilience] Config updated: ${JSON.stringify(updates)}`)
	}

	getState(): RecoveryState {
		return { ...this.state }
	}

	/**
	 * Called when a "having trouble" or streaming failure occurs.
	 * Returns the delay in ms before the next retry, or -1 if max retries exceeded.
	 *
	 * Uses a separate streamingFailureCount counter to prevent cross-contamination
	 * with tool/mistake failures. This ensures that consecutive mistakes don't
	 * exhaust the streaming retry budget, and vice versa.
	 */
	onStreamingFailure(): number {
		if (!this.config.enabled) {
			return -1
		}

		this.state.streamingFailureCount++
		this.state.lastFailureType = "streaming_failed"
		this.state.lastFailureTime = Date.now()
		this.state.isInRecoveryMode = true

		if (this.state.streamingFailureCount > this.config.maxRetries) {
			this.logger.appendLine(
				`[Resilience] Max streaming retries (${this.config.maxRetries}) exceeded. Entering recovery mode.`,
			)
			return -1 // Signal to enter recovery mode
		}

		const delay = this.calculateBackoff(this.state.streamingFailureCount)
		this.logger.appendLine(
			`[Resilience] Streaming failure #${this.state.streamingFailureCount}. Retrying in ${delay}ms.`,
		)
		return delay
	}

	/**
	 * Called when a tool parameter validation error occurs (e.g., missing required parameter).
	 * Returns a recovery action suggestion or null.
	 */
	onToolParameterError(
		toolName: string,
		missingParam: string,
	): { action: "retry" | "recover" | "abort"; delay?: number; suggestion?: string } | null {
		if (!this.config.enabled) {
			return null
		}

		this.state.consecutiveFailures++
		this.state.lastFailureType = "tool_parameter_error"
		this.state.lastFailureTime = Date.now()
		this.state.lastSuccessfulTool = toolName

		this.logger.appendLine(
			`[Resilience] Tool parameter error: ${toolName} missing '${missingParam}'. Failure #${this.state.consecutiveFailures}.`,
		)

		// Record this as a learning event for the self-improving system
		this.recordToolError(toolName, missingParam)

		if (this.state.consecutiveFailures > this.config.maxRetries) {
			return {
				action: "abort",
				suggestion: `Tool ${toolName} repeatedly missing required parameter '${missingParam}'`,
			}
		}

		const delay = this.calculateBackoff(this.state.consecutiveFailures)
		return {
			action: "retry",
			delay,
			suggestion: `Ensure '${missingParam}' parameter is provided when calling ${toolName}`,
		}
	}

	/**
	 * Check if the streaming failure is due to a large response (not model error).
	 * Large responses occur when the model tries to deliver a comprehensive result
	 * that exceeds API limits — this is not a model error and should not trigger recovery.
	 */
	isLargeResponseFailure(error: string): boolean {
		const largeResponseIndicators = [
			"response too large",
			"response too long",
			"max_tokens",
			"maximum context length",
			"too many tokens",
			"content too large",
			"stream.*timeout",
			"timeout.*stream",
			"413",
			"payload too large",
		]
		return largeResponseIndicators.some((indicator) => new RegExp(indicator, "i").test(error))
	}

	/**
	 * Handle a large response failure — suggest shortening instead of triggering recovery.
	 * Does NOT increment consecutiveFailures since this isn't a model error.
	 */
	onLargeResponseFailure(): string {
		return "The response was too large. Shorten the response and try again. Consider summarizing or splitting into smaller chunks."
	}

	/**
	 * Called when the model is attempting to deliver a final result (attempt_completion).
	 * Resets recovery state to prevent false positive recovery from large response failures.
	 */
	onDeliveryAttempt(): void {
		this.state.consecutiveFailures = 0
		this.state.streamingFailureCount = 0
		this.state.isInRecoveryMode = false
		this.state.recoveryAttempts = 0
	}

	/**
	 * Called when a task succeeds — resets recovery state.
	 */
	onTaskSuccess(): void {
		if (this.state.consecutiveFailures > 0) {
			this.logger.appendLine(
				`[Resilience] Task succeeded after ${this.state.consecutiveFailures} failures. Resetting state.`,
			)
		}
		this.state = this.getInitialState()
	}

	/**
	 * Get a recovery command suggestion based on current state.
	 */
	getRecoverySuggestion(): string {
		if (!this.state.isInRecoveryMode) {
			return ""
		}

		const index = Math.min(this.state.recoveryAttempts, this.config.recoveryCommands.length - 1)
		this.state.recoveryAttempts++

		const suggestion = this.config.recoveryCommands[index] ?? this.config.recoveryCommands[0]
		return suggestion
	}

	/**
	 * Attempt to autonomously recover from "Zoo is having trouble" or consecutive mistake errors.
	 * Uses ErrorClassifier to classify the error, applies exponential backoff, and generates a
	 * self-correction prompt to inject into the conversation for autonomous retry.
	 *
	 * @param error - The error message or Error object
	 * @param context - Context including consecutiveMistakeCount and optional taskId
	 * @returns Recovery result with recovered flag, optional correctionPrompt, and optional delay
	 */
	async attemptRecovery(
		error: string | Error,
		context: { consecutiveMistakeCount: number; taskId?: string },
	): Promise<{ recovered: boolean; correctionPrompt?: string; delay?: number }> {
		if (!this.config.enabled || !this.config.autoRecover) {
			return { recovered: false }
		}

		const errorMessage = typeof error === "string" ? error : error.message
		this.logger.appendLine(
			`[Resilience] attemptRecovery called: "${errorMessage.slice(0, 200)}" (mistakes: ${context.consecutiveMistakeCount})`,
		)

		// Classify the error using ErrorClassifier
		const classified = this.errorClassifier.classify(errorMessage)

		// Only auto-recover for MODEL_THOUGHT_FAILURE and similar recoverable categories
		if (!classified.isRecoverable) {
			this.logger.appendLine(
				`[Resilience] Error not recoverable (${classified.category}). Falling back to human input.`,
			)
			return { recovered: false }
		}

		// Increment failure count and update state
		this.state.consecutiveFailures++
		this.state.lastFailureType = "consecutive_mistake"
		this.state.lastFailureTime = Date.now()
		this.state.isInRecoveryMode = true

		// Calculate exponential backoff delay
		const delay = this.calculateBackoff(this.state.consecutiveFailures)

		// Check if we've exceeded max retries — escalate with a full correction prompt
		if (this.state.consecutiveFailures > this.config.maxRetries) {
			this.logger.appendLine(
				`[Resilience] Max retries (${this.config.maxRetries}) exceeded. Generating self-correction prompt.`,
			)

			// Build a comprehensive correction prompt with the recovery suggestion
			const recoverySuggestion = this.getRecoverySuggestion()
			const correctionPrompt = `[Autonomous Recovery] The previous attempt failed after ${context.consecutiveMistakeCount} consecutive mistakes.

Error Analysis:
- Category: ${classified.category}
- Severity: ${classified.severity}/5
- Suggestion: ${classified.suggestion || "No specific suggestion"}

${recoverySuggestion ? `Recovery Direction: ${recoverySuggestion}` : ""}

Please continue the task with a fresh approach. Simplify your strategy and verify each step before proceeding.`

			// Reset failures since we're generating a correction prompt
			this.state.consecutiveFailures = 0

			return { recovered: true, correctionPrompt, delay }
		}

		// Under max retries: just apply backoff delay and retry
		this.logger.appendLine(`[Resilience] Waiting ${delay}ms before retry #${this.state.consecutiveFailures}`)
		await new Promise((resolve) => setTimeout(resolve, delay))

		return { recovered: true, delay }
	}

	/**
	 * Check if the system is in recovery mode.
	 */
	isInRecoveryMode(): boolean {
		return this.state.isInRecoveryMode
	}

	/**
	 * Exit recovery mode (called when a task succeeds after recovery).
	 */
	exitRecoveryMode(): void {
		this.state.isInRecoveryMode = false
		this.state.recoveryAttempts = 0
		this.logger.appendLine("[Resilience] Exited recovery mode.")
	}

	/**
	 * Record a tool error for the self-improving system to learn from.
	 */
	private recordToolError(toolName: string, missingParam: string): void {
		this.logger.appendLine(`[Resilience] Recording tool error for learning: ${toolName}.${missingParam}`)
	}

	/**
	 * Calculate exponential backoff with jitter.
	 */
	private calculateBackoff(attempt: number): number {
		const exponentialDelay = Math.min(this.config.baseDelayMs * Math.pow(2, attempt - 1), this.config.maxDelayMs)
		const jitter = exponentialDelay * this.config.jitterFactor * Math.random()
		return Math.floor(exponentialDelay + jitter)
	}

	private getInitialState(): RecoveryState {
		return {
			consecutiveFailures: 0,
			streamingFailureCount: 0,
			lastFailureType: null,
			lastFailureTime: null,
			lastSuccessfulTool: null,
			recoveryAttempts: 0,
			isInRecoveryMode: false,
		}
	}

	/**
	 * Format a single VectorStoreSearchResult into a human-readable context line.
	 */
	private formatSearchResult(result: VectorStoreSearchResult): string {
		const filePath = result.payload?.filePath ?? String(result.id)
		const startLine = result.payload?.startLine
		const endLine = result.payload?.endLine
		const snippet = result.payload?.codeChunk
		const lineRange =
			startLine !== undefined && endLine !== undefined
				? ` (lines ${startLine}-${endLine})`
				: startLine !== undefined
					? ` (line ${startLine})`
					: ""
		const snippetStr = snippet ? `: ${snippet.slice(0, 200).replace(/\n/g, " ")}` : ""
		return `- ${filePath}${lineRange}${snippetStr}`
	}

	/**
	 * Generate a contextual recovery answer for "Zoo is having trouble" messages.
	 * Uses the QuestionEvaluatorService (which gates through ReviewTeamService) to
	 * evaluate the trouble subject and produce an approved recovery direction.
	 *
	 * Pipeline:
	 * 1. Detect "Zoo is having trouble" pattern
	 * 2. Extract trouble subject from error message
	 * 3. Generate contextual answer via QuestionEvaluatorService
	 * 4. Gate through ReviewTeamService (4 personas score)
	 * 5. Return approved answer
	 */
	async getContextualRecoveryAnswer(errorMessage: string): Promise<string | undefined> {
		// Only for "Zoo is having trouble" messages
		if (!errorMessage.includes("Zoo is having trouble")) {
			return undefined
		}

		if (!this.questionEvaluator || !this.questionEvaluator.getConfig().enabled) {
			return undefined
		}

		const troubleSubject = new ErrorClassifier().extractTroubleSubject(errorMessage)
		if (!troubleSubject) {
			return undefined
		}

		this.logger.appendLine(
			`[Resilience] Getting contextual recovery answer for: "${troubleSubject.substring(0, 80)}"`,
		)

		try {
			// Provide 2 synthetic choices so evaluator bypasses minChoicesForEvaluation guard
			const evaluation = await this.questionEvaluator.evaluateBestChoice(
				`Recovery guidance needed for: ${troubleSubject.substring(0, 200)}`,
				[
					{
						text: `Continue with contextual recovery for: ${troubleSubject.substring(0, 150)}`,
						mode: null,
					},
					{
						text: `Use standard recovery approach for: ${troubleSubject.substring(0, 150)}`,
						mode: null,
					},
				],
			)

			// Only use result if it was actually evaluated (not fallback)
			if (evaluation.evaluatedBy !== "fallback") {
				const answer = `[Contextual Recovery] Problem analysis: ${evaluation.reasoning}. Suggested approach: ${evaluation.selectedText}.`
				this.logger.appendLine(
					`[Resilience] Contextual recovery answer generated via ${evaluation.evaluatedBy}`,
				)
				return answer
			}
		} catch (error) {
			this.logger.appendLine(
				`[Resilience] getContextualRecoveryAnswer error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		return undefined
	}

	/**
	 * Generate a recovery context block based on the classified error, original message,
	 * and recent conversation history.
	 *
	 * Uses actual recent messages (last user req + last assistant res) to build a
	 * contextual task summary, then queries the code index for relevant context.
	 * Also retrieves contextual recovery answer for "Zoo is having trouble" messages
	 * via the QuestionEvaluatorService/ReviewTeamService pipeline.
	 * Non-blocking — returns original message on any error or when no enrichment is needed.
	 * Gated behind recoveryContext experiment flag.
	 */
	async generateRecoveryContext(
		classifiedError: ClassifiedError,
		originalMessage: string,
		experiments?: Partial<Experiments>,
		recentMessages?: string[],
	): Promise<string> {
		// Only enrich for MODEL_THOUGHT_FAILURE with break_down_task recovery
		if (
			classifiedError.category !== ErrorCategory.MODEL_THOUGHT_FAILURE ||
			classifiedError.recoveryAction !== "break_down_task"
		) {
			return originalMessage
		}

		// Check experiment gate
		if (experiments?.recoveryContext === false) {
			return originalMessage
		}

		// Step 1: Try to get contextual recovery answer via evaluator + review team
		const contextualAnswer = await this.getContextualRecoveryAnswer(originalMessage)

		// Build task summary from recent conversation messages
		const taskSummary = this.buildTaskSummary(recentMessages)

		// Use task summary as the search query for code index (more contextual than originalMessage)
		const searchQuery = taskSummary || originalMessage

		// Step 2: Try to enrich with code index context
		if (this.codeIndexAdapter?.isAvailable()) {
			try {
				const results = await this.codeIndexAdapter.searchVectorStore(searchQuery)
				if (results && results.length > 0) {
					const contextLines = results.map((r) => this.formatSearchResult(r))
					const parts: string[] = [originalMessage]

					// Inject contextual recovery answer if available (higher priority)
					if (contextualAnswer) {
						parts.push(contextualAnswer)
					}

					parts.push(
						`[Context Recovery] You were working on: ${taskSummary || "a task that failed"}. Here is relevant code context:`,
						...contextLines,
					)

					this.logger.appendLine(
						`[Resilience] Recovery context generated: ${results.length} code index results + ${contextualAnswer ? "contextual answer" : "no contextual answer"} (taskSummary: "${(taskSummary || originalMessage).slice(0, 80)}")`,
					)
					return parts.join("\n\n")
				}
			} catch (error) {
				// Graceful fallback — log and return original message
				this.logger.appendLine(
					`[Resilience] Recovery context generation error: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// Step 3: Fallback — inject contextual guidance + recovery answer if available
		if (contextualAnswer) {
			const fallbackGuidance = taskSummary
				? `[Context Recovery] You were working on: ${taskSummary}. Consider breaking this into smaller, more focused steps.`
				: "[Context Recovery] The previous attempt failed. Consider breaking the task into smaller, more focused steps."
			return `${originalMessage}\n\n${contextualAnswer}\n\n${fallbackGuidance}`
		}

		const fallbackGuidance = taskSummary
			? `[Context Recovery] You were working on: ${taskSummary}. Consider breaking this into smaller, more focused steps. Try using a simpler approach or different tool.`
			: "[Context Recovery] The previous attempt failed. Consider breaking the task into smaller, more focused steps. Try using a simpler approach or different tool."
		return `${originalMessage}\n\n${fallbackGuidance}`
	}

	/**
	 * Build a concise task summary from recent conversation messages.
	 * Extracts the last user request and last assistant response to describe
	 * what the agent was trying to do when it failed.
	 */
	private buildTaskSummary(recentMessages?: string[]): string {
		if (!recentMessages || recentMessages.length === 0) {
			return ""
		}

		// Find the last user message (request) and last assistant message (response)
		let lastUserReq = ""
		let lastAssistantRes = ""

		for (const msg of recentMessages) {
			// Simple heuristic: user messages are typically requests/instructions
			if (msg.startsWith("[USER]")) {
				lastUserReq = msg.slice(6).trim()
			} else if (msg.startsWith("[ASSISTANT]")) {
				lastAssistantRes = msg.slice(11).trim()
			}
		}

		// Build summary from the last user request
		if (lastUserReq) {
			// Truncate to first 200 chars for a concise summary
			const truncated = lastUserReq.length > 200 ? lastUserReq.slice(0, 200) + "..." : lastUserReq
			return truncated
		}

		// Fallback to assistant response if no user message found
		if (lastAssistantRes) {
			const truncated = lastAssistantRes.length > 200 ? lastAssistantRes.slice(0, 200) + "..." : lastAssistantRes
			return truncated
		}

		return ""
	}

	getStatus(): Record<string, any> {
		return {
			enabled: this.config.enabled,
			maxRetries: this.config.maxRetries,
			autoRecover: this.config.autoRecover,
			consecutiveFailures: this.state.consecutiveFailures,
			isInRecoveryMode: this.state.isInRecoveryMode,
			lastFailureType: this.state.lastFailureType,
			recoveryAttempts: this.state.recoveryAttempts,
		}
	}
}
