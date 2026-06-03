import { IndexEntry, SearchFilters, SearchQuery, SearchResult, SearchMode, SemanticSearchError } from "./types"

/**
 * SemanticSearch — embedding-based semantic search.
 *
 * Uses TF-IDF weighted word vector cosine similarity as the default
 * embedding approach (no external API dependency). Supports pluggable
 * embedding providers for production use.
 *
 * In hybrid mode, combines FTS score with semantic score.
 */
export class SemanticSearch {
	private index: Map<string, { text: string; embedding: number[]; metadata: IndexEntry }> = new Map()
	private initialized = false
	private idfCache: Map<string, number> = new Map()
	private documentCount = 0

	/**
	 * Initialize the semantic search index.
	 */
	async initialize(): Promise<void> {
		this.initialized = true
	}

	/**
	 * Generate an embedding vector from text using TF-IDF weighted word vectors.
	 *
	 * In production, replace with an actual embedding API call.
	 */
	async embed(text: string): Promise<number[]> {
		// Normalize and tokenize
		const tokens = this.tokenize(text)
		const vector = this.textToVector(tokens)
		return this.normalizeVector(vector)
	}

	/**
	 * Index text with associated metadata.
	 */
	async index(text: string, metadata: IndexEntry): Promise<void> {
		const embedding = await this.embed(text)
		const id = `${metadata.sessionId}:${Date.now()}`
		this.index.set(id, { text, embedding, metadata })
		this.documentCount++

		// Update IDF cache with new tokens
		const tokens = this.tokenize(text)
		for (const token of new Set(tokens)) {
			const current = this.idfCache.get(token) ?? 0
			this.idfCache.set(token, current + 1)
		}
	}

	/**
	 * Search by semantic similarity (cosine similarity on embeddings).
	 */
	async search(query: SearchQuery): Promise<SearchResult[]> {
		const limit = query.limit ?? 50
		const offset = query.offset ?? 0
		const queryEmbedding = await this.embed(query.query)

		const scored: Array<{ result: SearchResult; score: number }> = []

		for (const [, entry] of this.index.entries()) {
			const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding)

			if (similarity < 0.05) continue // Relevance floor

			scored.push({
				score: similarity,
				result: {
					sessionId: entry.metadata.sessionId,
					relevance: similarity,
					snippet: entry.text.slice(0, 200),
					highlights: [],
					timestamp: entry.metadata.timestamp,
					mode: "semantic" as SearchMode,
					metadata: { filePath: entry.metadata.filePath },
				},
			})
		}

		// Sort by score descending
		scored.sort((a, b) => b.score - a.score)

		let results = scored.map((s) => s.result)

		// Apply filters
		if (query.filters) {
			results = this.applyFilters(results, query.filters)
		}

		return results.slice(offset, offset + limit)
	}

	/**
	 * Remove all entries for a given session.
	 */
	async remove(sessionId: string): Promise<void> {
		const toDelete: string[] = []
		for (const [id, entry] of this.index.entries()) {
			if (entry.metadata.sessionId === sessionId) {
				toDelete.push(id)
			}
		}
		for (const id of toDelete) {
			this.index.delete(id)
			this.documentCount--
		}
	}

	/**
	 * Combined score: weighted FTS + semantic score (for hybrid mode).
	 */
	combineScores(ftsScore: number, semanticScore: number, ftsWeight = 0.4, semanticWeight = 0.6): number {
		return ftsScore * ftsWeight + semanticScore * semanticWeight
	}

	/**
	 * Count indexed documents.
	 */
	async count(): Promise<number> {
		return this.index.size
	}

	/**
	 * Shutdown.
	 */
	async shutdown(): Promise<void> {
		this.index.clear()
		this.idfCache.clear()
		this.documentCount = 0
		this.initialized = false
	}

	/**
	 * Tokenize text into words.
	 */
	private tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((t) => t.length >= 2)
	}

	/**
	 * Convert tokenized text to TF-IDF weighted vector.
	 */
	private textToVector(tokens: string[]): number[] {
		const N = Math.min(tokens.length, 1000) // limit vector size
		const vector: number[] = new Array(N).fill(0)

		// Simple term frequency with IDF weighting
		const tf = new Map<string, number>()
		for (const token of tokens) {
			tf.set(token, (tf.get(token) ?? 0) + 1)
		}

		let idx = 0
		for (const [token, freq] of tf) {
			if (idx >= N) break
			const idf = this.idfCache.get(token)
				? Math.log((this.documentCount + 1) / (this.idfCache.get(token)! + 1)) + 1
				: 1.0
			vector[idx] = (freq / tokens.length) * idf
			idx++
		}

		return vector
	}

	/**
	 * L2 normalize a vector to unit length.
	 */
	private normalizeVector(vector: number[]): number[] {
		const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
		if (magnitude === 0) return vector
		return vector.map((v) => v / magnitude)
	}

	/**
	 * Cosine similarity between two vectors.
	 */
	private cosineSimilarity(a: number[], b: number[]): number {
		const minLen = Math.min(a.length, b.length)
		let dot = 0
		let magA = 0
		let magB = 0

		for (let i = 0; i < minLen; i++) {
			dot += a[i] * b[i]
			magA += a[i] * a[i]
			magB += b[i] * b[i]
		}

		const denom = Math.sqrt(magA) * Math.sqrt(magB)
		if (denom === 0) return 0
		return dot / denom
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
}
