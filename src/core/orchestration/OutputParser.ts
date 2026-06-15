import type { ParsedResult, ParsedError, ParserPlugin, ProjectLanguage, AggregatedResult } from "@roo-code/types"
import { experimentConfigsMap } from "../../shared/experiments"
import type { LLMFallbackCallback } from "./LLMFallbackParser"
import { shouldInvokeLLMFallback } from "./LLMFallbackParser"

/**
 * ANSI escape sequence regex — matches common terminal control sequences.
 * Built via RegExp constructor to avoid no-control-regex lint rule.
 */
const ANSI_PATTERN = new RegExp(
	"[" +
		String.fromCharCode(0x1b) +
		String.fromCharCode(0x9b) +
		"][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]",
	"g",
)

/**
 * Regex patterns for the generic fallback parser.
 * Ordered by specificity (most structured first).
 */
const GENERIC_PATTERNS: RegExp[] = [
	// filename:line:column: error/warning: message  (gcc/tsc generic style)
	/^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s+(?<severity>error|warning)\s*(?<code>[\w\d]+\d*)?\s*:\s*(?<message>.+)$/gm,
	// filename:line: error/warning: message  (mypy/python style)
	/^(?<file>.+?):(?<line>\d+):\s+(?<severity>error|warning)\s*(?<code>[\w\d]+\d*)?\s*:\s*(?<message>.+)$/gm,
	// filename(line,column): error/warning message  (Java-style)
	/^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s+(?<severity>error|warning)\s*(?<code>[\w\d]+\d*)?\s*(?<message>.+)$/gm,
	// Error: message / Warning: message  (generic standalone)
	/^(?<severity>Error|Warning):\s*(?<message>.+)$/gm,
	// ERROR: message / WARNING: message  (generic standalone, uppercase)
	/^(?<severity>ERROR|WARNING):\s*(?<message>.+)$/gm,
	// FAILED / failed patterns (test output)
	/^(?<severity>FAILED|FAIL)\s+(?<file>.+?)::(?<message>.+)$/gm,
]

/**
 * Strip ANSI escape sequences from a string.
 *
 * @param input - Raw string possibly containing ANSI codes
 * @returns Clean string with ANSI codes removed
 */
export function stripAnsiCodes(input: string): string {
	return input.replace(ANSI_PATTERN, "")
}

/**
 * Detect whether output appears to contain binary content.
 * Uses NUL byte detection and printable character ratio heuristics.
 *
 * @param output - Raw output string to inspect
 * @returns True if output appears to be binary
 */
export function isBinaryOutput(output: string): boolean {
	// Check for NUL bytes
	if (output.includes("\0")) {
		return true
	}
	// Sample first 4096 bytes for printable ratio
	const sample = output.slice(0, 4096)
	if (sample.length === 0) return false

	let printable = 0
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i)
		// Tab, newline, carriage return count as printable
		if (code === 9 || code === 10 || code === 13) {
			printable++
		} else if (code >= 32 && code <= 126) {
			printable++
		} else if (code > 126) {
			// UTF-8 multi-byte — printable
			printable++
		}
	}

	const ratio = printable / sample.length
	// If less than 80% printable, treat as binary
	return ratio < 0.8
}

/**
 * Generic fallback parser that catches common error patterns.
 * Used when no language-specific plugin matches.
 * Implements the ParserPlugin interface.
 */
