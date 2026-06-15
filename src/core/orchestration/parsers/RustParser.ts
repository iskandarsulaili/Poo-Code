import type { ParsedResult, ParsedError, ParserPlugin } from "@roo-code/types"
import { stripAnsiCodes } from "../OutputParser"

/** rustc / cargo build: `error[E0425]: cannot find value 'X' in this scope` */
const RUSTC_ERROR_PATTERN = /^(?<severity>error|warning)(?:\[(?<code>[A-Z]\d+)\])?:\s*(?<message>.+)$/gm

/** Location pointer: `  --> file.rs:123:45` */
const LOCATION_PATTERN = /^\s+-->\s+(?<file>.+?):(?<line>\d+):(?<column>\d+)$/gm

/** clippy: `warning: message\n  --> file.rs:123:45\n   = help: suggestion` */
const CLIPPY_HELP_PATTERN = /^\s+=\s+help:\s+(?<message>.+)$/gm

/** cargo test results: `test result: FAILED. 1 passed; 1 failed` */
const CARGO_TEST_PATTERN = /^test result:\s+(?<result>FAILED|ok)\.\s*(?<detail>.+)$/gm

/** cargo: `Compiling`, `error[`, `warning[` at start of line */
const CARGO_COMPILING_PATTERN = /^\s*(?:Compiling|Finished|error|warning)/gm

/**
 * Parse multi-line Rust compiler output to associate error messages
 * with their location pointers.
 *
 * Rust errors have this format:
 * ```
 * error[E0425]: cannot find value 'X' in this scope
 *   --> file.rs:123:45
 *    |
 * ...
 * ```
 *
 * @param combined - ANSI-stripped combined output
 * @param errors - Error array to populate
 * @param warnings - Warning array to populate
 * @param addFn - Deduplicated add function
 */
function parseRustDiagnostics(
	combined: string,
	errors: ParsedError[],
	warnings: ParsedError[],
	seenSignatures: Set<string>,
): void {
	const lines = combined.split("\n")
	const locationMap = new Map<number, { file: string; line: number; column: number }>()

	// First pass: collect all location pointers (--> lines)
	let match: RegExpExecArray | null
	while ((match = LOCATION_PATTERN.exec(combined)) !== null) {
		const file = match.groups!.file
		const line = parseInt(match.groups!.line, 10)
		const column = parseInt(match.groups!.column, 10)
		// Find the line index of this match
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(match[0].trim())) {
				locationMap.set(i, { file, line, column })
				break
			}
		}
	}

	// Second pass: find error/warning lines and associate with location
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const errorMatch = line.match(/^(?<severity>error|warning)(?:\[(?<code>[A-Z]\d+)\])?:\s*(?<message>.+)$/)
		if (!errorMatch) continue

		const severity = errorMatch.groups!.severity as "error" | "warning"
		const code = errorMatch.groups!.code ?? undefined
		const message = errorMatch.groups!.message.trim()
		const raw = line.trim()

		// Look for location in the next few lines
		let file = ""
		let lineNum = 0
		let columnNum: number | undefined
		for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
			if (locationMap.has(j)) {
				const loc = locationMap.get(j)!
				file = loc.file
				lineNum = loc.line
				columnNum = loc.column
				break
			}
		}

		const sig = `${file}:${lineNum}:${columnNum ?? 0}:${message}`
		if (seenSignatures.has(sig)) continue
		seenSignatures.add(sig)

		const entry: ParsedError = {
			file: file || "unknown",
			line: lineNum || 0,
			...(columnNum !== undefined && { column: columnNum }),
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
	}
}

/**
 * Parse clippy-specific help suggestions as warnings.
 */
function parseClippyOutput(combined: string, warnings: ParsedError[], seenSignatures: Set<string>): void {
	let match: RegExpExecArray | null
	while ((match = CLIPPY_HELP_PATTERN.exec(combined)) !== null) {
		const message = match.groups!.message.trim()
		const sig = `clippy:${message}`
		if (seenSignatures.has(sig)) continue
		seenSignatures.add(sig)
		warnings.push({
			file: "",
			line: 0,
			severity: "warning",
			message,
			rule: "clippy",
			raw: match[0].trim(),
		})
	}
}

/**
 * Parse cargo test result lines.
 */
function parseCargoTestOutput(combined: string, errors: ParsedError[], seenSignatures: Set<string>): void {
	let match: RegExpExecArray | null
	while ((match = CARGO_TEST_PATTERN.exec(combined)) !== null) {
		const result = match.groups!.result
		const detail = match.groups!.detail.trim()
		const sig = `test:${result}:${detail}`
		if (seenSignatures.has(sig)) continue
		seenSignatures.add(sig)

		if (result === "FAILED") {
			errors.push({
				file: "",
				line: 0,
				severity: "error",
				message: `Tests FAILED: ${detail}`,
				rule: "cargo-test",
				raw: match[0].trim(),
			})
		}
	}
}

/**
 * Rust compiler/Cargo output parser.
 *
 * Supports parsing output from:
 * - **rustc** / **cargo build**: `error[E0425]: cannot find value 'X' in this scope`
 *   with multi-line format pointing to ` --> file.rs:123:45`
 * - **clippy**: `warning: message` with `--> file.rs:123:45` and `= help: suggestion`
 * - **cargo test**: `test result: FAILED. 1 passed; 1 failed`
 *
 * Extracts file, line, column, severity, message, code (E0425), and rule (clippy).
 */
export const RustParser: ParserPlugin = {
	name: "rust",
	toolPattern: /^(rustc|cargo)\b/,
	language: "rust",

	parse(stdout: string, stderr: string, exitCode?: number): ParsedResult {
		const startTime = Date.now()
		const combined = stripAnsiCodes(stdout + "\n" + stderr)
		const rawOutput = stdout + "\n" + stderr

		const errors: ParsedError[] = []
		const warnings: ParsedError[] = []
		const genericMessages: string[] = []
		const seenSignatures = new Set<string>()
		const lines = combined.split("\n")

		// Parse Rust diagnostics (error/warning with location)
		parseRustDiagnostics(combined, errors, warnings, seenSignatures)

		// Parse clippy help suggestions
		parseClippyOutput(combined, warnings, seenSignatures)

		// Parse cargo test results
		parseCargoTestOutput(combined, errors, seenSignatures)

		// Remaining unmatched lines
		const matchedRaw = new Set<string>()
		for (const diag of [...errors, ...warnings]) {
			matchedRaw.add(diag.raw)
		}
		for (const line of lines) {
			const trimmed = line.trim()
			if (trimmed && !matchedRaw.has(trimmed)) {
				genericMessages.push(trimmed)
			}
		}

		const summary =
			errors.length + warnings.length === 0
				? "No Rust issues found"
				: `${errors.length} error(s), ${warnings.length} warning(s)`

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
