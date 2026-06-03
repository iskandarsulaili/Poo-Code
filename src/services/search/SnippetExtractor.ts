import { HighlightedSnippet, HighlightPosition, Message, Snippet } from "./types"

/**
 * SnippetExtractor — extracts relevant snippets from content with highlighted terms.
 *
 * Supports:
 * - Extracting relevant text passages around query matches
 * - Goal/resolution bookend extraction from sessions
 * - Match highlighting with position tracking
 */
export class SnippetExtractor {
	/**
	 * Extract relevant snippets from content based on a query.
	 *
	 * @param content - Full text content to extract from
	 * @param query - Search query to match against
	 * @param maxLength - Maximum snippet length in characters (default 200)
	 * @returns Array of relevant snippets sorted by relevance
	 */
	extractSnippets(content: string, query: string, maxLength = 200): Snippet[] {
		const snippets: Snippet[] = []
		const normalizedContent = content.toLowerCase()
		const normalizedQuery = query.toLowerCase()

		// Split query into terms
		const terms = normalizedQuery.split(/\s+/).filter((t) => t.length > 0)
		if (terms.length === 0) return snippets

		// Find all match positions
		const matchPositions: number[] = []
		for (const term of terms) {
			let pos = 0
			while (pos < normalizedContent.length) {
				const idx = normalizedContent.indexOf(term, pos)
				if (idx === -1) break
				matchPositions.push(idx)
				pos = idx + 1
			}
		}

		// Sort and deduplicate positions
		const uniquePositions = [...new Set(matchPositions)].sort((a, b) => a - b)

		// Group nearby matches into snippets
		for (const pos of uniquePositions) {
			// Check if this position is already covered by a previous snippet
			if (snippets.some((s) => pos >= s.startPos && pos <= s.endPos)) continue

			const startPos = Math.max(0, pos - Math.floor(maxLength / 3))
			const endPos = Math.min(content.length, pos + maxLength - (pos - startPos))

			// Calculate relevance based on term density
			const snippetText = content.slice(startPos, endPos)
			const snippetLower = snippetText.toLowerCase()
			let termCount = 0
			for (const term of terms) {
				let tPos = 0
				while ((tPos = snippetLower.indexOf(term, tPos)) !== -1) {
					termCount++
					tPos++
				}
			}

			const relevance = terms.length > 0 ? termCount / (terms.length * 3) : 0

			snippets.push({
				text: snippetText,
				startPos,
				endPos,
				relevance: Math.min(1, relevance),
			})
		}

		// Sort by relevance descending
		snippets.sort((a, b) => b.relevance - a.relevance)

		return snippets
	}

	/**
	 * Extract goal and resolution bookends from a session conversation.
	 *
	 * Scans the beginning and end of content to identify:
	 * - Goal: what the user asked for (typically first substantive message)
	 * - Resolution: how it ended (typically last assistant response)
	 */
	extractGoalResolution(content: string): { goal: string; resolution: string } {
		const lines = content.split("\n").filter((l) => l.trim().length > 0)

		let goal = ""
		let resolution = ""

		// Find goal: first user-like message (not system/technical)
		for (let i = 0; i < Math.min(lines.length, 20); i++) {
			const line = lines[i].trim()
			if (line.length > 10 && !/^(error|warning|info|debug|\[|```|import|const|let|var|function)/i.test(line)) {
				goal = line.slice(0, 200)
				break
			}
		}

		// Find resolution: look for completion indicators at the end
		for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
			const line = lines[i].trim()
			if (/(completed|finished|done|resolved|fixed|implemented|added|updated|created|solved)/i.test(line)) {
				resolution = line.slice(0, 200)
				break
			}
		}

		// Fallback: use last substantive line
		if (!resolution && lines.length > 0) {
			resolution = lines[lines.length - 1].slice(0, 200)
		}

		return { goal, resolution }
	}

	/**
	 * Highlight matches in a snippet by returning character positions.
	 *
	 * @param snippet - Text snippet to highlight
	 * @param query - Query terms to highlight
	 * @returns HighlightedSnippet with match positions
	 */
	highlightMatches(snippet: string, query: string): HighlightedSnippet {
		const highlights: HighlightPosition[] = []
		const lowerSnippet = snippet.toLowerCase()
		const lowerQuery = query.toLowerCase()

		// Highlight each occurrence of each query term
		const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 0)
		for (const term of terms) {
			let pos = 0
			while (pos < lowerSnippet.length) {
				const idx = lowerSnippet.indexOf(term, pos)
				if (idx === -1) break

				// Merge overlapping highlights
				const merged = highlights.some(
					(h) => (idx >= h.start && idx <= h.end) || (h.start >= idx && h.start <= idx + term.length),
				)

				if (!merged) {
					highlights.push({
						start: idx,
						end: idx + term.length,
					})
				}

				pos = idx + 1
			}
		}

		// Sort highlights by start position
		highlights.sort((a, b) => a.start - b.start)

		return { text: snippet, highlights }
	}
}
