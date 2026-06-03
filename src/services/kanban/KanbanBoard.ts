import {
	KanbanError,
	BoardNotFoundError,
	CardNotFoundError,
	CyclicDependencyError,
	InvalidStatusTransitionError,
} from "./types"
import type {
	KanbanBoard,
	KanbanCard,
	CardStatus,
	BoardStatus,
	BoardProgress,
	CreateCardInput,
	KanbanBoardEvent,
	KanbanBoardEventListener,
	CardPriority,
} from "./types"
import { generateBoardId, generateCardId, computeBoardProgress, wouldCreateCycle, VALID_TRANSITIONS } from "./types"

/**
 * KanbanBoardManager — manages board and card CRUD with typed events,
 * dependency cycle detection, and status validation.
 *
 * Boards are held in-memory with a typed event system for change notifications.
 *
 * @example
 * ```ts
 * const manager = new KanbanBoardManager()
 * const board = manager.createBoard("Feature Sprint 24", "Q3 features")
 * const card = manager.addCard(board.id, {
 *   title: "Implement auth",
 *   description: "OAuth2 login flow",
 *   priority: "high",
 *   acceptanceCriteria: ["User can log in with Google", "Tokens refresh automatically"],
 * })
 * manager.updateCardStatus(card.id, "in_progress")
 * ```
 */
export class KanbanBoardManager {
	private readonly boards: Map<string, KanbanBoard>
	private readonly listeners: Map<string, Set<KanbanBoardEventListener>>

	constructor() {
		this.boards = new Map()
		this.listeners = new Map()
	}

	// ─── Board CRUD ───────────────────────────────────────────────────────

	/**
	 * Create a new kanban board.
	 *
	 * @param name - Board name
	 * @param description - Optional description
	 * @returns The newly created board
	 */
	createBoard(name: string, description?: string): KanbanBoard {
		const now = Date.now()
		const board: KanbanBoard = {
			id: generateBoardId(),
			name,
			description,
			cards: [],
			createdAt: now,
			updatedAt: now,
			status: "active",
		}

		this.boards.set(board.id, board)
		this.emit({ type: "board_completed", boardId: board.id, timestamp: now })

		return board
	}

	/**
	 * Get a board by ID.
	 *
	 * @param boardId - The board's ID
	 * @returns The board
	 * @throws {BoardNotFoundError} If not found
	 */
	getBoard(boardId: string): KanbanBoard {
		const board = this.boards.get(boardId)
		if (!board) {
			throw new BoardNotFoundError(boardId)
		}
		return board
	}

	/**
	 * Update board metadata (name, description, status).
	 *
	 * @param boardId - Board ID
	 * @param updates - Partial fields to update
	 * @returns The updated board
	 */
	updateBoard(boardId: string, updates: Partial<Pick<KanbanBoard, "name" | "description" | "status">>): KanbanBoard {
		const board = this.getBoard(boardId)
		Object.assign(board, updates, { updatedAt: Date.now() })
		this.boards.set(boardId, board)

		if (updates.status === "completed" || updates.status === "archived") {
			this.emit({
				type: updates.status === "completed" ? "board_completed" : "board_archived",
				boardId,
				timestamp: Date.now(),
			})
		}

		return board
	}

	/**
	 * Delete a board and all its cards.
	 *
	 * @param boardId - Board ID to delete
	 * @throws {BoardNotFoundError} If not found
	 */
	deleteBoard(boardId: string): void {
		if (!this.boards.has(boardId)) {
			throw new BoardNotFoundError(boardId)
		}
		this.boards.delete(boardId)
	}

	/**
	 * List all boards with optional status filter.
	 *
	 * @param status - Optional status filter
	 * @returns Array of matching boards
	 */
	listBoards(status?: BoardStatus): KanbanBoard[] {
		const all = [...this.boards.values()]
		if (status) {
			return all.filter((b) => b.status === status)
		}
		return all
	}

	// ─── Card CRUD ────────────────────────────────────────────────────────

