import crypto from "crypto"

// ─── Error Classes ──────────────────────────────────────────────────────────

/**
 * Base error for kanban-related failures.
 */
export class KanbanError extends Error {
	readonly code: string
	override readonly cause?: unknown

	constructor(message: string, code: string, cause?: unknown) {
		super(message)
		this.name = "KanbanError"
		this.code = code
		this.cause = cause
	}
}

/**
 * Error thrown when a referenced board is not found.
 */
export class BoardNotFoundError extends KanbanError {
	constructor(boardId: string) {
		super(`Board ${boardId} not found`, "BOARD_NOT_FOUND")
		this.name = "BoardNotFoundError"
	}
}

/**
 * Error thrown when a referenced card is not found.
 */
export class CardNotFoundError extends KanbanError {
	constructor(cardId: string) {
		super(`Card ${cardId} not found`, "CARD_NOT_FOUND")
		this.name = "CardNotFoundError"
	}
}

/**
 * Error thrown when a cyclic dependency is detected.
 */
export class CyclicDependencyError extends KanbanError {
	constructor(cardId: string, depCardId: string) {
		super(`Adding dependency ${cardId} -> ${depCardId} would create a cycle`, "CYCLE_DETECTED")
		this.name = "CyclicDependencyError"
	}
}

/**
 * Error thrown when an invalid status transition is attempted.
 */
export class InvalidStatusTransitionError extends KanbanError {
	constructor(cardId: string, from: CardStatus, to: CardStatus) {
		super(`Invalid status transition for card ${cardId}: ${from} -> ${to}`, "INVALID_TRANSITION")
		this.name = "InvalidStatusTransitionError"
	}
}

// ─── Enums & Literal Types ──────────────────────────────────────────────────

/**
 * Board lifecycle status.
 */
export type BoardStatus = "active" | "completed" | "archived"

/**
 * Possible statuses for a kanban card.
 */
export type CardStatus = "todo" | "in_progress" | "in_review" | "done" | "blocked"

/**
 * Dependency direction type.
 */
export type DependencyType = "blocks" | "depends_on"

/**
 * Priority levels for cards.
 */
export type CardPriority = "low" | "medium" | "high" | "critical"

/**
 * All valid card statuses in order of progression.
 */
export const CARD_STATUS_FLOW: readonly CardStatus[] = ["todo", "in_progress", "in_review", "done", "blocked"]

/**
 * Valid forward transitions per status.
 */
export const VALID_TRANSITIONS: Record<CardStatus, readonly CardStatus[]> = {
	todo: ["in_progress", "blocked"],
	in_progress: ["in_review", "blocked", "todo"],
	in_review: ["done", "in_progress", "blocked"],
	done: ["in_review"],
	blocked: ["todo", "in_progress"],
}

// ─── Core Types ─────────────────────────────────────────────────────────────

/**
 * A kanban board containing a collection of cards.
 */
export interface KanbanBoard {
	id: string
	name: string
	description?: string
	cards: KanbanCard[]
	createdAt: number
	updatedAt: number
	status: BoardStatus
}

/**
 * A single card/task on a kanban board.
 */
export interface KanbanCard {
	id: string
	boardId: string
	title: string
	description: string
	status: CardStatus
	priority: CardPriority
	/** IDs of cards this card depends on */
	deps: string[]
	assignedTo?: string
	acceptanceCriteria: string[]
	result?: CardResult
	createdAt: number
	updatedAt: number
	metadata?: Record<string, unknown>
}

/**
 * Input for creating a new card (without auto-generated fields).
 */
export interface CreateCardInput {
	title: string
	description: string
	priority?: CardPriority
	deps?: string[]
	assignedTo?: string
	acceptanceCriteria?: string[]
	metadata?: Record<string, unknown>
}

/**
 * A dependency link between two cards.
 */
export interface Dependency {
	fromCardId: string
	toCardId: string
	type: DependencyType
}

/**
 * Progress snapshot for a board.
 */
export interface BoardProgress {
	total: number
	todo: number
	inProgress: number
	inReview: number
	done: number
	blocked: number
	percentage: number
}

