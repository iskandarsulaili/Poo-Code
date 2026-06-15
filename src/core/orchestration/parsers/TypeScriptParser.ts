import type { ParsedResult, ParsedError, ParserPlugin } from "@roo-code/types"
import { stripAnsiCodes } from "../OutputParser"

/** Regex: tsc errors — `src/file.ts(123,45): error TS2304: Cannot find name 'X'` */
const TSC_PATTERN =
	/^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s+(?<severity>error|warning)\s+(?<code>TS\d+)\s*:\s*(?<message>.+)$/gm

/** Regex: eslint errors — `file.ts:line:col: error/warning RuleName: message [RuleName]` */
const ESLINT_PATTERN =
	/^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s+(?<severity>error|warning)\s+(?<rule>\S+)\s+(?<message>.+?)(?:\s+\[(?:\w+\/)?[\w-]+\])?$/gm

/** Regex: prettier output — `[warn] file.ts: Code style issue` */
const PRETTIER_PATTERN = /^\[(?<severity>warn|error)\]\s+(?<file>.+?):\s+(?<message>.+)$/gm

/**
 * TypeScript/JavaScript output parser.
 *
 * Parses output from:
 * - **tsc**: `src/file.ts(123,45): error TS2304: Cannot find name 'X'`
 * - **eslint**: `file.ts:1:5: error 'x' is defined but never used [no-unused-vars]`
 * - **prettier**: `[warn] file.ts: Code style issue`
 * - **ts-node**, **tsx**, and other TS tooling
 *
 * Extracts file, line, column, severity, message, code (TS error code),
 * and rule (eslint rule name).
 */
export const TypeScriptParser: ParserPlugin = {
	name: "typescript",
	toolPattern: /^(tsc|eslint|ts-node|tsx)\b/,
	language: "typescript",

	parse(stdout: string, stderr: string, exitCode?: number): ParsedResult {
		const startTime = Date.now()
		const combined = stripAnsiCodes(stdout + "\n" + stderr)
		const rawOutput = stdout + "\n" + stderr

		const errors: ParsedError[] = []
		const warnings: ParsedError[] = []
		const genericMessages: string[] = []
		const seenSignatures = new Set<string>()
		const lines = combined.split("\n")

		/** Add a parsed diagnostic, deduplicating by signature. */
		function addDiagnostic(entry: ParsedError): void {
			const sig = `${entry.file}:${entry.line}:${entry.column ?? 0}:${entry.message}`
			if (seenSignatures.has(sig)) return
			seenSignatures.add(sig)
			if (entry.severity === "warning") {
				warnings.push(entry)
			} else {
				errors.push(entry)
			}
		}

		// 1. Parse tsc output
		let match: RegExpExecArray | null
		while ((match = TSC_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: groups.severity as "error" | "warning",
				message: groups.message.trim(),
				code: groups.code,
				raw: match[0],
			})
		}

		// 2. Parse eslint output
		while ((match = ESLINT_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: groups.severity as "error" | "warning",
				message: groups.message.trim(),
				rule: groups.rule,
				raw: match[0],
			})
		}

		// 3. Parse prettier output
		while ((match = PRETTIER_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			const sev = groups.severity.toLowerCase()
			addDiagnostic({
				file: groups.file,
				line: 0,
				severity: sev === "error" ? "error" : "warning",
				message: groups.message.trim(),
				rule: "prettier",
				raw: match[0],
			})
		}

		// 4. Remaining unmatched lines go to genericMessages
		const matchedRaw = new Set<string>()
		for (const diag of [...errors, ...warnings]) {
			matchedRaw.add(diag.raw)
		}
		for (const line of lines) {
			const trimmed = line.trim()
			if (
				trimmed &&
				!matchedRaw.has(trimmed) &&
				!Array.from(matchedRaw).some((r) => trimmed.includes(r.slice(0, 40)))
			) {
				genericMessages.push(trimmed)
			}
		}

		const errorCount = errors.length
		const warningCount = warnings.length
		const summary =
			errorCount + warningCount === 0
				? "No TypeScript/ESLint issues found"
				: `${errorCount} error(s), ${warningCount} warning(s)`

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
