/**
 * FuzzyMatcher — Multi-strategy fuzzy matching engine.
 *
 * Implements an 8-strategy matching chain that scores 0-1:
 * 1. exact (1.0): Byte-perfect match
 * 2. ignore_whitespace (0.9): Whitespace-normalized comparison
 * 3. ignore_indent (0.85): Leading whitespace stripped
 * 4. ignore_comments (0.8): Comments stripped before comparison
 * 5. fuzzy_line (0.6–1.0): Per-line Levenshtein distance scoring
 * 6. semantic_similarity (0.7–0.95): Token-overlap / trigram similarity
 * 7. regex_pattern (0.8): Regex pattern matching
 * 8. best_effort (0.5): Fallback — finds any containing line
 *
 * Strategies are tried in order; returns the highest-confidence match.
 */
import type { MatchResult, PatchStrategy } from "./types"
import { PatcherError } from "./types"

export class FuzzyMatcher {
	private readonly strategies: PatchStrategy[] = [
		"exact",
		"ignore_whitespace",
		"ignore_indent",
		"ignore_comments",
		"fuzzy_line",
		"semantic_similarity",
		"regex_pattern",
		"best_effort",
	]

	/**
	 * Find the best match for `searchContent` within `fileContent`.
	 * Throws PatcherError if no match is found at any confidence level.
	 */
	findMatch(fileContent: string, searchContent: string): MatchResult {
		const lines = fileContent.split("\n")
		const searchLines = searchContent.split("\n")

		let bestMatch: MatchResult | null = null

		for (const strategy of this.strategies) {
			const result = this.tryStrategy(strategy, lines, searchLines)
			if (result.found && (!bestMatch || result.confidence > bestMatch.confidence)) {
				bestMatch = result
			}
			if (bestMatch && bestMatch.confidence >= 1.0) break
		}

		if (!bestMatch || !bestMatch.found) {
			throw new PatcherError("No matching content found after trying all strategies", "NO_MATCH_FOUND")
		}

		return bestMatch
	}

	/**
	 * Attempt multiple matches (e.g., for idempotent updates where
	 * multiple occurrences exist). Returns the most confident match.
	 */
	findAllMatches(fileContent: string, searchContent: string): MatchResult[] {
		const lines = fileContent.split("\n")
		const searchLines = searchContent.split("\n")

		// Try exact first, then fall back
		const matches: MatchResult[] = []

		for (const strategy of this.strategies) {
			const result = this.tryStrategy(strategy, lines, searchLines)
			if (result.found) {
				matches.push(result)
			}
			if (result.confidence >= 1.0) break
		}

		return matches
	}

	private tryStrategy(strategy: PatchStrategy, lines: string[], searchLines: string[]): MatchResult {
		switch (strategy) {
			case "exact":
				return this.exactMatch(lines, searchLines)
			case "ignore_whitespace":
				return this.normalizedMatch(lines, searchLines, (s) => s.trim(), "ignore_whitespace", 0.9)
			case "ignore_indent":
				return this.normalizedMatch(lines, searchLines, (s) => s.trimStart(), "ignore_indent", 0.85)
			case "fuzzy_line":
				return this.fuzzyLineMatch(lines, searchLines)
			case "regex_pattern":
				return this.regexMatch(lines, searchLines)
			case "ignore_comments":
				return this.commentFilteredMatch(lines, searchLines)
			case "semantic_similarity":
				return this.semanticSimilarityMatch(lines, searchLines)
			case "best_effort":
				return this.bestEffortMatch(lines, searchLines)
			default:
				return {
					found: false,
					startLine: 0,
					endLine: 0,
					confidence: 0,
					strategyUsed: strategy,
					originalContent: "",
				}
		}
	}

	private exactMatch(lines: string[], searchLines: string[]): MatchResult {
		const searchStr = searchLines.join("\n")
		const fullText = lines.join("\n")
		const idx = fullText.indexOf(searchStr)

		if (idx === -1) {
			return { found: false, startLine: 0, endLine: 0, confidence: 0, strategyUsed: "exact", originalContent: "" }
		}

		const before = fullText.slice(0, idx)
		const startLine = before.split("\n").length
		const endLine = startLine + searchLines.length - 1

		return {
			found: true,
			startLine,
			endLine,
			confidence: 1.0,
			strategyUsed: "exact",
			originalContent: searchStr,
		}
	}

