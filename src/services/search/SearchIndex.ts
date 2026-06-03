import { IndexEntry, SearchError, SearchFilters, SearchQuery, SearchResult, SearchMode } from "./types"
import { FullTextIndex } from "./FullTextIndex"
import { SemanticSearch } from "./SemanticSearch"
import { SnippetExtractor } from "./SnippetExtractor"

/**
 * SearchIndex — main search coordinator for cross-session search (F4).
 *
 * Coordinates between FullTextIndex and SemanticSearch to provide
 * unified search across all indexed sessions. Supports fulltext,
 * semantic, and hybrid search modes.
 */
export class SearchIndex {
	private fullTextIndex: FullTextIndex
	private semanticSearch: SemanticSearch
	private snippetExtractor: SnippetExtractor
	private sessionContent: Map<string, string> = new Map()

	constructor(dbPath?: string) {
		this.fullTextIndex = new FullTextIndex(dbPath)
		this.semanticSearch = new SemanticSearch()
		this.snippetExtractor = new SnippetExtractor()
	}

	/**
	 * Initialize all search indices.
	 */
	async initialize(): Promise<void> {
		await this.fullTextIndex.initialize()
		await this.semanticSearch.initialize()
	}

	/**
	 * Execute a search across all indices.
	 *
	 * @param query - The search query with mode and filters
	 * @returns Ranked search results
	 */
	async search(query: SearchQuery): Promise<SearchResult[]> {
		let results: SearchResult[] = []

		switch (query.mode) {
			case "fulltext":
				results = await this.fullTextIndex.search(query)
				break

			case "semantic":
				results = await this.semanticSearch.search(query)
				break

			case "hybrid": {
				// Run both searches and merge
				const [ftsResults, semanticResults] = await Promise.all([
					this.fullTextIndex.search(query),
					this.semanticSearch.search(query),
				])

				// Merge and deduplicate by sessionId
				const seen = new Set<string>()
				const merged: SearchResult[] = []

				for (const r of ftsResults) {
					if (!seen.has(r.sessionId)) {
						seen.add(r.sessionId)
						merged.push(r)
					}
				}

				for (const r of semanticResults) {
					if (!seen.has(r.sessionId)) {
						seen.add(r.sessionId)
						merged.push(r)
					} else {
						// Boost relevance for entries found by both
						const existing = merged.find((m) => m.sessionId === r.sessionId)
						if (existing) {
							existing.relevance = this.semanticSearch.combineScores(
								existing.relevance,
								r.relevance,
								0.3,
								0.7,
							)
						}
					}
				}

				results = merged
				break
			}

			default:
				throw new SearchError(`Unknown search mode: ${query.mode}`, "INVALID_MODE")
		}

		// Enrich results with goal/resolution bookends
		for (const result of results) {
			const content = this.sessionContent.get(result.sessionId)
			if (content) {
				const { goal, resolution } = this.snippetExtractor.extractGoalResolution(content)
				result.goal = goal
				result.resolution = resolution
			}

			// Extract highlights
			const highlighted = this.snippetExtractor.highlightMatches(result.snippet, query.query)
			result.highlights = highlighted.highlights
		}

		// Apply limit and offset
		const limit = query.limit ?? 50
		const offset = query.offset ?? 0
		return results.slice(offset, offset + limit)
	}

	/**
	 * Search across sessions with convenience string query + filters.
	 *
	 * @param query - Raw search string
	 * @param filters - Optional search filters
	 * @returns Search results across all sessions
	 */
	async searchAcrossSessions(query: string, filters?: SearchFilters): Promise<SearchResult[]> {
		return this.search({
			query,
			mode: "hybrid",
			filters,
			limit: 50,
			offset: 0,
		})
	}

	/**
	 * Index a session's content for search.
	 *
	 * @param sessionId - Unique session identifier
	 * @param content - Full session content/transcript
	 */
	async indexSession(sessionId: string, content: string): Promise<void> {
		// Store raw content for snippet extraction
		this.sessionContent.set(sessionId, content)

		const metadata: IndexEntry = {
			sessionId,
			timestamp: Date.now(),
			mode: "conversation",
		}

		// Index in both FTS and semantic indices
		await Promise.all([this.fullTextIndex.index(content, metadata), this.semanticSearch.index(content, metadata)])
	}

	/**
	 * Remove a session from all indices.
	 *
	 * @param sessionId - Session to remove
	 */
	async removeSession(sessionId: string): Promise<void> {
		this.sessionContent.delete(sessionId)
		await Promise.all([this.fullTextIndex.remove(sessionId), this.semanticSearch.remove(sessionId)])
	}

	/**
	 * Get the total count of indexed documents.
	 */
	async count(): Promise<number> {
		return this.fullTextIndex.count()
	}

	/**
	 * Shutdown and clean up resources.
	 */
	async shutdown(): Promise<void> {
		await Promise.all([this.fullTextIndex.shutdown(), this.semanticSearch.shutdown()])
		this.sessionContent.clear()
	}
}