export const GenericParser: ParserPlugin = {
	name: "generic",
	language: undefined,
	toolPattern: undefined,

	parse(stdout: string, stderr: string, exitCode?: number): ParsedResult {
		const startTime = Date.now()
		const combined = stripAnsiCodes(stdout + "\n" + stderr)
		const rawOutput = stdout + "\n" + stderr

		// Binary detection
		if (isBinaryOutput(combined)) {
			return {
				exitCode,
				duration: Date.now() - startTime,
				stdout,
				stderr,
				errors: [],
				warnings: [],
				genericMessages: [combined],
				summary: "[Binary output detected — skipped parsing]",
				rawOutput,
				truncated: false,
			}
		}

		const errors: ParsedError[] = []
		const warnings: ParsedError[] = []
		const genericMessages: string[] = []
		const seenSignatures = new Set<string>()

		const lines = combined.split("\n")
		const matchedLines = new Set<number>()

		// Apply each pattern
		for (const pattern of GENERIC_PATTERNS) {
			let match: RegExpExecArray | null
			while ((match = pattern.exec(combined)) !== null) {
				const groups = match.groups ?? {}
				const severity = (groups.severity ?? "error").toLowerCase() as "error" | "warning"
				const message = (groups.message ?? match[0]).trim()
				const file = groups.file ?? ""
				const line = groups.line ? parseInt(groups.line, 10) : undefined
				const column = groups.column ? parseInt(groups.column, 10) : undefined
				const code = groups.code ?? undefined
				const raw = match[0]

				// De-duplicate by signature
				const sig = `${file}:${line ?? 0}:${message}`
				if (seenSignatures.has(sig)) continue
				seenSignatures.add(sig)

				const entry: ParsedError = {
					file: file || "unknown",
					line: line ?? 0,
					...(column !== undefined && { column }),
					severity,
					message,
					...(code && { code }),
					raw,
				}

				if (severity === "warning") {
					warnings.push(entry)
				} else {
					errors.push(entry)
				}

				// Mark matched lines
				const rawLineIndex = lines.findIndex((l) => l.includes(raw.slice(0, 40)))
				if (rawLineIndex >= 0) {
					matchedLines.add(rawLineIndex)
				}
			}
		}

		// Unmatched lines become generic messages
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim()
			if (trimmed && !matchedLines.has(i)) {
				genericMessages.push(trimmed)
			}
		}

		const errorCount = errors.length
		const warningCount = warnings.length
		const summary = buildSummary(errorCount, warningCount, genericMessages.length)

		return {
			exitCode,
			duration: Date.now() - startTime,
			stdout,
			stderr,
			errors,
			warnings,
			genericMessages,
			summary,
			rawOutput,
			truncated: false,
		}
	},
}

/**
 * Build a human-readable summary from diagnostic counts.
 */
function buildSummary(errorCount: number, warningCount: number, messageCount: number): string {
	const parts: string[] = []
	if (errorCount > 0) {
		parts.push(`${errorCount} error(s)`)
	}
	if (warningCount > 0) {
		parts.push(`${warningCount} warning(s)`)
	}
	if (messageCount > 0) {
		parts.push(`${messageCount} message(s)`)
	}
	if (parts.length === 0) {
		return "No issues found"
	}
	return parts.join(", ")
}

/**
 * Map file extensions to project languages for parser selection.
 */
const EXTENSION_TO_LANGUAGE: Record<string, ProjectLanguage> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".kt": "kotlin",
	".kts": "kotlin",
	".go": "go",
	".rs": "rust",
}

/**
 * Infer project language from a file name/extension.
 *
 * @param fileName - File name or path
 * @returns Detected ProjectLanguage or "unknown"
 */
export function inferLanguageFromFile(fileName: string): ProjectLanguage {
	const ext = fileName.slice(fileName.lastIndexOf("."))
	return EXTENSION_TO_LANGUAGE[ext] ?? "unknown"
}

/**
 * Output parser registry and dispatcher.
 *
 * Manages a registry of language-specific parser plugins and provides
 * fallback to a generic regex-based parser. Supports feature-flag gating,
 * graceful degradation, and multi-output aggregation.
 *
 * Usage:
 * ```ts
 * const parser = new OutputParser()
 * parser.registerParser("typescript", TypeScriptParser)
 * const result = await parser.parse(output, "typescript")
 * ```
 */
export class OutputParser {
	/** Registered parsers keyed by ProjectLanguage */
	private parserMap = new Map<ProjectLanguage, ParserPlugin>()

	/** Callback for LLM fallback parsing (dependency-injected) */
	private llmFallbackCallback: LLMFallbackCallback | null = null

	/** Whether LLM fallback is currently enabled */
	private llmFallbackEnabled: boolean = false

