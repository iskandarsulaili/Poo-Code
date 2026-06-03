/**
 * Cross-session search system types for F4.
 *
 * Supports full-text (FTS5), semantic (embedding), and hybrid search modes.
 */

// ─── Search Query ────────────────────────────────────────────

export type SearchMode = "fulltext" | "semantic" | "hybrid"

export interface SearchQuery {
	query: string
	mode: SearchMode
	filters?: SearchFilters
	limit?: number
	offset?: number
}

// ─── Search Filters ──────────────────────────────────────────

export interface SearchFilters {
	dateRange?: { from: number; to: number }
	mode?: string
	filePath?: string
	tags?: string[]
	sessionIds?: string[]
}

// ─── Search Result ───────────────────────────────────────────

export interface SearchResult {
	sessionId: string
	relevance: number
	snippet: string
	highlights: HighlightPosition[]
	goal?: string
	resolution?: string
	timestamp: number
	mode: SearchMode
	metadata?: Record<string, unknown>
}

// ─── Highlight ───────────────────────────────────────────────

export interface HighlightPosition {
	start: number
	end: number
}

export interface HighlightedSnippet {
	text: string
	highlights: HighlightPosition[]
}

// ─── Snippet ─────────────────────────────────────────────────

export interface Snippet {
	text: string
	startPos: number
	endPos: number
	relevance: number
}

// ─── Index Entry ─────────────────────────────────────────────

export interface IndexEntry {
	sessionId: string
	timestamp: number
	mode: string
	filePath?: string
	tags?: string[]
}

// ─── Conversation Types ──────────────────────────────────────

export interface Message {
	role: "user" | "assistant" | "system" | "tool"
	content: string
	timestamp: number
	toolName?: string
}

export interface ConversationSummary {
	keyPoints: string[]
	decisions: Decision[]
	codeChanges: CodeChange[]
	unresolvedItems: string[]
}

export interface Decision {
	description: string
	rationale: string
	timestamp: number
}

export interface CodeChange {
	filePath: string
	changeType: "added" | "modified" | "deleted" | "refactored"
	summary: string
}

export interface SessionSummary {
	sessionId: string
	goal: string
	resolution: string
	conversationSummary: ConversationSummary
	startTime: number
	endTime: number
	messageCount: number
	durationMs: number
}

// ─── Error Types ─────────────────────────────────────────────

export class SearchError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message)
		this.name = "SearchError"
	}
}

export class IndexError extends SearchError {
	constructor(message: string) {
		super(message, "INDEX_ERROR")
		this.name = "IndexError"
	}
}

export class FullTextError extends SearchError {
	constructor(message: string) {
		super(message, "FULLTEXT_ERROR")
		this.name = "FullTextError"
	}
}

export class SemanticSearchError extends SearchError {
	constructor(message: string) {
		super(message, "SEMANTIC_ERROR")
		this.name = "SemanticSearchError"
	}
}
