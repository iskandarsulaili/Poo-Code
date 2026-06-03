import { MemoryEntry, MemoryQuery, MemoryTier } from "./types"

/**
 * Abstract provider interface for memory storage backends.
 *
 * Implementations can be in-memory (WorkingMemory), SQLite (Episodic/Semantic/Procedural),
 * or external providers (vector DB, knowledge graph, etc.).
 */
export abstract class MemoryProvider {
	/**
	 * The tier this provider services.
	 */
	public abstract readonly tier: MemoryTier

	/**
	 * Initialize the provider (open connections, create tables, etc.).
	 */
	abstract initialize(): Promise<void>

	/**
	 * Store a single memory entry.
	 */
	abstract store(entry: MemoryEntry): Promise<MemoryEntry>

	/**
	 * Query memory entries matching the given query.
	 */
	abstract query(query: MemoryQuery): Promise<MemoryEntry[]>

	/**
	 * Delete a memory entry by ID.
	 */
	abstract delete(id: string): Promise<void>

	/**
	 * Store multiple entries in a single batch operation.
	 */
	abstract bulkStore(entries: MemoryEntry[]): Promise<MemoryEntry[]>

	/**
	 * Update an existing memory entry (partial update).
	 */
	abstract update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry>

	/**
	 * Count entries matching an optional filter.
	 */
	abstract count(tier?: MemoryTier): Promise<number>

	/**
	 * Shutdown the provider (close connections, flush buffers, etc.).
	 */
	abstract shutdown(): Promise<void>
}