	/**
	 * Register a parser plugin for a specific language.
	 *
	 * @param language - The project language to associate this parser with
	 * @param parser - The parser plugin instance
	 */
	registerParser(language: ProjectLanguage, parser: ParserPlugin): void {
		this.parserMap.set(language, parser)
	}

	/**
	 * Unregister a parser plugin for a specific language.
	 *
	 * @param language - The language whose parser to remove
	 */
	unregisterParser(language: ProjectLanguage): void {
		this.parserMap.delete(language)
	}

	/**
	 * Get the registered parser for a language, if any.
	 *
	 * @param language - The project language to look up
	 * @returns The parser plugin, or undefined if none registered
	 */
	getParser(language: ProjectLanguage): ParserPlugin | undefined {
		return this.parserMap.get(language)
	}

	/**
	 * Parse command output using the best matching parser.
	 *
	 * Selection strategy:
	 * 1. If language specified and parser registered, use that parser
	 * 2. If fileName specified, infer language from extension
	 * 3. If no parser found, use generic fallback parser
	 *
	 * Always preserves raw output in `ParsedResult.rawOutput`.
	 *
	 * Feature-flag gated: if `STRUCTURED_OUTPUT_PARSING` experiment is disabled,
	 * returns a result with empty errors/warnings and the raw output preserved.
	 *
	 * @param output - Raw command output (combined stdout + stderr)
	 * @param language - Optional language hint for parser selection
	 * @param fileName - Optional file name to infer language from extension
	 * @returns ParsedResult with extracted diagnostics
	 */
	async parse(output: string, language?: ProjectLanguage, fileName?: string): Promise<ParsedResult> {
		const startTime = Date.now()

		// Feature flag check
		if (!experimentConfigsMap.STRUCTURED_OUTPUT_PARSING.enabled) {
			return {
				exitCode: undefined,
				duration: Date.now() - startTime,
				stdout: output,
				stderr: "",
				errors: [],
				warnings: [],
				genericMessages: [],
				summary: "Structured output parsing is disabled",
				rawOutput: output,
				truncated: false,
			}
		}

		// Determine target language
		let targetLanguage = language
		if (!targetLanguage && fileName) {
			targetLanguage = inferLanguageFromFile(fileName)
		}

		// Find parser
		const parser = targetLanguage ? this.parserMap.get(targetLanguage) : undefined
		const activeParser = parser ?? GenericParser

		// Step 1: Normal regex-based parsing
		let result: ParsedResult
		try {
			// Parse using the selected parser
			// Pass the combined output as stdout since we don't have separate streams
			result = activeParser.parse(output, "", undefined)
			result = {
				...result,
				rawOutput: output,
			}
		} catch (error) {
			// Graceful degradation — if parser throws, fall back to generic
			console.error(`[OutputParser] Parser "${activeParser.name}" threw:`, error)
			const fallbackResult = GenericParser.parse(output, "", undefined)
			result = {
				...fallbackResult,
				rawOutput: output,
			}
		}

		// Step 2: LLM fallback — if enabled and regex found nothing meaningful
		if (this.llmFallbackEnabled && this.llmFallbackCallback && shouldInvokeLLMFallback(result, output)) {
			try {
				const llmResult = await this.llmFallbackCallback(output, targetLanguage)
				// Merge LLM results into the result, preserving exit code from generic if present
				return {
					...result,
					errors: llmResult.errors.length > 0 ? llmResult.errors : result.errors,
					warnings: llmResult.warnings.length > 0 ? llmResult.warnings : result.warnings,
					summary: llmResult.summary,
				}
			} catch (error) {
				// Graceful degradation — if LLM call fails, return the regex-based result
				console.error("[OutputParser] LLM fallback threw:", error)
			}
		}

		return result
	}

