import { randomUUID } from "crypto"
import {
	MemoryEntry,
	MemoryQuery,
	MemoryTier,
	MemoryStoreError,
	Procedure,
	ProcedureStep,
	ProcedureQuery,
} from "./types"
import { MemoryProvider } from "./MemoryProvider"
import { ConfidenceScorer } from "./ConfidenceScorer"

/**
 * L4 Procedural Memory — step-by-step procedures.
 *
 * Stores reusable procedures with preconditions, postconditions,
 * success tracking, and confidence scoring. Procedures are review-gated
 * and accumulate usage statistics to validate effectiveness.
 */
export class ProceduralMemory extends MemoryProvider {
	public readonly tier = MemoryTier.PROCEDURAL

	private entries: Map<string, MemoryEntry> = new Map()
	private procedures: Map<string, Procedure> = new Map()
	private confidenceScorer: ConfidenceScorer

	constructor(confidenceScorer?: ConfidenceScorer) {
		super()
		this.confidenceScorer = confidenceScorer ?? new ConfidenceScorer()
	}

	/**
	 * Initialize procedural memory.
	 */
	async initialize(): Promise<void> {
		// In production, would open SQLite store
	}

	/**
	 * Store a procedure with validation.
	 */
	async storeProcedure(
		procedure: Omit<Procedure, "id" | "createdAt" | "usageCount" | "successRate" | "lastUsed" | "confidence">,
	): Promise<Procedure> {
		const id = randomUUID()
		const now = Date.now()

		// Validate procedure has required fields
		if (!procedure.name || procedure.name.trim().length === 0) {
			throw new MemoryStoreError("Procedure name is required", MemoryTier.PROCEDURAL)
		}
		if (!procedure.steps || procedure.steps.length === 0) {
			throw new MemoryStoreError("Procedure must have at least one step", MemoryTier.PROCEDURAL)
		}

		const newProcedure: Procedure = {
			...procedure,
			id,
			usageCount: 0,
			successRate: 1.0,
			confidence: 0.6, // initial lower confidence, requires validation
			createdAt: now,
			lastUsed: now,
		}

		this.procedures.set(id, newProcedure)

		const memoryEntry: MemoryEntry = {
			id,
			tier: MemoryTier.PROCEDURAL,
			type: "procedure",
			content: `Procedure: ${procedure.name}\nSteps: ${procedure.steps.map((s) => s.action).join(" → ")}`,
			metadata: {
				preconditions: procedure.preconditions,
				postconditions: procedure.postconditions,
				stepCount: procedure.steps.length,
			},
			confidence: 0.6,
			sourceAuthority: "llm",
			tags: procedure.tags,
			createdAt: now,
			lastAccessed: now,
			accessCount: 0,
			baseScore: 0.6,
			tierDecayRate: this.confidenceScorer.getTierDecayRate(MemoryTier.PROCEDURAL),
			contradictoryObservations: 0,
			totalObservations: 0,
			expiresAt: null, // permanent until pruned
		}

		await this.store(memoryEntry)
		return newProcedure
	}

	/**
	 * Query procedures by applicability.
	 */
	async queryProcedures(query: ProcedureQuery): Promise<Procedure[]> {
		let results = Array.from(this.procedures.values())

		if (query.name) {
			const q = query.name.toLowerCase()
			results = results.filter(
				(p) => p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
			)
		}

		if (query.tags && query.tags.length > 0) {
			results = results.filter((p) => query.tags!.some((t) => p.tags.includes(t)))
		}

		if (query.minSuccessRate !== undefined) {
			results = results.filter((p) => p.successRate >= query.minSuccessRate!)
		}

		if (query.minConfidence !== undefined) {
			results = results.filter((p) => p.confidence >= query.minConfidence!)
		}

		// Sort by confidence desc, then usage count desc
		results.sort((a, b) => {
			const confDiff = b.confidence - a.confidence
			if (confDiff !== 0) return confDiff
			return b.usageCount - a.usageCount
		})

		const limit = query.limit ?? 20
		return results.slice(0, limit)
	}

	/**
	 * Record a usage outcome for a procedure to update success rate.
	 */
	async recordUsage(procedureId: string, success: boolean): Promise<Procedure> {
		const procedure = this.procedures.get(procedureId)
		if (!procedure) {
			throw new MemoryStoreError(`Procedure ${procedureId} not found`, MemoryTier.PROCEDURAL)
		}

		const newUsageCount = procedure.usageCount + 1
		const currentSuccesses = Math.round(procedure.successRate * procedure.usageCount)
		const newSuccesses = currentSuccesses + (success ? 1 : 0)
		const newSuccessRate = newSuccesses / newUsageCount

		const updated: Procedure = {
			...procedure,
			usageCount: newUsageCount,
			successRate: Math.round(newSuccessRate * 1000) / 1000,
			confidence: Math.min(1, procedure.confidence + (success ? 0.05 : -0.1)),
			lastUsed: Date.now(),
		}

		this.procedures.set(procedureId, updated)
		return updated
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
			tierDecayRate: entry.tierDecayRate || this.confidenceScorer.getTierDecayRate(MemoryTier.PROCEDURAL),
		}
		this.entries.set(stored.id, stored)
		return stored
	}

	/**
	 * Query procedural memory entries.
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
		this.procedures.delete(id)
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
			throw new MemoryStoreError(`Entry ${id} not found in procedural memory`, MemoryTier.PROCEDURAL)
		}
		const updated: MemoryEntry = {
			...existing,
			...updates,
			id,
			lastAccessed: Date.now(),
			tier: MemoryTier.PROCEDURAL,
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
		this.procedures.clear()
	}
}
