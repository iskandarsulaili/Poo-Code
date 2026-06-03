import { randomUUID } from "crypto"
import { MemoryEntry, MemoryQuery, MemoryTier, MemoryStoreError, WorkingContext, ActionRecord } from "./types"
import { MemoryProvider } from "./MemoryProvider"

/**
 * L1 Working Memory — current session context.
 *
 * In-memory (ephemeral) store that holds the working state for the current session.
 * Cleared when the session ends. Backed by the session's conversation state.
 */
export class WorkingMemory extends MemoryProvider {
	public readonly tier = MemoryTier.WORKING

	private workingContext: WorkingContext | null = null
	private entries: Map<string, MemoryEntry> = new Map()

	/**
	 * Initialize the working memory store.
	 */
	async initialize(): Promise<void> {
		// In-memory only; nothing to initialize
	}

	/**
	 * Capture current working context from the session.
	 */
	async captureContext(context: WorkingContext): Promise<void> {
		this.workingContext = {
			...context,
			timestamp: Date.now(),
		}
	}

	/**
	 * Get the current working context.
	 */
	async getWorkingSet(): Promise<WorkingContext> {
		if (!this.workingContext) {
			throw new MemoryStoreError("No working context captured", MemoryTier.WORKING)
		}
		return this.workingContext
	}

	/**
	 * Record an action performed in the current session.
	 */
	async recordAction(action: ActionRecord): Promise<void> {
		if (!this.workingContext) {
			this.workingContext = {
				sessionId: randomUUID(),
				currentTask: "",
				recentActions: [],
				openFiles: [],
				conversationState: "active",
				timestamp: Date.now(),
			}
		}
		this.workingContext.recentActions.push({
			...action,
			timestamp: Date.now(),
		})
		// Keep only last 50 actions
		if (this.workingContext.recentActions.length > 50) {
			this.workingContext.recentActions = this.workingContext.recentActions.slice(-50)
		}
	}

	/**
	 * Update the current task description.
	 */
	async setCurrentTask(task: string): Promise<void> {
		if (!this.workingContext) {
			this.workingContext = {
				sessionId: randomUUID(),
				currentTask: task,
				recentActions: [],
				openFiles: [],
				conversationState: "active",
				timestamp: Date.now(),
			}
		} else {
			this.workingContext.currentTask = task
		}
	}

	/**
	 * Track open files in the working set.
	 */
	async setOpenFiles(files: string[]): Promise<void> {
		if (!this.workingContext) {
			throw new MemoryStoreError("No working context; call captureContext first", MemoryTier.WORKING)
		}
		this.workingContext.openFiles = files
	}

	/**
	 * Clear the working memory for this session.
	 */
	async clearSession(): Promise<void> {
		this.workingContext = null
		this.entries.clear()
	}

	/**
	 * Store a memory entry in working memory.
	 */
	async store(entry: MemoryEntry): Promise<MemoryEntry> {
		const stored: MemoryEntry = {
			...entry,
			id: entry.id || randomUUID(),
			createdAt: entry.createdAt || Date.now(),
			lastAccessed: Date.now(),
			accessCount: 0,
		}
		this.entries.set(stored.id, stored)
		return stored
	}

	/**
	 * Query working memory entries.
	 */
	async query(query: MemoryQuery): Promise<MemoryEntry[]> {
		let results = Array.from(this.entries.values())

		if (query.tags && query.tags.length > 0) {
			results = results.filter((e) => query.tags!.some((t) => e.tags.includes(t)))
		}
		if (query.minConfidence !== undefined) {
			results = results.filter((e) => e.confidence >= query.minConfidence!)
		}
		if (query.timeRange) {
			results = results.filter((e) => e.createdAt >= query.timeRange!.from && e.createdAt <= query.timeRange!.to)
		}

		// Sort by confidence desc
		results.sort((a, b) => b.confidence - a.confidence)

		const limit = query.limit ?? 50
		results = results.slice(0, limit)

		// Update lastAccessed and accessCount
		const now = Date.now()
		for (const entry of results) {
			entry.lastAccessed = now
			entry.accessCount++
		}

		return results
	}

	/**
	 * Delete an entry from working memory.
	 */
	async delete(id: string): Promise<void> {
		this.entries.delete(id)
	}

	/**
	 * Bulk store entries.
	 */
	async bulkStore(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
		const stored: MemoryEntry[] = []
		for (const entry of entries) {
			stored.push(await this.store(entry))
		}
		return stored
	}

	/**
	 * Update an existing entry.
	 */
	async update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry> {
		const existing = this.entries.get(id)
		if (!existing) {
			throw new MemoryStoreError(`Entry ${id} not found in working memory`, MemoryTier.WORKING)
		}
		const updated: MemoryEntry = {
			...existing,
			...updates,
			id, // ID cannot change
			lastAccessed: Date.now(),
		}
		this.entries.set(id, updated)
		return updated
	}

	/**
	 * Count entries in working memory.
	 */
	async count(): Promise<number> {
		return this.entries.size
	}

	/**
	 * Shutdown (no-op for in-memory).
	 */
	async shutdown(): Promise<void> {
		this.clearSession()
	}
}
