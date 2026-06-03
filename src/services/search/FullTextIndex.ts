import { randomUUID } from "crypto"
import { FullTextError, IndexEntry, SearchFilters, SearchQuery, SearchResult, SearchMode } from "./types"

/**
 * FullTextIndex — FTS5-powered full text search index.
 *
 * Uses better-sqlite3 with FTS5 extension for:
 * - Porter stemmer + unicode61 tokenizer (English)
 * - Trigram tokenizer (CJK / fuzzy matching)
 *
 * Falls back to in-memory Map-based index when better-sqlite3 is unavailable.
 */
export class FullTextIndex {
	private db: import("better-sqlite3").Database | null = null
	private memoryIndex: Map<string, { content: string; metadata: IndexEntry }> = new Map()
	private initialized = false
	private dbPath: string

	constructor(dbPath?: string) {
		this.dbPath = dbPath ?? ":memory:"
	}

	/**
	 * Initialize the FTS5 index. Creates virtual tables if using SQLite.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return

		try {
			const Database = await this.loadBetterSqlite3()
			this.db = new Database(this.dbPath)
			this.db.pragma("journal_mode = WAL")

			// Primary FTS5 table with porter+unicode61 tokenizer
			this.db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
					content,
					session_id UNINDEXED,
					timestamp UNINDEXED,
					mode UNINDEXED,
					file_path UNINDEXED,
					tokenize='porter unicode61'
				)
			`)

			// Trigram FTS5 table for CJK / fuzzy matching
			this.db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts_trigram USING fts5(
					content,
					session_id UNINDEXED,
					tokenize='trigram'
				)
			`)

			this.initialized = true
		} catch {
			// Fallback to in-memory index
			this.initialized = true
		}
	}

	/**
	 * Index text content with associated metadata.
	 */
	async index(text: string, metadata: IndexEntry): Promise<void> {
		if (this.db) {
			try {
				const stmt = this.db.prepare(`
					INSERT INTO sessions_fts (content, session_id, timestamp, mode, file_path)
					VALUES (?, ?, ?, ?, ?)
				`)
				stmt.run(text, metadata.sessionId, metadata.timestamp, metadata.mode, metadata.filePath ?? "")

				const trigramStmt = this.db.prepare(`
					INSERT INTO sessions_fts_trigram (content, session_id)
					VALUES (?, ?)
				`)
				trigramStmt.run(text, metadata.sessionId)
			} catch (err) {
				throw new FullTextError(`Failed to index text: ${(err as Error).message}`)
			}
		} else {
			// Fallback: in-memory index
			const id = randomUUID()
			this.memoryIndex.set(id, { content: text, metadata })
		}
	}

	/**
	 * Search the FTS index with BM25 relevance scoring.
	 */
	async search(query: SearchQuery): Promise<SearchResult[]> {
		const limit = query.limit ?? 50
		const offset = query.offset ?? 0

		if (this.db) {
			return this.searchSqlite(query, limit, offset)
		}

		return this.searchMemory(query, limit, offset)
	}

	/**
	 * Remove a document from the index by session ID.
	 */
	async remove(sessionId: string): Promise<void> {
		if (this.db) {
			try {
				this.db.prepare("DELETE FROM sessions_fts WHERE session_id = ?").run(sessionId)
				this.db.prepare("DELETE FROM sessions_fts_trigram WHERE session_id = ?").run(sessionId)
			} catch (err) {
				throw new FullTextError(`Failed to remove session ${sessionId}: ${(err as Error).message}`)
			}
		} else {
			for (const [id, entry] of this.memoryIndex.entries()) {
				if (entry.metadata.sessionId === sessionId) {
					this.memoryIndex.delete(id)
				}
			}
		}
	}

