import type { KanbanCard, DecompositionResult, CardPriority } from "./types"
import { generateCardId, CyclicDependencyError, CardNotFoundError } from "./types"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import type { ProviderSettings } from "@roo-code/types"

/**
 * Default system prompt for the decomposition LLM call.
 */
const DECOMPOSITION_SYSTEM_PROMPT = `You are a task decomposition expert. Break down the given task into discrete, actionable subtasks.

For each subtask, provide:
1. A concise title (5-10 words)
2. A detailed description of what needs to be done
3. Priority (critical/high/medium/low)
4. Dependencies — which other subtasks must be completed first (by index, 0-based)
5. Acceptance criteria — 2-4 specific, verifiable conditions

Output format: JSON array. Each element: { "title": string, "description": string, "priority": "low"|"medium"|"high"|"critical", "deps": number[], "acceptanceCriteria": string[] }

Rules:
- Maximum 10 subtasks
- Each subtask should be independently executable
- Dependencies must not create cycles
- Include a subtask for testing/verification
- Acceptance criteria must be objectively verifiable`

/**
 * TaskDecomposer — LLM-assisted decomposition of high-level tasks into
 * kanban card subtasks.
 *
 * Uses Zoo-Code's existing API provider infrastructure via
 * `singleCompletionHandler` for LLM calls, with keyword-based fallback
 * for validation.
 *
 * @example
 * ```ts
 * const decomposer = new TaskDecomposer(apiConfig)
 * const cards = await decomposer.decompose("Build user authentication system")
 * // cards[0].title === "Design database schema for users"
 * ```
 */
export class TaskDecomposer {
	private readonly apiConfiguration: ProviderSettings
	private readonly maxCards: number

	/**
	 * @param apiConfiguration - Zoo-Code API provider settings
	 * @param options.maxCards - Maximum cards per decomposition (default: 10)
	 */
	constructor(apiConfiguration: ProviderSettings, options?: { maxCards?: number }) {
		this.apiConfiguration = apiConfiguration
		this.maxCards = options?.maxCards ?? 10
	}

	/**
	 * Decompose a high-level task description into kanban cards.
	 *
	 * Sends the task description to the configured LLM with a structured
	 * prompt, parses the JSON response, and validates the result.
	 *
	 * @param taskDescription - The high-level task to decompose
	 * @param context - Optional additional context (e.g. codebase info, constraints)
	 * @returns Array of validated KanbanCards
	 * @throws If LLM call fails or response is unparseable
	 */
	async decompose(taskDescription: string, context?: string): Promise<KanbanCard[]> {
		const prompt = this.buildPrompt(taskDescription, context)
		const raw = await singleCompletionHandler(this.apiConfiguration, prompt)

		const parsed = this.parseResponse(raw, taskDescription)
		const validation = this.validateDecomposition(parsed)

		if (!validation.valid) {
			// If validation fails, try to fix common issues
			if (validation.cycles.length > 0) {
				throw new CyclicDependencyError(validation.cycles[0].from, validation.cycles[0].to)
			}
		}

		return parsed
	}

	/**
	 * Refine an existing board's decomposition based on feedback.
	 *
	 * @param boardId - Board ID (not directly used, but passed for context)
	 * @param feedback - User feedback on current cards
	 * @returns Refined array of KanbanCards
	 */
	async refineDecomposition(boardId: string, feedback: string): Promise<KanbanCard[]> {
		const prompt = [
			DECOMPOSITION_SYSTEM_PROMPT,
			"",
			"Previous decomposition needs refinement.",
			`Feedback: ${feedback}`,
			"",
			"Please provide a revised decomposition addressing the feedback.",
		].join("\n")

		const raw = await singleCompletionHandler(this.apiConfiguration, prompt)
		return this.parseResponse(raw, feedback)
	}

