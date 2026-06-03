import { ConsolidationRecord, MemoryEntry, MemoryQuery, MemoryTier, MemoryStoreError } from "./types"
import { MemoryProvider } from "./MemoryProvider"
import { ConfidenceScorer } from "./ConfidenceScorer"

/**
 * Batch consolidation engine for the 4-tier memory system.
 *
 * Performs consolidation cycles per tier:
 * 1. Decay scores based on age
 * 2. Promote high-confidence entries to higher tiers
 * 3. Prune low-confidence entries below threshold
 * 4. Merge duplicate entries, increasing confidence
 */
export class MemoryConsolidator {
	private providers: Map<MemoryTier, MemoryProvider>
	private confidenceScorer: ConfidenceScorer

	/**
	 * Confidence threshold for promotion to next tier.
	 */
	private static readonly PROMOTION_THRESHOLD = 0.85

	/**
	 * Confidence threshold below which entries are pruned.
	 */
	private static readonly PRUNE_THRESHOLD = 0.15

	constructor(providers: Map<MemoryTier, MemoryProvider>, confidenceScorer: ConfidenceScorer) {
		this.providers = providers
		this.confidenceScorer = confidenceScorer
	}

	/**
	 * Run a full consolidation cycle for a specific tier.
	 */
	async consolidate(tier: MemoryTier): Promise<ConsolidationRecord> {
		const provider = this.providers.get(tier)
		if (!provider) {
			throw new MemoryStoreError(`No provider registered for tier: ${tier}`, tier)
		}

		const allEntries = await provider.query({
			query: "",
			minConfidence: 0,
			limit: 1000,
		})

		const record: ConsolidationRecord = {
			tier,
			entriesProcessed: allEntries.length,
			promoted: 0,
			pruned: 0,
			merged: 0,
			timestamp: Date.now(),
		}

		// Step 1: Decay scores
		const decayed = this.confidenceScorer.decayScores(allEntries, tier)
		for (const entry of decayed) {
			await provider.update(entry.id, { confidence: entry.confidence })
		}

		// Step 2: Prune low-confidence entries
		const prunedEntries = this.pruneLowConfidence(decayed, MemoryConsolidator.PRUNE_THRESHOLD)
		for (const entry of prunedEntries) {
			await provider.delete(entry.id)
		}
		record.pruned = prunedEntries.length

		// Step 3: Promote high-confidence entries to next tier
		const promotable = decayed.filter(
			(e) => e.confidence >= MemoryConsolidator.PROMOTION_THRESHOLD && !prunedEntries.some((p) => p.id === e.id),
		)

		if (promotable.length > 0 && tier !== MemoryTier.PROCEDURAL) {
			const nextTier = this.getNextTier(tier)
			if (nextTier) {
				const promoted = await this.promoteToNextTier(promotable, nextTier)
				record.promoted = promoted.length
				// Remove original entries that were promoted
				for (const entry of promoted) {
					await provider.delete(entry.id)
				}
			}
		}

		// Step 4: Merge duplicate entries remaining in this tier
		const remaining = decayed.filter(
			(e) =>
				!prunedEntries.some((p) => p.id === e.id) &&
				!promotable.some((p) => p.id === e.id) &&
				tier !== MemoryTier.PROCEDURAL, // Don't auto-merge procedures
		)

		if (remaining.length > 0) {
			const merged = await this.mergeDuplicateEntries(remaining, provider)
			record.merged = merged
		}

		return record
	}

	/**
	 * Get the next higher tier for promotion.
	 */
	private getNextTier(current: MemoryTier): MemoryTier | null {
		const tierOrder = [MemoryTier.WORKING, MemoryTier.EPISODIC, MemoryTier.SEMANTIC, MemoryTier.PROCEDURAL]
		const idx = tierOrder.indexOf(current)
		if (idx < tierOrder.length - 1) {
			return tierOrder[idx + 1]
		}
		return null
	}

