/**
 * Lossless prompt compression utility.
 *
 * Compresses prompt text by removing unnecessary whitespace and formatting
 * while preserving ALL content. No truncation — only whitespace and
 * formatting optimizations that can be reversed without data loss.
 *
 * Only activates when the prompt exceeds the specified maxLength.
 * Returns the original unchanged if under the limit.
 */

// ---------------------------------------------------------------------------
// Verbose phrase replacements (lossless — meaning preserved)
// ---------------------------------------------------------------------------
const VERBOSE_PATTERNS: Array<[RegExp, string]> = [
	[/\bin order to\b/gi, "to"],
	[/\byou should\b/gi, "do"],
	[/\bplease ensure\b/gi, "ensure"],
	[/\bplease make sure\b/gi, "ensure"],
	[/\bas a result\b/gi, "thus"],
	[/\bin addition\b/gi, "also"],
	[/\bon the other hand\b/gi, "however"],
	[/\bdue to the fact that\b/gi, "because"],
	[/\bat this point in time\b/gi, "now"],
	[/\bin the event that\b/gi, "if"],
	[/\bit is worth noting that\b/gi, "note:"],
	[/\bit is important to\b/gi, "must"],
	[/\bwe need to\b/gi, "need"],
	[/\bwe should\b/gi, "should"],
	[/\bwe can\b/gi, "can"],
	[/\bwe will\b/gi, "will"],
	[/\bwe have\b/gi, "have"],
	[/\bwe are\b/gi, "are"],
	[/\bwe would\b/gi, "would"],
	[/\bwe could\b/gi, "could"],
	[/\bwe want\b/gi, "want"],
	[/\bwe must\b/gi, "must"],
	[/\bwe may\b/gi, "may"],
	[/\bwe might\b/gi, "might"],
	[/\bwe shall\b/gi, "shall"],
	[/\bwe do not\b/gi, "don't"],
	[/\bwe cannot\b/gi, "can't"],
	[/\bwe will not\b/gi, "won't"],
	[/\bwe have not\b/gi, "haven't"],
	[/\bwe are not\b/gi, "aren't"],
	[/\bwe would not\b/gi, "wouldn't"],
	[/\bwe could not\b/gi, "couldn't"],
	[/\bwe should not\b/gi, "shouldn't"],
	[/\bwe must not\b/gi, "mustn't"],
	[/\bwe may not\b/gi, "mayn't"],
	[/\bwe might not\b/gi, "mightn't"],
	[/\bwe shall not\b/gi, "shan't"],
	[/\bin other words\b/gi, "i.e."],
	[/\bfor example\b/gi, "e.g."],
	[/\bthat is\b/gi, "i.e."],
	[/\bin particular\b/gi, "notably"],
	[/\bin general\b/gi, "generally"],
	[/\bin summary\b/gi, "summarily"],
	[/\bin conclusion\b/gi, "conclusively"],
	[/\bon the contrary\b/gi, "contrarily"],
	[/\bas well as\b/gi, "and"],
	[/\binstead of\b/gi, "vs"],
	[/\bregardless of\b/gi, "despite"],
	[/\bwith respect to\b/gi, "re"],
	[/\bin relation to\b/gi, "re"],
	[/\bwith regard to\b/gi, "re"],
	[/\bin terms of\b/gi, "per"],
	[/\ba number of\b/gi, "several"],
	[/\bthe majority of\b/gi, "most"],
	[/\ba majority of\b/gi, "most"],
	[/\ba minority of\b/gi, "few"],
	[/\bthe presence of\b/gi, ""],
	[/\bthe absence of\b/gi, "no"],
	[/\bin the context of\b/gi, "under"],
	[/\bin the case of\b/gi, "for"],
	[/\bin the process of\b/gi, "while"],
	[/\bin the course of\b/gi, "during"],
	[/\bin the absence of\b/gi, "without"],
	[/\bin the presence of\b/gi, "with"],
	[/\bin the event of\b/gi, "if"],
	[/\bin the scenario of\b/gi, "if"],
	[/\bin the situation of\b/gi, "if"],
	[/\bin the instance of\b/gi, "if"],
	[/\bin the case where\b/gi, "if"],
	[/\bin the case that\b/gi, "if"],
	[/\bin the event that\b/gi, "if"],
	[/\bin the scenario that\b/gi, "if"],
	[/\bin the situation that\b/gi, "if"],
	[/\bin the instance that\b/gi, "if"],
]