	private normalizedMatch(
		lines: string[],
		searchLines: string[],
		normalize: (s: string) => string,
		strategyName: PatchStrategy,
		confidence: number,
	): MatchResult {
		const normalizedSearch = searchLines.map(normalize)
		const normalizedLines = lines.map(normalize)

		for (let i = 0; i <= normalizedLines.length - normalizedSearch.length; i++) {
			let matches = true
			for (let j = 0; j < normalizedSearch.length; j++) {
				if (normalizedLines[i + j] !== normalizedSearch[j]) {
					matches = false
					break
				}
			}
			if (matches) {
				return {
					found: true,
					startLine: i + 1,
					endLine: i + normalizedSearch.length,
					confidence,
					strategyUsed: strategyName,
					originalContent: lines.slice(i, i + normalizedSearch.length).join("\n"),
				}
			}
		}

		return {
			found: false,
			startLine: 0,
			endLine: 0,
			confidence: 0,
			strategyUsed: strategyName,
			originalContent: "",
		}
	}

	private fuzzyLineMatch(lines: string[], searchLines: string[]): MatchResult {
		let bestScore = 0
		let bestStart = -1

		for (let i = 0; i <= lines.length - searchLines.length; i++) {
			let score = 0
			for (let j = 0; j < searchLines.length; j++) {
				const dist = this.levenshteinDistance(lines[i + j].trim(), searchLines[j].trim())
				const maxLen = Math.max(lines[i + j].trim().length, searchLines[j].trim().length)
				score += maxLen > 0 ? 1 - dist / maxLen : 1
			}
			const avgScore = score / searchLines.length
			if (avgScore > bestScore) {
				bestScore = avgScore
				bestStart = i
			}
		}

		if (bestScore > 0.6 && bestStart >= 0) {
			return {
				found: true,
				startLine: bestStart + 1,
				endLine: bestStart + searchLines.length,
				confidence: bestScore,
				strategyUsed: "fuzzy_line",
				originalContent: lines.slice(bestStart, bestStart + searchLines.length).join("\n"),
			}
		}

		return {
			found: false,
			startLine: 0,
			endLine: 0,
			confidence: 0,
			strategyUsed: "fuzzy_line",
			originalContent: "",
		}
	}

	/**
	 * Semantic similarity matching using token overlap (trigram-based).
	 * Computes the Dice coefficient on character trigrams for each line pair.
	 * Effective when code has reordered tokens, minor additions, or different formatting.
	 */
	private semanticSimilarityMatch(lines: string[], searchLines: string[]): MatchResult {
		let bestScore = 0
		let bestStart = -1

		for (let i = 0; i <= lines.length - searchLines.length; i++) {
			let totalScore = 0

			for (let j = 0; j < searchLines.length; j++) {
				const lineSimilarity = this.computeTrigramSimilarity(lines[i + j].trim(), searchLines[j].trim())
				totalScore += lineSimilarity
			}

			const avgScore = totalScore / searchLines.length

			if (avgScore > bestScore) {
				bestScore = avgScore
				bestStart = i
			}
		}

		// Threshold: 0.7 for semantic similarity
		if (bestScore >= 0.7 && bestStart >= 0) {
			return {
				found: true,
				startLine: bestStart + 1,
				endLine: bestStart + searchLines.length,
				confidence: Math.min(bestScore, 0.95), // Cap at 0.95
				strategyUsed: "semantic_similarity",
				originalContent: lines.slice(bestStart, bestStart + searchLines.length).join("\n"),
			}
		}

		return {
			found: false,
			startLine: 0,
			endLine: 0,
			confidence: 0,
			strategyUsed: "semantic_similarity",
			originalContent: "",
		}
	}

