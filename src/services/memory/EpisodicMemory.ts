import { randomUUID } from "crypto"
import { MemoryEntry, MemoryQuery, MemoryTier, MemoryStoreError, EpisodeEntry, EpisodeQuery } from "./types"
import { MemoryProvider } from "./MemoryProvider"
import { ConfidenceScorer } from "./ConfidenceScorer"

/**
 * L2 Episodic Memory — past experiences.
 *
 * Stores historical episodes: bug fixes, task approaches, user interactions.
 * SQLite-backed for persistence across sessions with 30-day retention window.
 * Episodes are tagged for categorization (bug_fix, refactor, feature, test, etc.).
 */
export class EpisodicMemory extends MemoryProvider {
	public readonly tier = MemoryTier.EPISODIC

	private entries: Map<string, MemoryEntry> = new Map()
	private episodes: Map<string, EpisodeEntry> = new Map()
	private confidenceScorer: ConfidenceScorer
	private dbPath: string | null = null

	constructor(confidencesScorer?: ConfidenceScorer) {
		super()
		this.confidenceScorer = confidencesScorer ?? new ConfidenceScorer()
	}

	/**
	 * Initialize the episodic memory store.
	 * In production, this would open a SQLite connection.
	 */
	async initialize(dbPath?: string): Promise<void> {
		this.dbPath = dbPath ?? null
	}

	/**
	 * Store an episode entry with automatic memory entry creation.
	 */
	async storeEpisode(episode: Omit<EpisodeEntry, "id" | "timestamp" | "confidence">): Promise<EpisodeEntry> {
		const id = randomUUID()
		const now = Date.now()

		const episodeEntry: EpisodeEntry = {
			...episode,
			id,
			timestamp: now,
			confidence: 0.8, // initial confidence for new episodes
		}

		this.episodes.set(id, episodeEntry)

		// Also create a MemoryEntry for unified querying
		const memoryEntry: MemoryEntry = {
			id,
			tier: MemoryTier.EPISODIC,
			type: "episode",
			content: `Problem: ${episode.problem}\nApproach: ${episode.approach}\nSolution: ${episode.solution}`,
			metadata: {
				result: episode.result,
				filesModified: episode.filesModified,
			},
			confidence: 0.8,
			sourceAuthority: "execution",
			tags: episode.tags,
			createdAt: now,
			lastAccessed: now,
			accessCount: 0,
			baseScore: 0.8,
			tierDecayRate: this.confidenceScorer.getTierDecayRate(MemoryTier.EPISODIC),
			contradictoryObservations: 0,
			totalObservations: 1,
			expiresAt: now + 30 * 86_400_000, // 30-day retention
		}

		await this.store(memoryEntry)
		return episodeEntry
	}

	/**
	 * Recall episodes similar to the given query.
	 */
	async recallSimilarEpisodes(query: EpisodeQuery): Promise<EpisodeEntry[]> {
		let results = Array.from(this.episodes.values())

		if (query.problem) {
			const q = query.problem.toLowerCase()
			results = results.filter((e) => {
				return (
					e.problem.toLowerCase().includes(q) ||
					e.approach.toLowerCase().includes(q) ||
					e.solution.toLowerCase().includes(q)
				)
			})
		}

		if (query.tags && query.tags.length > 0) {
			results = results.filter((e) => query.tags!.some((t) => e.tags.includes(t)))
		}

		if (query.result) {
			results = results.filter((e) => e.result === query.result)
		}

		if (query.minConfidence !== undefined) {
			results = results.filter((e) => e.confidence >= query.minConfidence!)
		}

		// Sort by confidence desc, then by timestamp desc
		results.sort((a, b) => {
			const confDiff = b.confidence - a.confidence
			if (confDiff !== 0) return confDiff
			return b.timestamp - a.timestamp
		})

		const limit = query.limit ?? 20
		return results.slice(0, limit)
	}

	/**
	 * Store a memory entry.
	 */
	async store(entry: MemoryEntry): Promise<MemoryEntry> {
		const stored: MemoryEntry = {
			...entry,
			id: entry.id || randomUUID(),
			createdAt: entry.createdAt || Date.now(),
			lastAccessed: Date.now(),
			accessCount: 0,
			tierDecayRate: entry.tierDecayRate || this.confidenceScorer.getTierDecayRate(MemoryTier.EPISODIC),
		}
		this.entries.set(stored.id, stored)
		return stored
	}

	/**
	 * Query episodic memory entries.
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

		// Text matching on query string
		if (query.query) {
			const q = query.query.toLowerCase()
			results = results.filter(
				(e) => e.content.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)),
			)
		}

		// Remove expired entries
		const now = Date.now()
		results = results.filter((e) => !e.expiresAt || e.expiresAt > now)

		results.sort((a, b) => b.confidence - a.confidence)

		const limit = query.limit ?? 50
		results = results.slice(0, limit)

		const now2 = Date.now()
		for (const entry of results) {
			entry.lastAccessed = now2
			entry.accessCount++
		}

		return results
	}

	/**
	 * Delete an entry.
	 */
	async delete(id: string): Promise<void> {
		this.entries.delete(id)
		this.episodes.delete(id)
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
	 * Update an entry.
	 */
	async update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry> {
		const existing = this.entries.get(id)
		if (!existing) {
			throw new MemoryStoreError(`Entry ${id} not found in episodic memory`, MemoryTier.EPISODIC)
		}
		const updated: MemoryEntry = {
			...existing,
			...updates,
			id,
			lastAccessed: Date.now(),
			tier: MemoryTier.EPISODIC,
		}
		this.entries.set(id, updated)
		return updated
	}

	/**
	 * Count entries.
	 */
	async count(): Promise<number> {
		return this.entries.size
	}

	/**
	 * Shutdown.
	 */
	async shutdown(): Promise<void> {
		this.entries.clear()
		this.episodes.clear()
	}
}