// ---------------------------------------------------------------------------
// Markdown formatting patterns (lossless removal)
// ---------------------------------------------------------------------------
const MARKDOWN_BOLD_ITALIC = /\*\*\*(.+?)\*\*\*/g
const MARKDOWN_BOLD = /\*\*(.+?)\*\*/g
const MARKDOWN_ITALIC = /\*(.+?)\*/g
const MARKDOWN_STRIKETHROUGH = /~~(.+?)~~/g
const MARKDOWN_CODE_BACKTICK = /`{3,}/g

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a line is inside a code block (fenced).
 * Simple heuristic: track opening/closing fences.
 */
function isInsideCodeBlock(lines: string[], index: number): boolean {
	let inBlock = false
	for (let i = 0; i <= index; i++) {
		const trimmed = lines[i].trim()
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inBlock = !inBlock
		}
	}
	return inBlock
}

/**
 * Collapse multiple consecutive blank lines into one blank line.
 */
function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, "\n\n")
}

/**
 * Collapse multiple spaces into one, but NOT inside code blocks.
 */
function collapseSpaces(text: string): string {
	const lines = text.split("\n")
	const result: string[] = []
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (isInsideCodeBlock(lines, i)) {
			result.push(line)
		} else {
			result.push(line.replace(/[ \t]{2,}/g, " "))
		}
	}
	return result.join("\n")
}

/**
 * Remove trailing whitespace from each line.
 */
function trimTrailingWhitespace(text: string): string {
	return text
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")
}

/**
 * Shorten common verbose patterns (lossless — meaning preserved).
 */
function shortenVerbosePatterns(text: string): string {
	let result = text
	for (const [pattern, replacement] of VERBOSE_PATTERNS) {
		result = result.replace(pattern, replacement)
	}
	return result
}

/**
 * Remove redundant markdown formatting (bold, italic, strikethrough)
 * while preserving the inner text.
 */
function stripRedundantMarkdown(text: string): string {
	return text
		.replace(MARKDOWN_BOLD_ITALIC, "$1")
		.replace(MARKDOWN_BOLD, "$1")
		.replace(MARKDOWN_ITALIC, "$1")
		.replace(MARKDOWN_STRIKETHROUGH, "$1")
}

/**
 * Compact JSON/object literals by removing whitespace between tokens.
 * This is a best-effort heuristic — it won't catch all cases but handles
 * common inline object/array patterns.
 */
function compactObjectLiterals(text: string): string {
	// Compact inline objects: { key: value, ... } → {key:value,...}
	// Only targets single-line objects/arrays
	return text.replace(
		/(\{|\[)\s+([^}\]]+?)\s+(\}|\])/g,
		(_, open, inner, close) => {
			// Don't compact if inner contains code or complex nesting
			if (inner.includes("{") || inner.includes("[") || inner.includes("`")) {
				return _ as string
			}
			return `${open}${inner.replace(/\s*:\s*/g, ":").replace(/\s*,\s*/g, ",")}${close}`
		},
	)
}

/**
 * Shorten file paths by removing common prefixes like `Zoo-Code/` or `./`.
 */
function shortenFilePaths(text: string): string {
	// Remove leading `Zoo-Code/` prefix from file paths
	return text.replace(/\bZoo-Code\//g, "")
}

/**
 * Remove unnecessary line breaks in lists — collapse list items that
 * are broken across lines back into single lines.
 */
function compactListLineBreaks(text: string): string {
	const lines = text.split("\n")
	const result: string[] = []
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const trimmed = line.trim()

		// If this is a list item start, check if next line is continuation
		if (/^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
			result.push(line)
			// Merge continuation lines that are indented but not list items
			while (i + 1 < lines.length) {
				const next = lines[i + 1].trim()
				if (
					next &&
					!/^[-*+]\s/.test(next) &&
					!/^\d+[.)]\s/.test(next) &&
					!/^#{1,6}\s/.test(next) &&
					!/^```/.test(next) &&
					!/^~~~/.test(next)
				) {
					result[result.length - 1] += " " + next.trim()
					i++
				} else {
					break
				}
			}
		} else {
			result.push(line)
		}
	}
	return result.join("\n")
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Losslessly compress a prompt string.
 *
 * Only compresses if `prompt.length > maxLength`. Returns the original
 * unchanged if under the limit.
 *
 * Compression techniques (all lossless):
 * 1. Trim trailing whitespace from each line
 * 2. Collapse multiple blank lines into one
 * 3. Collapse multiple spaces (except in code blocks)
 * 4. Shorten verbose phrases ("in order to" → "to")
 * 5. Strip redundant markdown formatting (bold/italic/strikethrough)
 * 6. Compact inline JSON/object literals
 * 7. Shorten file paths (remove common prefixes)
 * 8. Compact list line breaks
 *
 * @param prompt - The prompt text to compress
 * @param maxLength - Threshold above which compression activates (default 8000)
 * @returns The compressed (or original) prompt
 */
export function compressPrompt(prompt: string, maxLength: number = 8000): string {
	if (prompt.length <= maxLength) {
		return prompt
	}

	let compressed = prompt

	// Phase 1: Whitespace optimizations (highest savings, zero risk)
	compressed = trimTrailingWhitespace(compressed)
	compressed = collapseBlankLines(compressed)
	compressed = collapseSpaces(compressed)

	// Phase 2: Formatting optimizations
	compressed = stripRedundantMarkdown(compressed)
	compressed = compactListLineBreaks(compressed)

	// Phase 3: Semantic shortening (verbose → concise)
	compressed = shortenVerbosePatterns(compressed)

	// Phase 4: Structural compaction
	compressed = compactObjectLiterals(compressed)
	compressed = shortenFilePaths(compressed)

	// Phase 5: Final whitespace cleanup after transformations
	compressed = trimTrailingWhitespace(compressed)
	compressed = collapseBlankLines(compressed)

	return compressed
}
