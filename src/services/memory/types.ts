/**
 * Core memory system types for the 4-tier memory architecture (F3).
 *
 * Tiers:
 * - WORKING (L1): Current session context, in-memory, ephemeral
 * - EPISODIC (L2): Past experiences, SQLite-backed, 30-day retention
 * - SEMANTIC (L3): User patterns/preferences, SQLite-backed, indefinite
 * - PROCEDURAL (L4): Step-by-step procedures, SQLite-backed, review-gated
 */

// ─── Memory Tiers ────────────────────────────────────────────

export enum MemoryTier {
	WORKING = "working",
	EPISODIC = "episodic",
	SEMANTIC = "semantic",
	PROCEDURAL = "procedural",
}

// ─── Source Authority ────────────────────────────────────────

export type SourceAuthority = "llm" | "user" | "execution" | "feedback"

// ─── Core Memory Entry ───────────────────────────────────────

export interface MemoryEntry {
	id: string
	tier: MemoryTier
	type: string
	content: string
	metadata: Record<string, unknown>
	confidence: number
	sourceAuthority: SourceAuthority
	tags: string[]
	createdAt: number
	lastAccessed: number
	accessCount: number
	embedding?: Float32Array
	baseScore: number
	tierDecayRate: number
	contradictoryObservations: number
	totalObservations: number
	expiresAt: number | null
}

// ─── Memory Query ────────────────────────────────────────────

export interface MemoryQuery {
	query: string
	tiers?: MemoryTier[]
	tags?: string[]
	minConfidence?: number
	limit?: number
	timeRange?: { from: number; to: number }
}

// ─── Tier Stats ──────────────────────────────────────────────

export interface TierStats {
	count: number
	avgConfidence: number
	lastAccess: number
}

// ─── Consolidation ───────────────────────────────────────────

export interface ConsolidationRecord {
	tier: MemoryTier
	entriesProcessed: number
	promoted: number
	pruned: number
	merged: number
	timestamp: number
}

// ─── Working Memory (L1) ─────────────────────────────────────

export interface WorkingContext {
	sessionId: string
	currentTask: string
	recentActions: ActionRecord[]
	openFiles: string[]
	activeTool?: string
	conversationState: string
	timestamp: number
}

export interface ActionRecord {
	toolName: string
	args: Record<string, unknown>
	result: string
	timestamp: number
}

// ─── Episodic Memory (L2) ────────────────────────────────────

export interface EpisodeEntry {
	id: string
	problem: string
	approach: string
	solution: string
	filesModified: string[]
	result: "success" | "failure" | "partial"
	tags: string[]
	timestamp: number
	confidence: number
}

export interface EpisodeQuery {
	problem?: string
	tags?: string[]
	result?: "success" | "failure" | "partial"
	limit?: number
	minConfidence?: number
}

// ─── Semantic Memory (L3) ────────────────────────────────────

export interface SemanticPattern {
	id: string
	description: string
	evidenceCount: number
	confidence: number
	lastReinforced: number
	category: "preference" | "fact" | "learned_skill" | "user_info" | "project_rule"
	metadata: Record<string, unknown>
}

export interface PatternQuery {
	category?: SemanticPattern["category"]
	description?: string
	minConfidence?: number
	minEvidence?: number
	limit?: number
}

// ─── Procedural Memory (L4) ──────────────────────────────────

export interface Procedure {
	id: string
	name: string
	steps: ProcedureStep[]
	preconditions: string[]
	postconditions: string[]
	successRate: number
	usageCount: number
	confidence: number
	tags: string[]
	createdAt: number
	lastUsed: number
}

export interface ProcedureStep {
	order: number
	action: string
	tool?: string
	expectedOutcome: string
}

export interface ProcedureQuery {
	name?: string
	tags?: string[]
	minSuccessRate?: number
	minConfidence?: number
	limit?: number
}

// ─── Confidence Parameters ───────────────────────────────────

export interface ConfidenceParams {
	baseScore: number
	sourceAuthority: SourceAuthority
	consistency: number
	ageMs: number
	tierDecayRate: number
}

// ─── Memory Error Types ──────────────────────────────────────

export class MemoryError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly tier?: MemoryTier,
	) {
		super(message)
		this.name = "MemoryError"
	}
}

export class MemoryStoreError extends MemoryError {
	constructor(message: string, tier?: MemoryTier) {
		super(message, "STORE_ERROR", tier)
		this.name = "MemoryStoreError"
	}
}

export class MemoryQueryError extends MemoryError {
	constructor(message: string, tier?: MemoryTier) {
		super(message, "QUERY_ERROR", tier)
		this.name = "MemoryQueryError"
	}
}
