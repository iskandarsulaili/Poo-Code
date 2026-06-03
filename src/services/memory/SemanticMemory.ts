import { randomUUID } from "crypto"
import { MemoryEntry, MemoryQuery, MemoryTier, MemoryStoreError, SemanticPattern, PatternQuery } from "./types"
import { MemoryProvider } from "./MemoryProvider"
import { ConfidenceScorer } from "./ConfidenceScorer"

/**
 * L3 Semantic Memory — user patterns and preferences.
 *
 * Stores learned patterns about user behavior, project conventions,
 * preferences, and factual knowledge. Persisted for indefinite retention.
 * Patterns accumulate evidence count and confidence over time.
 */
export class SemanticMemory extends MemoryProvider {
	public readonly tier = MemoryTier.SEMANTIC

	private entries: Map<string, MemoryEntry> = new Map()
	private patterns: Map<string, SemanticPattern> = new Map()
	private confidenceScorer: ConfidenceScorer

	constructor(confidenceScorer?: ConfidenceScorer) {
		super()
		this.confidenceScorer = confidenceScorer ?? new ConfidenceScorer()
	}

	/**
	 * Initialize the semantic memory store.
	 */
	async initialize(): Promise<void> {
		// In production, would open SQLite/vector DB
	}

	/**
	 * Store a semantic pattern, deduplicating by description similarity.
	 */
	async storePattern(pattern: Omit<SemanticPattern, "id">): Promise<SemanticPattern> {
		const id = randomUUID()

		// Check for existing similar pattern (simple description match)
		const existing = this.findSimilarPattern(pattern.description)
		if (existing) {
			return this.reinforcePattern(existing.id, pattern)
		}

		const newPattern: SemanticPattern = {
			...pattern,
			id,
		}

		this.patterns.set(id, newPattern)

		const now = Date.now()
		const memoryEntry: MemoryEntry = {
			id,
			tier: MemoryTier.SEMANTIC,
			type: "semantic_pattern",
			content: pattern.description,
			metadata: {
				category: pattern.category,
				evidenceCount: pattern.evidenceCount,
			},
			confidence: pattern.confidence,
			sourceAuthority: "llm",
			tags: [pattern.category],
			createdAt: now,
			lastAccessed: now,
			accessCount: 0,
			baseScore: pattern.confidence,
			tierDecayRate: this.confidenceScorer.getTierDecayRate(MemoryTier.SEMANTIC),
			contradictoryObservations: 0,
			totalObservations: pattern.evidenceCount,
			expiresAt: null, // indefinite
		}

		await this.store(memoryEntry)
		return newPattern
	}

	/**
	 * Query patterns by relevance.
	 */
	async queryPatterns(query: PatternQuery): Promise<SemanticPattern[]> {
		let results = Array.from(this.patterns.values())

		if (query.category) {
			results = results.filter((p) => p.category === query.category)
		}

		if (query.description) {
			const q = query.description.toLowerCase()
			results = results.filter((p) => p.description.toLowerCase().includes(q))
		}

		if (query.minConfidence !== undefined) {
			results = results.filter((p) => p.confidence >= query.minConfidence!)
		}

		if (query.minEvidence !== undefined) {
			results = results.filter((p) => p.evidenceCount >= query.minEvidence!)
		}

		// Sort by confidence desc, then evidence count desc
		results.sort((a, b) => {
			const confDiff = b.confidence - a.confidence
			if (confDiff !== 0) return confDiff
			return b.evidenceCount - a.evidenceCount
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
			tierDecayRate: entry.tierDecayRate || this.confidenceScorer.getTierDecayRate(MemoryTier.SEMANTIC),
		}
		this.entries.set(stored.id, stored)
		return stored
	}

	/**
	 * Query semantic memory entries.
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
		if (query.query) {
			const q = query.query.toLowerCase()
			results = results.filter(
				(e) => e.content.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)),
			)
		}

		results.sort((a, b) => b.confidence - a.confidence)

		const limit = query.limit ?? 50
		results = results.slice(0, limit)

		const now = Date.now()
		for (const entry of results) {
			entry.lastAccessed = now
			entry.accessCount++
		}

		return results
	}

	/**
	 * Delete an entry.
	 */
	async delete(id: string): Promise<void> {
		this.entries.delete(id)
		this.patterns.delete(id)
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
			throw new MemoryStoreError(`Entry ${id} not found in semantic memory`, MemoryTier.SEMANTIC)
		}
		const updated: MemoryEntry = {
			...existing,
			...updates,
			id,
			lastAccessed: Date.now(),
			tier: MemoryTier.SEMANTIC,
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
		this.patterns.clear()
	}

	/**
	 * Find a pattern with a similar description.
	 */
	private findSimilarPattern(description: string): SemanticPattern | undefined {
		const q = description.toLowerCase()
		for (const pattern of this.patterns.values()) {
			const similarity = this.calculateStringSimilarity(q, pattern.description.toLowerCase())
			if (similarity > 0.8) {
				return pattern
			}
		}
		return undefined
	}

	/**
	 * Reinforce an existing pattern with new evidence.
	 */
	private reinforcePattern(existingId: string, newData: Omit<SemanticPattern, "id">): SemanticPattern {
		const existing = this.patterns.get(existingId)!
		const updated: SemanticPattern = {
			...existing,
			evidenceCount: existing.evidenceCount + newData.evidenceCount,
			confidence: Math.min(1, existing.confidence + 0.05), // small boost
			lastReinforced: Date.now(),
		}
		this.patterns.set(existingId, updated)
		return updated
	}

	/**
	 * Simple Dice coefficient string similarity for dedup.
	 */
	private calculateStringSimilarity(a: string, b: string): number {
		if (a === b) return 1.0
		if (a.length < 2 || b.length < 2) return 0.0

		const bigrams = new Set<string>()
		for (let i = 0; i < a.length - 1; i++) {
			bigrams.add(a.substring(i, i + 2))
		}

		let intersection = 0
		for (let i = 0; i < b.length - 1; i++) {
			const bigram = b.substring(i, i + 2)
			if (bigrams.has(bigram)) {
				intersection++
			}
		}

		return (2.0 * intersection) / (a.length - 1 + b.length - 1)
	}
}
