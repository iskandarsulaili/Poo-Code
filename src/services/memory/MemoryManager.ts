import { randomUUID } from "crypto"
import { ConsolidationRecord, MemoryEntry, MemoryQuery, MemoryTier, MemoryStoreError, TierStats } from "./types"
import { MemoryProvider } from "./MemoryProvider"
import { ConfidenceScorer } from "./ConfidenceScorer"
import { MemoryConsolidator } from "./MemoryConsolidator"
import { WorkingMemory } from "./WorkingMemory"
import { EpisodicMemory } from "./EpisodicMemory"
import { SemanticMemory } from "./SemanticMemory"
import { ProceduralMemory } from "./ProceduralMemory"

/**
 * MemoryManager — top-level orchestrator for the 4-tier memory system (F3).
 *
 * Routes memory entries to the correct tier based on type classification.
 * Coordinates storage, querying (cross-tier), consolidation, and stats.
 */
export class MemoryManager {
	private providers: Map<MemoryTier, MemoryProvider>
	private confidenceScorer: ConfidenceScorer
	private consolidator: MemoryConsolidator

	/**
	 * Default confidence threshold for cross-tier queries.
	 */
	private static readonly DEFAULT_MIN_CONFIDENCE = 0.3

	constructor() {
		this.confidenceScorer = new ConfidenceScorer()
		this.providers = new Map()
		this.consolidator = new MemoryConsolidator(this.providers, this.confidenceScorer)
	}

	/**
	 * Initialize the memory system with all 4 tiers.
	 * Registers default providers for each tier.
	 */
	async initialize(): Promise<void> {
		const working = new WorkingMemory()
		const episodic = new EpisodicMemory(this.confidenceScorer)
		const semantic = new SemanticMemory(this.confidenceScorer)
		const procedural = new ProceduralMemory(this.confidenceScorer)

		this.providers.set(MemoryTier.WORKING, working)
		this.providers.set(MemoryTier.EPISODIC, episodic)
		this.providers.set(MemoryTier.SEMANTIC, semantic)
		this.providers.set(MemoryTier.PROCEDURAL, procedural)

		const providerValues: MemoryProvider[] = []
		this.providers.forEach((p) => providerValues.push(p))
		for (const provider of providerValues) {
			await provider.initialize()
		}
	}

	/**
	 * Register a custom provider for a specific tier.
	 */
	registerProvider(tier: MemoryTier, provider: MemoryProvider): void {
		this.providers.set(tier, provider)
	}

	/**
	 * Get a provider for a specific tier.
	 */
	getProvider(tier: MemoryTier): MemoryProvider {
		const provider = this.providers.get(tier)
		if (!provider) {
			throw new MemoryStoreError(`No provider registered for tier: ${tier}`, tier)
		}
		return provider
	}

	/**
	 * Store a memory entry, routing to appropriate tier based on type analysis.
	 *
	 * Type-to-tier routing:
	 * - "working_context", "action" → WORKING (L1)
	 * - "episode", "experience" → EPISODIC (L2)
	 * - "pattern", "preference", "fact" → SEMANTIC (L3)
	 * - "procedure", "workflow" → PROCEDURAL (L4)
	 * - Other types → confidence-based routing
	 */
	async store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
		const tier = this.classifyTier(entry)
		const provider = this.getProvider(tier)

		const fullEntry: MemoryEntry = {
			...entry,
			id: randomUUID(),
			createdAt: Date.now(),
		}