	/**
	 * Compute Dice coefficient on character trigrams between two strings.
	 * Returns a value in [0, 1] where 1 = identical trigram sets.
	 */
	private computeTrigramSimilarity(a: string, b: string): number {
		if (a === b) return 1.0
		if (a.length === 0 || b.length === 0) return 0.0

		const trigramsA = this.extractTrigrams(a)
		const trigramsB = this.extractTrigrams(b)

		if (trigramsA.size === 0 && trigramsB.size === 0) return 1.0
		if (trigramsA.size === 0 || trigramsB.size === 0) return 0.0

		let intersection = 0
		for (const trigram of trigramsA) {
			if (trigramsB.has(trigram)) {
				intersection++
			}
		}

		const dice = (2 * intersection) / (trigramsA.size + trigramsB.size)
		return dice
	}

	/**
	 * Extract set of character trigrams from a string.
	 */
	private extractTrigrams(s: string): Set<string> {
		const trigrams = new Set<string>()
		if (s.length < 3) {
			// Pad short strings
			trigrams.add(s.padEnd(3, "_"))
			return trigrams
		}
		for (let i = 0; i <= s.length - 3; i++) {
			trigrams.add(s.slice(i, i + 3))
		}
		return trigrams
	}

	private regexMatch(lines: string[], searchLines: string[]): MatchResult {
		// For regex strategy, treat each search line as a pattern
		for (let i = 0; i < lines.length; i++) {
			try {
				const pattern = new RegExp(searchLines[0], "m")
				const match = lines.slice(i).findIndex((line) => pattern.test(line))
				if (match >= 0) {
					return {
						found: true,
						startLine: i + match + 1,
						endLine: i + match + 1,
						confidence: 0.8,
						strategyUsed: "regex_pattern",
						originalContent: lines[i + match],
					}
				}
			} catch {
				// Invalid regex, skip
			}
		}

		return {
			found: false,
			startLine: 0,
			endLine: 0,
			confidence: 0,
			strategyUsed: "regex_pattern",
			originalContent: "",
		}
	}

	private commentFilteredMatch(lines: string[], searchLines: string[]): MatchResult {
		const stripComments = (s: string) => s.replace(/\/\/.*$|\/\*[\s\S]*?\*\//g, "").trim()
		const normalizedSearch = searchLines.map(stripComments)
		const normalizedLines = lines.map(stripComments)

		for (let i = 0; i <= normalizedLines.length - normalizedSearch.length; i++) {
			let matches = true
			for (let j = 0; j < normalizedSearch.length; j++) {
				if (normalizedLines[i + j] !== normalizedSearch[j]) {
					matches = false
					break
				}
			}
			if (matches) {
				return {
					found: true,
					startLine: i + 1,
					endLine: i + normalizedSearch.length,
					confidence: 0.8,
					strategyUsed: "ignore_comments",
					originalContent: lines.slice(i, i + normalizedSearch.length).join("\n"),
				}
			}
		}

		return {
			found: false,
			startLine: 0,
			endLine: 0,
			confidence: 0,
			strategyUsed: "ignore_comments",
			originalContent: "",
		}
	}

	private bestEffortMatch(lines: string[], searchLines: string[]): MatchResult {
		// Last resort: try to find any line from search in file
		for (const searchLine of searchLines) {
			const trimmed = searchLine.trim()
			if (!trimmed) continue

			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes(trimmed)) {
					return {
						found: true,
						startLine: i + 1,
						endLine: i + 1,
						confidence: 0.5,
						strategyUsed: "best_effort",
						originalContent: lines[i],
					}
				}
			}
		}

		return {
			found: false,
			startLine: 0,
			endLine: 0,
			confidence: 0,
			strategyUsed: "best_effort",
			originalContent: "",
		}
	}

	private levenshteinDistance(a: string, b: string): number {
		if (a.length === 0) return b.length
		if (b.length === 0) return a.length

		const matrix: number[][] = []
		for (let i = 0; i <= b.length; i++) matrix[i] = [i]
		for (let j = 0; j <= a.length; j++) matrix[0][j] = j

		for (let i = 1; i <= b.length; i++) {
			for (let j = 1; j <= a.length; j++) {
				const cost = a[j - 1] === b[i - 1] ? 0 : 1
				matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
			}
		}

		return matrix[b.length][a.length]
	}
}