/**
 * Result from executing a single card.
 */
export interface CardResult {
	cardId: string
	success: boolean
	output: string
	filesModified: string[]
	errors?: string[]
	executionTimeMs: number
	subagentId?: string
}

/**
 * Verification outcome for a card.
 */
export interface VerificationResult {
	cardId: string
	passed: boolean
	criteriaResults: CriteriaResult[]
	overallMessage: string
}

/**
 * Result of verifying a single acceptance criterion.
 */
export interface CriteriaResult {
	criterion: string
	passed: boolean
	details?: string
}

/**
 * Verification summary across an entire board.
 */
export interface BoardVerificationResult {
	boardId: string
	totalCards: number
	verified: number
	failed: number
	notVerified: number
	cardResults: VerificationResult[]
}

/**
 * Verification report — serializable documentation.
 */
export interface VerificationReport {
	boardId: string
	generatedAt: number
	totalCards: number
	passed: number
	failed: number
	details: Array<{
		cardId: string
		cardTitle: string
		passed: boolean
		criteriaBreakdown: CriteriaResult[]
	}>
}

/**
 * Result of synthesizing all completed card outputs.
 */
export interface SynthesisResult {
	boardId: string
	success: boolean
	mergedOutput: string
	cardResults: CardResult[]
	executionSummary: {
		total: number
		succeeded: number
		failed: number
		totalTimeMs: number
	}
}

/**
 * An unresolved item — something mentioned in the original task
 * that isn't covered by any card's acceptance criteria.
 */
export interface UnresolvedItem {
	description: string
	sourceContext: string
	severity: "info" | "warning" | "error"
}

/**
 * Result of validating a decomposition.
 */
export interface DecompositionResult {
	valid: boolean
	orphanCards: KanbanCard[]
	cycles: Array<{ from: string; to: string }>
	missingSteps: string[]
	gaps: string[]
	warnings: string[]
}

/**
 * Event emitted when a board changes.
 */
export interface KanbanBoardEvent {
	type: "card_added" | "card_updated" | "card_removed" | "board_archived" | "board_completed"
	boardId: string
	cardId?: string
	timestamp: number
	payload?: unknown
}

/**
 * Listener for board events.
 */
export type KanbanBoardEventListener = (event: KanbanBoardEvent) => void

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a unique board ID.
 */
export function generateBoardId(): string {
	return `board-${crypto.randomUUID()}`
}

/**
 * Generate a unique card ID.
 */
export function generateCardId(): string {
	return `card-${crypto.randomUUID()}`
}

/**
 * Compute board progress from cards.
 */
export function computeBoardProgress(cards: KanbanCard[]): BoardProgress {
	const total = cards.length
	let todo = 0
	let inProgress = 0
	let inReview = 0
	let done = 0
	let blocked = 0

	for (const card of cards) {
		switch (card.status) {
			case "todo":
				todo++
				break
			case "in_progress":
				inProgress++
				break
			case "in_review":
				inReview++
				break
			case "done":
				done++
				break
			case "blocked":
				blocked++
				break
		}
	}

	const percentage = total > 0 ? Math.round((done / total) * 100) : 0

	return { total, todo, inProgress, inReview, done, blocked, percentage }
}

/**
 * Check if adding depFromId -> depToId would create a cycle.
 */
export function wouldCreateCycle(depFromId: string, depToId: string, cards: KanbanCard[]): boolean {
	// BFS from depToId following its deps — if we reach depFromId, it's a cycle
	const visited = new Set<string>()
	const queue = [depToId]

	while (queue.length > 0) {
		const current = queue.shift()!
		if (current === depFromId) {
			return true
		}
		if (visited.has(current)) {
			continue
		}
		visited.add(current)

		const card = cards.find((c) => c.id === current)
		if (card) {
			queue.push(...card.deps)
		}
	}

	return false
}

/**
 * Default priorities mapped to numeric weight for sorting.
 */
export const PRIORITY_WEIGHT: Record<CardPriority, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
}