		return provider.store(fullEntry)
	}

	/**
	 * Query across all tiers with scoring.
	 *
	 * Returns results from all tiers sorted by confidence.
	 * Optionally filter to specific tiers via query.tiers.
	 */
	async query(query: MemoryQuery): Promise<MemoryEntry[]> {
		const tiers = query.tiers ?? [
			MemoryTier.WORKING,
			MemoryTier.EPISODIC,
			MemoryTier.SEMANTIC,
			MemoryTier.PROCEDURAL,
		]

		const allResults: MemoryEntry[] = []

		for (const tier of tiers) {
			const provider = this.providers.get(tier)
			if (!provider) continue

			const tierResults = await provider.query({
				...query,
				tiers: [tier],
				minConfidence: query.minConfidence ?? MemoryManager.DEFAULT_MIN_CONFIDENCE,
			})

			allResults.push(...tierResults)
		}

		// Sort all results by confidence desc
		allResults.sort((a, b) => b.confidence - a.confidence)

		const limit = query.limit ?? 50
		return allResults.slice(0, limit)
	}

	/**
	 * Trigger a consolidation cycle across all tiers or a specific tier.
	 */
	async consolidate(tier?: MemoryTier): Promise<ConsolidationRecord[]> {
		const tiers = tier
			? [tier]
			: [MemoryTier.WORKING, MemoryTier.EPISODIC, MemoryTier.SEMANTIC, MemoryTier.PROCEDURAL]

		const records: ConsolidationRecord[] = []

		for (const t of tiers) {
			// Skip WORKING tier — it's ephemeral
			if (t === MemoryTier.WORKING) continue

			const record = await this.consolidator.consolidate(t)
			records.push(record)
		}

		return records
	}

	/**
	 * Get statistics per tier.
	 */
	async getTierStats(): Promise<Map<MemoryTier, TierStats>> {
		const stats = new Map<MemoryTier, TierStats>()
		const now = Date.now()

		const providerEntries: Array<[MemoryTier, MemoryProvider]> = []
		this.providers.forEach((p, t) => providerEntries.push([t, p]))

		for (const [tier, provider] of providerEntries) {
			const entries = await provider.query({
				query: "",
				minConfidence: 0,
				limit: 1000,
			})

			const count = entries.length
			const avgConfidence = count > 0 ? entries.reduce((sum, e) => sum + e.confidence, 0) / count : 0
			const lastAccess = count > 0 ? Math.max(...entries.map((e) => e.lastAccessed)) : now

			stats.set(tier, {
				count,
				avgConfidence: Math.round(avgConfidence * 1000) / 1000,
				lastAccess,
			})
		}

		return stats
	}

	/**
	 * Delete a memory entry by ID from all tiers.
	 */
	async delete(id: string): Promise<void> {
		const providerValues: MemoryProvider[] = []
		this.providers.forEach((p) => providerValues.push(p))
		for (const provider of providerValues) {
			try {
				await provider.delete(id)
			} catch {
				// Continue searching across tiers
			}
		}
	}

	/**
	 * Shutdown all providers.
	 */
	async shutdown(): Promise<void> {
		const providerValues: MemoryProvider[] = []
		this.providers.forEach((p) => providerValues.push(p))
		for (const provider of providerValues) {
			await provider.shutdown()
		}
	}

	/**
	 * Classify entry type to determine target memory tier.
	 */
	private classifyTier(entry: Omit<MemoryEntry, "id" | "createdAt">): MemoryTier {
		const type = entry.type?.toLowerCase() ?? ""

		// Explicit type-to-tier mapping
		const typeTierMap: Record<string, MemoryTier> = {
			working_context: MemoryTier.WORKING,
			action: MemoryTier.WORKING,
			session: MemoryTier.WORKING,
			episode: MemoryTier.EPISODIC,
			experience: MemoryTier.EPISODIC,
			event: MemoryTier.EPISODIC,
			interaction: MemoryTier.EPISODIC,
			pattern: MemoryTier.SEMANTIC,
			preference: MemoryTier.SEMANTIC,
			fact: MemoryTier.SEMANTIC,
			user_info: MemoryTier.SEMANTIC,
			project_rule: MemoryTier.SEMANTIC,
			procedure: MemoryTier.PROCEDURAL,
			workflow: MemoryTier.PROCEDURAL,
			recipe: MemoryTier.PROCEDURAL,
			playbook: MemoryTier.PROCEDURAL,
		}

		return typeTierMap[type] ?? MemoryTier.EPISODIC // default to episodic
	}
}