	/**
	 * Add a card to a board.
	 *
	 * @param boardId - ID of the board to add the card to
	 * @param input - Card creation input
	 * @returns The newly created card
	 * @throws {BoardNotFoundError} If the board doesn't exist
	 * @throws {CyclicDependencyError} If the deps would create a cycle
	 */
	addCard(boardId: string, input: CreateCardInput): KanbanCard {
		const board = this.getBoard(boardId)
		const now = Date.now()

		const card: KanbanCard = {
			id: generateCardId(),
			boardId,
			title: input.title,
			description: input.description,
			status: "todo",
			priority: input.priority ?? "medium",
			deps: input.deps ?? [],
			assignedTo: input.assignedTo,
			acceptanceCriteria: input.acceptanceCriteria ?? [],
			createdAt: now,
			updatedAt: now,
			metadata: input.metadata,
		}

		// Validate deps won't create cycles
		for (const depId of card.deps) {
			if (wouldCreateCycle(card.id, depId, board.cards)) {
				throw new CyclicDependencyError(card.id, depId)
			}
		}

		board.cards.push(card)
		board.updatedAt = now
		this.boards.set(boardId, board)

		this.emit({
			type: "card_added",
			boardId,
			cardId: card.id,
			timestamp: now,
			payload: card,
		})

		return card
	}

	/**
	 * Get a card by ID across all boards.
	 *
	 * @param cardId - The card's ID
	 * @returns The card
	 * @throws {CardNotFoundError} If not found
	 */
	getCard(cardId: string): KanbanCard {
		for (const [, board] of this.boards) {
			const card = board.cards.find((c) => c.id === cardId)
			if (card) {
				return card
			}
		}
		throw new CardNotFoundError(cardId)
	}

	/**
	 * Update card fields (title, description, priority, etc.).
	 *
	 * @param cardId - Card ID
	 * @param updates - Fields to update
	 * @returns The updated card
	 */
	updateCard(
		cardId: string,
		updates: Partial<
			Pick<KanbanCard, "title" | "description" | "priority" | "assignedTo" | "acceptanceCriteria" | "metadata">
		>,
	): KanbanCard {
		const card = this.getCard(cardId)
		const now = Date.now()

		if (updates.title !== undefined) card.title = updates.title
		if (updates.description !== undefined) card.description = updates.description
		if (updates.priority !== undefined) card.priority = updates.priority
		if (updates.assignedTo !== undefined) card.assignedTo = updates.assignedTo
		if (updates.acceptanceCriteria !== undefined) card.acceptanceCriteria = updates.acceptanceCriteria
		if (updates.metadata !== undefined) card.metadata = updates.metadata
		card.updatedAt = now

		this.emit({
			type: "card_updated",
			boardId: card.boardId,
			cardId,
			timestamp: now,
			payload: card,
		})

		return card
	}

	/**
	 * Update a card's status with transition validation.
	 *
	 * Valid transitions:
	 * - todo → in_progress, blocked
	 * - in_progress → in_review, blocked, todo
	 * - in_review → done, in_progress, blocked
	 * - done → in_review
	 * - blocked → todo, in_progress
	 *
	 * @param cardId - Card ID
	 * @param status - New status
	 * @throws {CardNotFoundError} If card not found
	 * @throws {InvalidStatusTransitionError} If transition is not allowed
	 */
	updateCardStatus(cardId: string, status: CardStatus): void {
		const card = this.getCard(cardId)
		const now = Date.now()

		const allowed = VALID_TRANSITIONS[card.status]
		if (!allowed.includes(status)) {
			throw new InvalidStatusTransitionError(cardId, card.status, status)
		}

		card.status = status
		card.updatedAt = now

		this.emit({
			type: "card_updated",
			boardId: card.boardId,
			cardId,
			timestamp: now,
			payload: card,
		})
	}

	/**
	 * Remove a card from its board.
	 *
	 * @param cardId - Card ID to remove
	 * @throws {CardNotFoundError} If card not found
	 */
	removeCard(cardId: string): void {
		const card = this.getCard(cardId)
		const board = this.getBoard(card.boardId)

		board.cards = board.cards.filter((c) => c.id !== cardId)
		board.updatedAt = Date.now()

		// Clean up dep references in other cards
		for (const otherCard of board.cards) {
			otherCard.deps = otherCard.deps.filter((d) => d !== cardId)
		}

		this.emit({
			type: "card_removed",
			boardId: card.boardId,
			cardId,
			timestamp: Date.now(),
		})
	}

