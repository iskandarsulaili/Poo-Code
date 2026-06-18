import type { ParsedResult, ParsedError, ProjectLanguage } from "@roo-code/types"

/**
 * Minimum output length (in characters) to trigger LLM fallback.
 * Prevents wasteful LLM calls for trivially short or empty output.
 */
const MIN_OUTPUT_LENGTH_FOR_LLM = 100

/**
 * Callback signature for the LLM fallback.
 * The extension wires this during initialization with the active LLM provider.
 *
 * @param output - Raw command output to analyze
 * @param language - Optional language hint
 * @returns ParsedResult with structured errors/warnings
 */
export type LLMFallbackCallback = (output: string, language?: ProjectLanguage) => Promise<ParsedResult>

/**
 * Build the prompt sent to the LLM for semantic output analysis.
 *
 * @param rawOutput - The raw command output to parse
 * @param language - Optional project language hint
 * @returns Prompt string for the LLM
 */
export function buildLLMPrompt(rawOutput: string, language?: ProjectLanguage): string {
	const lang = language ?? "unknown"

	return [
		"Parse the following build/lint/test output and extract all errors and warnings.",
		"",
		`Language: ${lang}`,
		"",
		"Output:",
		"```",
		rawOutput,
		"```",
		"",
		"Return a JSON object:",
		"{",
		'  "errors": [',
		"    {",
		'      "file": "path/to/file.ext",',
		'      "line": number | null,',
		'      "column": number | null,',
		'      "message": "error description",',
		'      "code": "error code if any",',
		'      "rule": "rule name if any"',
		"    }",
		"  ],",
		'  "warnings": [',
		"    {",
		'      "file": "path/to/file.ext",',
		'      "line": number | null,',
		'      "column": number | null,',
		'      "message": "warning description",',
		'      "code": "warning code if any",',
		'      "rule": "rule name if any"',
		"    }",
		"  ],",
		'  "summary": "brief summary of findings"',
		"}",
		"",
		"Return ONLY valid JSON — no markdown wrapping, no explanation.",
	].join("\n")
}

/**
 * Parse the LLM's JSON response into a ParsedResult.
 *
 * @param response - Raw string response from the LLM
 * @param rawOutput - Original raw output (preserved in ParsedResult.rawOutput)
 * @returns ParsedResult with structured diagnostics from the LLM
 */
export function parseLLMResponse(response: string, rawOutput: string): ParsedResult {
	// Strip markdown code fences if present
	let cleaned = response.trim()
	const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
	if (jsonMatch) {
		cleaned = jsonMatch[1].trim()
	}

	let parsed: {
		errors?: Array<{
			file?: string | null
			line?: number | null
			column?: number | null
			message?: string | null
			code?: string | null
			rule?: string | null
		}>
		warnings?: Array<{
			file?: string | null
			line?: number | null
			column?: number | null
			message?: string | null
			code?: string | null
			rule?: string | null
		}>
		summary?: string | null
	}

	try {
		parsed = JSON.parse(cleaned)
	} catch {
		// If parsing fails, return the raw output as error message
		return {
			exitCode: undefined,
			duration: 0,
			stdout: rawOutput,
			stderr: "",
			errors: [],
			warnings: [],
			genericMessages: [rawOutput],
			summary: "LLM fallback returned unparseable response",
			rawOutput,
			truncated: false,
		}
	}

	const errors: ParsedError[] = (parsed.errors ?? []).map((e) => ({
		file: e.file ?? "unknown",
		line: e.line ?? 0,
		...(e.column != null && { column: e.column }),
		severity: "error" as const,
		message: e.message ?? "Unknown error",
		...(e.code != null && e.code !== null && { code: e.code }),
		...(e.rule != null && e.rule !== null && { rule: e.rule }),
		raw: rawOutput,
	}))

	const warnings: ParsedError[] = (parsed.warnings ?? []).map((w) => ({
		file: w.file ?? "unknown",
		line: w.line ?? 0,
		...(w.column != null && { column: w.column }),
		severity: "warning" as const,
		message: w.message ?? "Unknown warning",
		...(w.code != null && w.code !== null && { code: w.code }),
		...(w.rule != null && w.rule !== null && { rule: w.rule }),
		raw: rawOutput,
	}))

	const summary = parsed.summary ?? buildLLMSummary(errors.length, warnings.length)

	return {
		exitCode: undefined,
		duration: 0,
		stdout: rawOutput,
		stderr: "",
		errors,
		warnings,
		genericMessages: [],
		summary,
		rawOutput,
		truncated: false,
	}
}

/**
 * Determine if the LLM fallback should be invoked based on output content.
 *
 * @param result - The result from the regular parser
 * @param output - The raw output string
 * @returns True if LLM fallback should be attempted
 */
export function shouldInvokeLLMFallback(result: ParsedResult, output: string): boolean {
	// Don't call LLM for empty or trivially short output
	if (!output || output.trim().length < MIN_OUTPUT_LENGTH_FOR_LLM) {
		return false
	}
	// Only invoke if the regular parser found zero errors AND zero warnings
	if (result.errors.length > 0 || result.warnings.length > 0) {
		return false
	}
	return true
}

/**
 * Build a summary string from error/warning counts.
 */
function buildLLMSummary(errorCount: number, warningCount: number): string {
	const parts: string[] = []
	if (errorCount > 0) {
		parts.push(`${errorCount} error(s)`)
	}
	if (warningCount > 0) {
		parts.push(`${warningCount} warning(s)`)
	}
	if (parts.length === 0) {
		return "LLM fallback: no issues found"
	}
	return `LLM fallback: ${parts.join(", ")}`
}