	/**
	 * Promote entries from a lower tier to a higher tier.
	 */
	async promoteToNextTier(entries: MemoryEntry[], targetTier: MemoryTier): Promise<MemoryEntry[]> {
		const targetProvider = this.providers.get(targetTier)
		if (!targetProvider) {
			throw new MemoryStoreError(`No provider for target tier: ${targetTier}`, targetTier)
		}

		const promoted: MemoryEntry[] = []
		for (const entry of entries) {
			const promotedEntry: MemoryEntry = {
				...entry,
				tier: targetTier,
				confidence: Math.min(1, entry.confidence + 0.1), // confidence boost on promotion
				tierDecayRate: this.confidenceScorer.getTierDecayRate(targetTier),
				lastAccessed: Date.now(),
				metadata: {
					...entry.metadata,
					promotedFrom: entry.tier,
					promotedAt: Date.now(),
				},
			}
			const stored = await targetProvider.store(promotedEntry)
			promoted.push(stored)
		}

		return promoted
	}

	/**
	 * Prune entries with confidence below the threshold.
	 */
	pruneLowConfidence(entries: MemoryEntry[], threshold: number): MemoryEntry[] {
		return entries.filter((e) => {
			const decayedConfidence = this.confidenceScorer.updateConfidence(e, false)
			return decayedConfidence < threshold
		})
	}

	/**
	 * Merge duplicate entries by content similarity.
	 * Merged entries have their confidence and evidence combined.
	 */
	async mergeDuplicateEntries(entries: MemoryEntry[], provider: MemoryProvider): Promise<number> {
		if (entries.length < 2) return 0

		const merged = new Set<string>()
		let mergeCount = 0

		for (let i = 0; i < entries.length; i++) {
			if (merged.has(entries[i].id)) continue

			const duplicates: MemoryEntry[] = [entries[i]]

			for (let j = i + 1; j < entries.length; j++) {
				if (merged.has(entries[j].id)) continue

				// Check content similarity
				const similarity = this.calculateSimilarity(entries[i].content, entries[j].content)

				if (similarity > 0.8) {
					duplicates.push(entries[j])
					merged.add(entries[j].id)
				}
			}

			if (duplicates.length > 1) {
				// Merge into the first entry
				const primary = duplicates[0]
				const combinedConfidence = Math.min(
					1,
					duplicates.reduce((sum, d) => sum + d.confidence, 0) / duplicates.length + 0.05,
				)

				const mergedTags: string[] = []
				const tagSet = new Set(duplicates.flatMap((d) => d.tags))
				tagSet.forEach((t) => mergedTags.push(t))

				await provider.update(primary.id, {
					confidence: Math.round(combinedConfidence * 1000) / 1000,
					accessCount: duplicates.reduce((sum, d) => sum + d.accessCount, 0),
					tags: mergedTags,
					totalObservations: duplicates.reduce((sum, d) => sum + d.totalObservations, 0),
				})

				// Delete duplicates
				for (let k = 1; k < duplicates.length; k++) {
					await provider.delete(duplicates[k].id)
				}

				mergeCount += duplicates.length - 1
			}
		}

		return mergeCount
	}

	/**
	 * Calculate content similarity using Dice coefficient on word bigrams.
	 */
	private calculateSimilarity(a: string, b: string): number {
		if (a === b) return 1.0

		// Tokenize into words
		const wordsA = a.toLowerCase().split(/\W+/).filter(Boolean)
		const wordsB = b.toLowerCase().split(/\W+/).filter(Boolean)

		if (wordsA.length < 2 || wordsB.length < 2) return 0.0

		// Use 2-word shingles
		const shingles = new Set<string>()
		for (let i = 0; i < wordsA.length - 1; i++) {
			shingles.add(`${wordsA[i]} ${wordsA[i + 1]}`)
		}

		let intersection = 0
		for (let i = 0; i < wordsB.length - 1; i++) {
			const shingle = `${wordsB[i]} ${wordsB[i + 1]}`
			if (shingles.has(shingle)) {
				intersection++
			}
		}

		return (2.0 * intersection) / (wordsA.length - 1 + wordsB.length - 1)
	}
}