	/**
	 * Parse multiple outputs, optionally using different languages/file hints.
	 * Each output is parsed independently. If one parse fails, others continue.
	 *
	 * @param outputs - Array of outputs with optional language/file hints
	 * @returns Array of ParsedResult (one per input, in same order)
	 */
	async parseWithFallback(
		outputs: Array<{ output: string; language?: ProjectLanguage; fileName?: string }>,
	): Promise<ParsedResult[]> {
		const results = await Promise.allSettled(
			outputs.map((item) => this.parse(item.output, item.language, item.fileName)),
		)

		return results.map((r) => {
			if (r.status === "fulfilled") {
				return r.value
			}
			// If a parse rejected entirely, return a minimal fallback result
			return {
				exitCode: undefined,
				duration: 0,
				stdout: "",
				stderr: "",
				errors: [],
				warnings: [],
				genericMessages: [],
				summary: "Parse failed with unexpected error",
				rawOutput: "",
				truncated: false,
			}
		})
	}

	/**
	 * Aggregate multiple parsed results into a single AggregatedResult.
	 *
	 * Combines error/warning counts and total duration across all results.
	 *
	 * @param results - Array of ParsedResult to aggregate
	 * @returns AggregatedResult with combined counts and duration
	 */
	aggregateResults(results: ParsedResult[]): AggregatedResult {
		let totalErrorCount = 0
		let totalWarningCount = 0
		let totalDuration = 0

		for (const result of results) {
			totalErrorCount += result.errors.length
			totalWarningCount += result.warnings.length
			totalDuration += result.duration
		}

		return {
			groups: [],
			totalDuration,
			successCount: results.length - totalErrorCount,
			failedCount: totalErrorCount,
			skippedCount: 0,
		}
	}

	/**
	 * Get list of languages that have registered parsers.
	 *
	 * @returns Array of ProjectLanguage values with registered parsers
	 */
	getSupportedLanguages(): ProjectLanguage[] {
		return Array.from(this.parserMap.keys())
	}

	/**
	 * Set the LLM fallback callback for semantic parsing of unrecognized output.
	 * The callback is dependency-injected, so OutputParser never imports the LLM provider directly.
	 *
	 * @param callback - Async callback that receives raw output and optional language hint,
	 *                   returns a ParsedResult with structured diagnostics
	 */
	setLLMFallbackCallback(callback: LLMFallbackCallback | null): void {
		this.llmFallbackCallback = callback
	}

	/**
	 * Enable or disable the LLM fallback feature.
	 *
	 * @param enabled - Whether LLM fallback should be attempted when regex parsing produces no results
	 */
	setLLMFallbackEnabled(enabled: boolean): void {
		this.llmFallbackEnabled = enabled
	}

	/**
	 * Check whether LLM fallback is currently enabled.
	 *
	 * @returns True if LLM fallback is enabled
	 */
	isLLMFallbackEnabled(): boolean {
		return this.llmFallbackEnabled
	}

	/**
	 * Parse output with LLM fallback explicitly (bypasses the automatic trigger logic).
	 * Useful for callers who want to force LLM analysis regardless of regex results.
	 *
	 * @param output - Raw command output to parse
	 * @param language - Optional language hint
	 * @returns ParsedResult from LLM analysis (or generic fallback if LLM unavailable/fails)
	 */
	async parseWithLLMFallback(output: string, language?: ProjectLanguage): Promise<ParsedResult> {
		if (!this.llmFallbackCallback) {
			console.warn(
				"[OutputParser] parseWithLLMFallback called but no callback registered; falling back to generic",
			)
			return {
				exitCode: undefined,
				duration: 0,
				stdout: output,
				stderr: "",
				errors: [],
				warnings: [],
				genericMessages: [output],
				summary: "LLM fallback not configured",
				rawOutput: output,
				truncated: false,
			}
		}

		try {
			return await this.llmFallbackCallback(output, language)
		} catch (error) {
			console.error("[OutputParser] parseWithLLMFallback threw:", error)
			return {
				exitCode: undefined,
				duration: 0,
				stdout: output,
				stderr: "",
				errors: [],
				warnings: [],
				genericMessages: [output],
				summary: "LLM fallback failed",
				rawOutput: output,
				truncated: false,
			}
		}
	}
}

/**
 * Alias for backward compatibility.
 * @deprecated Use `OutputParser` instead.
 */
export const ParserRegistry = OutputParser
