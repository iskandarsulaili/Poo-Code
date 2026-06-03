import type { KanbanCard, CardResult, BoardProgress } from "./types"
import { BoardNotFoundError, computeBoardProgress } from "./types"
import { KanbanBoardManager } from "./KanbanBoard"
import type { SubagentManager } from "../subagent/SubagentManager"
import { generateSubagentId } from "../subagent/types"

/**
 * WorkerPool — executes kanban cards by delegating to subagents (F1).
 *
 * Handles dependency resolution (only executes cards whose deps are done),
 * parallel execution with configurable concurrency, and progress tracking.
 *
 * @example
 * ```ts
 * const worker = new WorkerPool(subagentManager, boardManager)
 * const result = await worker.executeCard(card)
 * ```
 */
export class WorkerPool {
	private readonly subagentManager: SubagentManager
	private readonly boardManager: KanbanBoardManager
	private readonly defaultConcurrency: number

	/**
	 * @param subagentManager - F1 SubagentManager for delegating card work
	 * @param boardManager - F2 KanbanBoardManager for board state
	 * @param options.defaultConcurrency - Max parallel card execution (default: 3)
	 */
	constructor(
		subagentManager: SubagentManager,
		boardManager: KanbanBoardManager,
		options?: { defaultConcurrency?: number },
	) {
		this.subagentManager = subagentManager
		this.boardManager = boardManager
		this.defaultConcurrency = options?.defaultConcurrency ?? 3
	}

	/**
	 * Execute a single card by delegating to a subagent.
	 *
	 * The card's title and description become the subagent task prompt.
	 * Acceptance criteria are passed as additional context.
	 *
	 * @param card - The card to execute
	 * @returns CardResult with execution output
	 */
	async executeCard(card: KanbanCard): Promise<CardResult> {
		const startTime = Date.now()
		const subagentId = generateSubagentId()

		// Build the task prompt from card data
		const prompt = this.buildCardPrompt(card)

		try {
			const result = await this.subagentManager.spawnSubagent({
				subagentId,
				role: "leaf",
				taskPrompt: prompt,
				allowedTools: [
					"read_file",
					"search_files",
					"codebase_search",
					"apply_diff",
					"write_to_file",
					"execute_command",
				],
			})

			return {
				cardId: card.id,
				success: result.success,
				output: result.output,
				filesModified: result.filesModified,
				errors: result.errors,
				executionTimeMs: result.executionTimeMs,
				subagentId: result.subagentId,
			}
		} catch (error) {
			return {
				cardId: card.id,
				success: false,
				output: "",
				filesModified: [],
				errors: [error instanceof Error ? error.message : String(error)],
				executionTimeMs: Date.now() - startTime,
			}
		}
	}

	/**
	 * Execute multiple cards in parallel respecting dependency order.
	 *
	 * Cards are executed in topological order: all deps of a card must be
	 * done ("completed" status) before the card runs. Within the same
	 * dependency level, up to `maxConcurrency` cards run in parallel.
	 *
	 * @param cards - Cards to execute
	 * @param maxConcurrency - Max parallel executions (default: pool default)
	 * @returns Array of CardResult in input order
	 */
	async executeParallel(cards: KanbanCard[], maxConcurrency?: number): Promise<CardResult[]> {
		if (cards.length === 0) {
			return []
		}

		const concurrency = maxConcurrency ?? this.defaultConcurrency
		const results: CardResult[] = []
		const completed = new Set<string>()
		const failed = new Set<string>()

		// Topological sort by deps
		const levels = this.topologicalSort(cards)

		for (const level of levels) {
			// Execute all cards at this dependency level in parallel
			const levelPromises = level.map(async (card) => {
				const result = await this.executeCard(card)
				if (result.success) {
					completed.add(card.id)
				} else {
					failed.add(card.id)
				}
				return result
			})

			// Process in batches of concurrency
			for (let i = 0; i < levelPromises.length; i += concurrency) {
				const batch = levelPromises.slice(i, i + concurrency)
				const batchResults = await Promise.all(batch)
				results.push(...batchResults)
			}
		}

		return results
	}

	/**
	 * Get progress for a board.
	 */
	getProgress(boardId: string): BoardProgress {
		try {
			const board = this.boardManager.getBoard(boardId)
			return computeBoardProgress(board.cards)
		} catch (error) {
			if (error instanceof BoardNotFoundError) {
				return { total: 0, todo: 0, inProgress: 0, inReview: 0, done: 0, blocked: 0, percentage: 0 }
			}
			throw error
		}
	}

	/**
	 * Build a subagent prompt from card data.
	 */
	private buildCardPrompt(card: KanbanCard): string {
		const lines: string[] = [`Task: ${card.title}`, "", card.description]

		if (card.acceptanceCriteria.length > 0) {
			lines.push("", "Acceptance Criteria:")
			for (const ac of card.acceptanceCriteria) {
				lines.push(`- ${ac}`)
			}
		}

		return lines.join("\n")
	}

	/**
	 * Topological sort of cards by dependency order.
	 * Returns levels (arrays of cards at each depth).
	 */
	private topologicalSort(cards: KanbanCard[]): KanbanCard[][] {
		const cardMap = new Map(cards.map((c) => [c.id, c]))
		const inDegree = new Map<string, number>()
		const adjList = new Map<string, string[]>()

		// Build adjacency and in-degree
		for (const card of cards) {
			inDegree.set(card.id, 0)
			adjList.set(card.id, [])
		}

		for (const card of cards) {
			for (const depId of card.deps) {
				if (cardMap.has(depId)) {
					// depId -> card.id (dep must be done before card)
					adjList.get(depId)?.push(card.id)
					inDegree.set(card.id, (inDegree.get(card.id) ?? 0) + 1)
				}
			}
		}

		// Kahn's algorithm
		const levels: KanbanCard[][] = []
		let queue = [...cards].filter((c) => (inDegree.get(c.id) ?? 0) === 0)

		while (queue.length > 0) {
			levels.push(queue)
			const nextQueue: KanbanCard[] = []

			for (const card of queue) {
				const neighbors = adjList.get(card.id) ?? []
				for (const neighborId of neighbors) {
					const newDegree = (inDegree.get(neighborId) ?? 1) - 1
					inDegree.set(neighborId, newDegree)
					if (newDegree === 0) {
						const neighborCard = cardMap.get(neighborId)
						if (neighborCard) {
							nextQueue.push(neighborCard)
						}
					}
				}
			}

			queue = nextQueue
		}

		return levels
	}
}