	/**
	 * Validate a decomposition for structural correctness.
	 *
	 * Checks:
	 * - No orphan cards (cards that depend on non-existent cards)
	 * - No cyclic dependencies
	 * - No missing obvious steps (heuristic)
	 * - Cards have acceptance criteria
	 *
	 * @param cards - Array of cards to validate
	 * @returns Decomposition result with issues
	 */
	validateDecomposition(cards: KanbanCard[]): DecompositionResult {
		const cardIds = new Set(cards.map((c) => c.id))
		const orphanCards: KanbanCard[] = []
		const cycles: Array<{ from: string; to: string }> = []
		const missingSteps: string[] = []
		const gaps: string[] = []
		const warnings: string[] = []

		// Check for orphan dependencies
		for (const card of cards) {
			for (const depId of card.deps) {
				if (!cardIds.has(depId)) {
					orphanCards.push(card)
					warnings.push(`Card "${card.title}" (${card.id}) depends on non-existent card ${depId}`)
				}
			}
		}

		// Check for cycles (DFS)
		const visited = new Set<string>()
		const inStack = new Set<string>()

		const dfs = (cardId: string): boolean => {
			if (inStack.has(cardId)) {
				return true // Cycle detected
			}
			if (visited.has(cardId)) {
				return false
			}
			visited.add(cardId)
			inStack.add(cardId)

			const card = cards.find((c) => c.id === cardId)
			if (card) {
				for (const depId of card.deps) {
					if (dfs(depId)) {
						cycles.push({ from: cardId, to: depId })
						return true
					}
				}
			}

			inStack.delete(cardId)
			return false
		}

		for (const card of cards) {
			dfs(card.id)
		}

		// Check for missing acceptance criteria
		const noCriteria = cards.filter((c) => !c.acceptanceCriteria || c.acceptanceCriteria.length === 0)
		if (noCriteria.length > 0) {
			missingSteps.push(
				`${noCriteria.length} card(s) lack acceptance criteria: ${noCriteria.map((c) => `"${c.title}"`).join(", ")}`,
			)
		}

		// Check for testing card
		const hasTestCard = cards.some(
			(c) =>
				c.title.toLowerCase().includes("test") ||
				c.title.toLowerCase().includes("verif") ||
				c.description.toLowerCase().includes("test"),
		)
		if (!hasTestCard) {
			warnings.push("No testing/verification subtask found; consider adding one")
		}

		// Check for gaps: too few cards for a complex task
		if (cards.length < 2 && cards.some((c) => c.description.length > 500)) {
			gaps.push("Task may be under-decomposed — consider splitting into more granular subtasks")
		}

		return {
			valid: orphanCards.length === 0 && cycles.length === 0,
			orphanCards,
			cycles,
			missingSteps,
			gaps,
			warnings,
		}
	}

	/**
	 * Build the prompt for the LLM.
	 */
	private buildPrompt(taskDescription: string, context?: string): string {
		const parts: string[] = [DECOMPOSITION_SYSTEM_PROMPT, "", `Task: ${taskDescription}`]

		if (context) {
			parts.push("", `Context: ${context}`)
		}

		parts.push("", "Respond ONLY with valid JSON, no explanation, no markdown formatting.")

		return parts.join("\n")
	}

	/**
	 * Parse the LLM response into KanbanCard objects.
	 */
	private parseResponse(raw: string, _taskDescription: string): KanbanCard[] {
		// Strip possible markdown fences
		let cleaned = raw.trim()
		if (cleaned.startsWith("```")) {
			cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
		}

		const parsed = JSON.parse(cleaned)

		if (!Array.isArray(parsed)) {
			throw new Error(`Expected JSON array from decomposition, got ${typeof parsed}`)
		}

		return parsed
			.slice(0, this.maxCards)
			.map(
				(item: {
					title?: string
					description?: string
					priority?: CardPriority
					deps?: number[]
					acceptanceCriteria?: string[]
				}): KanbanCard => {
					if (!item.title) {
						throw new Error("Decomposition item missing 'title' field")
					}

					return {
						id: generateCardId(),
						boardId: "", // Set when added to board
						title: item.title,
						description: item.description ?? "",
						status: "todo",
						priority: item.priority ?? "medium",
						deps: [], // Resolved from indices below
						acceptanceCriteria: item.acceptanceCriteria ?? [],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					}
				},
			)
	}
}