	/**
	 * Search via SQLite FTS5.
	 */
	private searchSqlite(query: SearchQuery, limit: number, offset: number): SearchResult[] {
		if (!this.db) return []

		try {
			// Try main FTS5 table first (porter+unicode61)
			let results: SearchResult[] = []

			const mainStmt = this.db.prepare(`
				SELECT
					session_id,
					rank AS relevance,
					snippet(sessions_fts, 1, '<mark>', '</mark>', '...', 64) AS snippet,
					timestamp,
					mode,
					file_path
				FROM sessions_fts
				WHERE sessions_fts MATCH ?
				ORDER BY rank
				LIMIT ? OFFSET ?
			`)

			const rows = mainStmt.all(query.query, limit, offset) as Array<{
				session_id: string
				relevance: number
				snippet: string
				timestamp: number
				mode: string
				file_path: string | null
			}>

			results = rows.map((row) => ({
				sessionId: row.session_id,
				relevance: this.normalizeBm25Score(row.relevance),
				snippet: row.snippet,
				highlights: [],
				timestamp: row.timestamp,
				mode: "fulltext" as SearchMode,
				metadata: { filePath: row.file_path },
			}))

			// If no results, try trigram index for fuzzy/CJK matching
			if (results.length === 0) {
				const trigramStmt = this.db.prepare(`
					SELECT
						session_id,
						rank AS relevance,
						snippet(sessions_fts_trigram, 1, '<mark>', '</mark>', '...', 64) AS snippet
					FROM sessions_fts_trigram
					WHERE sessions_fts_trigram MATCH ?
					ORDER BY rank
					LIMIT ? OFFSET ?
				`)

				const trigramRows = trigramStmt.all(query.query, limit, offset) as Array<{
					session_id: string
					relevance: number
					snippet: string
				}>

				results = trigramRows.map((row) => ({
					sessionId: row.session_id,
					relevance: this.normalizeBm25Score(row.relevance),
					snippet: row.snippet,
					highlights: [],
					timestamp: 0,
					mode: "fulltext" as SearchMode,
				}))
			}

			// Apply filters if present
			if (query.filters) {
				results = this.applyFilters(results, query.filters)
			}

			return results
		} catch (err) {
			throw new FullTextError(`Search failed: ${(err as Error).message}`)
		}
	}

	/**
	 * Search the in-memory fallback index.
	 */
	private searchMemory(query: SearchQuery, limit: number, offset: number): SearchResult[] {
		const q = query.query.toLowerCase()
		const results: SearchResult[] = []

		for (const [, entry] of this.memoryIndex.entries()) {
			const content = entry.content.toLowerCase()
			const idx = content.indexOf(q)
			if (idx === -1) continue

			const snippetStart = Math.max(0, idx - 64)
			const snippetEnd = Math.min(content.length, idx + q.length + 64)
			const snippet = content.slice(snippetStart, snippetEnd)

			results.push({
				sessionId: entry.metadata.sessionId,
				relevance: 1.0,
				snippet,
				highlights: [
					{
						start: idx - snippetStart,
						end: idx - snippetStart + q.length,
					},
				],
				timestamp: entry.metadata.timestamp,
				mode: "fulltext" as SearchMode,
				metadata: { filePath: entry.metadata.filePath },
			})
		}

		// Apply filters
		const filtered = query.filters ? this.applyFilters(results, query.filters) : results

		return filtered.slice(offset, offset + limit)
	}

	/**
	 * Normalize BM25 rank (negative = more relevant) to [0, 1].
	 */
	private normalizeBm25Score(rank: number): number {
		return Math.max(0, Math.min(1, 1 / (1 + Math.abs(rank))))
	}

	/**
	 * Apply search filters to results.
	 */
	private applyFilters(results: SearchResult[], filters: SearchFilters): SearchResult[] {
		return results.filter((r) => {
			if (filters.dateRange) {
				if (r.timestamp < filters.dateRange.from || r.timestamp > filters.dateRange.to) {
					return false
				}
			}
			if (filters.mode && r.mode !== filters.mode) {
				return false
			}
			if (filters.filePath) {
				const filePath = (r.metadata?.filePath as string) ?? ""
				if (!filePath.includes(filters.filePath)) {
					return false
				}
			}
			if (filters.sessionIds && !filters.sessionIds.includes(r.sessionId)) {
				return false
			}
			return true
		})
	}

	/**
	 * Count total indexed documents.
	 */
	async count(): Promise<number> {
		if (this.db) {
			const row = this.db.prepare("SELECT COUNT(*) AS count FROM sessions_fts").get() as { count: number }
			return row.count
		}
		return this.memoryIndex.size
	}

	/**
	 * Shutdown and close DB connection.
	 */
	async shutdown(): Promise<void> {
		if (this.db) {
			this.db.close()
			this.db = null
		}
		this.memoryIndex.clear()
		this.initialized = false
	}

	/**
	 * Dynamic import of better-sqlite3 (avoids hard dependency at module level).
	 */
	private async loadBetterSqlite3(): Promise<typeof import("better-sqlite3")> {
		try {
			return await import("better-sqlite3")
		} catch {
			throw new Error("better-sqlite3 not available")
		}
	}
}