	/**
	 * Add a dependency: card `cardId` depends on `depCardId`.
	 *
	 * @param cardId - The card that depends on another
	 * @param depCardId - The card that must be completed first
	 * @throws {CyclicDependencyError} If adding would create a cycle
	 * @throws {CardNotFoundError} If either card not found
	 */
	addDependency(cardId: string, depCardId: string): void {
		// Verify both cards exist
		const card = this.getCard(cardId)
		const depCard = this.getCard(depCardId)

		if (card.deps.includes(depCardId)) {
			return // Already depends on it
		}

		// Check cycle
		const board = this.getBoard(card.boardId)
		if (wouldCreateCycle(cardId, depCardId, board.cards)) {
			throw new CyclicDependencyError(cardId, depCardId)
		}

		card.deps.push(depCardId)
		card.updatedAt = Date.now()

		this.emit({
			type: "card_updated",
			boardId: card.boardId,
			cardId,
			timestamp: Date.now(),
		})
	}

	/**
	 * Remove a dependency from card `cardId` on `depCardId`.
	 */
	removeDependency(cardId: string, depCardId: string): void {
		const card = this.getCard(cardId)
		card.deps = card.deps.filter((d) => d !== depCardId)
		card.updatedAt = Date.now()
	}

	// ─── Queries ──────────────────────────────────────────────────────────

	/**
	 * Get all dependencies for a card.
	 *
	 * @param cardId - Card ID
	 * @returns Array of dependency cards
	 */
	getDependencies(cardId: string): KanbanCard[] {
		const card = this.getCard(cardId)
		const board = this.getBoard(card.boardId)
		return card.deps
			.map((depId) => board.cards.find((c) => c.id === depId))
			.filter((c): c is KanbanCard => c !== undefined)
	}

	/**
	 * Get all blocked cards on a board (cards whose deps aren't all done).
	 *
	 * @param boardId - Board ID
	 * @returns Array of blocked cards
	 */
	getBlockedCards(boardId: string): KanbanCard[] {
		const board = this.getBoard(boardId)
		return board.cards.filter((card) => {
			// A card is blocked if any of its deps are not done
			return card.deps.some((depId) => {
				const depCard = board.cards.find((c) => c.id === depId)
				return depCard && depCard.status !== "done"
			})
		})
	}

	/**
	 * Compute progress for a board.
	 */
	getBoardProgress(boardId: string): BoardProgress {
		const board = this.getBoard(boardId)
		return computeBoardProgress(board.cards)
	}

	/**
	 * Get cards that are ready to work on (all deps done, not in progress).
	 */
	getReadyCards(boardId: string): KanbanCard[] {
		const board = this.getBoard(boardId)
		return board.cards.filter((card) => {
			if (card.status !== "todo") {
				return false
			}
			// All deps must be done
			return card.deps.every((depId) => {
				const depCard = board.cards.find((c) => c.id === depId)
				return depCard && depCard.status === "done"
			})
		})
	}

	/**
	 * Get cards sorted by priority (critical > high > medium > low).
	 */
	getCardsByPriority(boardId: string): KanbanCard[] {
		const board = this.getBoard(boardId)
		const priorityWeight = { critical: 4, high: 3, medium: 2, low: 1 }
		return [...board.cards].sort((a, b) => (priorityWeight[b.priority] ?? 0) - (priorityWeight[a.priority] ?? 0))
	}

	// ─── Events ───────────────────────────────────────────────────────────

	/**
	 * Subscribe to board events.
	 *
	 * @param boardId - Board to listen to, or "*" for all boards
	 * @param listener - Callback for events
	 * @returns Unsubscribe function
	 */
	onEvent(boardId: string, listener: KanbanBoardEventListener): () => void {
		const key = boardId
		if (!this.listeners.has(key)) {
			this.listeners.set(key, new Set())
		}
		this.listeners.get(key)!.add(listener)

		return () => {
			this.listeners.get(key)?.delete(listener)
		}
	}

	/**
	 * Emit an event to all listeners.
	 */
	private emit(event: KanbanBoardEvent): void {
		// Board-specific listeners
		this.listeners.get(event.boardId)?.forEach((l) => {
			try {
				l(event)
			} catch {
				// Silently catch listener errors
			}
		})

		// Global listeners
		this.listeners.get("*")?.forEach((l) => {
			try {
				l(event)
			} catch {
				// Silently catch listener errors
			}
		})
	}

	// ─── Serialization ────────────────────────────────────────────────────

	/**
	 * Export all boards to a serializable JSON structure.
	 */
	exportBoards(): KanbanBoard[] {
		return [...this.boards.values()]
	}

	/**
	 * Import boards from a serialized JSON structure.
	 * Existing boards with the same ID are overwritten.
	 */
	importBoards(boards: KanbanBoard[]): void {
		for (const board of boards) {
			this.boards.set(board.id, board)
		}
	}
}
