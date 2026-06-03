import { ConfidenceParams, MemoryEntry, MemoryTier, SourceAuthority } from "./types"

/**
 * Confidence scoring engine for the 4-tier memory system.
 *
 * Formula: confidence = baseScore × recencyFactor(λ, ageMs) × consistency × sourceAuthorityValue
 *
 * Decay rates per tier:
 * - WORKING: N/A (ephemeral)
 * - EPISODIC: λ = 0.1 (30-day half-life ~ 7 days)
 * - SEMANTIC: λ = 0.05 (30-day half-life ~ 14 days)
 * - PROCEDURAL: λ = 0.01 (30-day half-life ~ 69 days)
 */
export class ConfidenceScorer {
	/**
	 * Default decay rates per memory tier.
	 */
	private static readonly TIER_DECAY_RATES: Record<MemoryTier, number> = {
		[MemoryTier.WORKING]: 1.0,
		[MemoryTier.EPISODIC]: 0.1,
		[MemoryTier.SEMANTIC]: 0.05,
		[MemoryTier.PROCEDURAL]: 0.01,
	}

	/**
	 * Authority weights used in confidence calculation.
	 */
	private static readonly AUTHORITY_WEIGHTS: Record<SourceAuthority, number> = {
		llm: 0.7,
		user: 0.9,
		execution: 1.0,
		feedback: 0.9,
	}

	/**
	 * Get the decay rate for a specific tier.
	 */
	getTierDecayRate(tier: MemoryTier): number {
		return ConfidenceScorer.TIER_DECAY_RATES[tier]
	}

	/**
	 * Calculate recency factor using exponential decay: e^(-λ × ageMs)
	 *
	 * @param lambda - Decay rate constant (per tier)
	 * @param ageMs - Age of the entry in milliseconds
	 * @returns Decay multiplier between 0 and 1
	 */
	recencyFactor(lambda: number, ageMs: number): number {
		const daysSinceAccess = ageMs / 86_400_000
		return Math.exp(-lambda * daysSinceAccess)
	}

	/**
	 * Calculate a full confidence score for a memory entry.
	 *
	 * Formula: baseScore × recencyFactor × consistency × sourceAuthority
	 */
	calculateScore(params: ConfidenceParams): number {
		const recency = this.recencyFactor(params.tierDecayRate, params.ageMs)
		const authority = ConfidenceScorer.AUTHORITY_WEIGHTS[params.sourceAuthority]
		const consistency = Math.max(0.3, Math.min(1.0, params.consistency))

		const score = params.baseScore * recency * consistency * authority

		// Clamp to [0, 1]
		return Math.max(0, Math.min(1, score))
	}

	/**
	 * Update confidence for an entry when reinforced or decayed.
	 *
	 * @param entry - The memory entry to update
	 * @param reinforcement - true if reinforced, false if decay
	 * @returns New confidence score
	 */
	updateConfidence(entry: MemoryEntry, reinforcement: boolean): number {
		const ageMs = Date.now() - entry.createdAt

		if (reinforcement) {
			// Reinforcement: boost toward 1.0
			const boost = (1 - entry.confidence) * 0.3
			const newScore = Math.min(1, entry.confidence + boost)
			return Math.round(newScore * 1000) / 1000
		}

		// Decay: apply recency factor
		const recency = this.recencyFactor(entry.tierDecayRate, ageMs)
		const decayed = entry.baseScore * recency
		return Math.max(0, Math.round(decayed * 1000) / 1000)
	}

	/**
	 * Batch decay scores for all entries in a tier.
	 * Used during consolidation cycles.
	 */
	decayScores(entries: MemoryEntry[], tier: MemoryTier): MemoryEntry[] {
		const lambda = ConfidenceScorer.TIER_DECAY_RATES[tier]
		const now = Date.now()

		return entries.map((entry) => {
			const ageMs = now - entry.lastAccessed
			const recency = this.recencyFactor(lambda, ageMs)
			const decayed = entry.baseScore * recency

			return {
				...entry,
				confidence: Math.max(0, Math.round(decayed * 1000) / 1000),
				lastAccessed: now,
			}
		})
	}

	/**
	 * Calculate consistency multiplier from contradictory observations.
	 */
	calculateConsistency(contradictory: number, total: number): number {
		if (total === 0) return 1.0
		return Math.max(0.3, 1.0 - 0.5 * (contradictory / total))
	}
}
