import type { ParsedResult, ParsedError, ParserPlugin } from "@roo-code/types"
import { stripAnsiCodes } from "../OutputParser"

// Regex patterns for Python tool output — ordered by specificity

/** mypy: `file.py:123: error: Incompatible return type [return-value]` */
const MYPY_PATTERN =
	/^(?<file>.+?):(?<line>\d+):\s+(?<severity>error|warning):\s+(?<message>.+?)(?:\s+\[(?<code>[\w-]+)\])?$/gm

/** pylint: `file.py:line:col: C0301: Line too long` */
const PYLINT_PATTERN = /^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s+(?<code>[A-Z]\d+):\s+(?<message>.+)$/gm

/** flake8: `file.py:line:col: E123: indentation error` */
const FLAKE8_PATTERN = /^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s+(?<code>[A-Z]\d+)\s+(?<message>.+)$/gm

/** ruff: `file.py:line:col: F841 Local variable is assigned but never used` */
const RUFF_PATTERN = /^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s+(?<code>[A-Z]\d+)\s+(?<message>.+)$/gm

/** pytest: `FAILED file.py::test_name - AssertionError: message` */
const PYTEST_PATTERN = /^FAILED\s+(?<file>.+?)::(?<message>.+)$/gm

/**
 * Python tool output parser.
 *
 * Supports parsing output from:
 * - **mypy**: `file.py:123: error: Incompatible return type [return-value]`
 * - **pylint**: `file.py:line:col: C0301: Line too long`
 * - **flake8**: `file.py:line:col: E123 indentation error`
 * - **ruff**: `file.py:line:col: F841 Local variable is assigned but never used`
 * - **pytest**: `FAILED file.py::test_name - AssertionError: message`
 *
 * Extracts file, line, column, severity, message, code, and rule.
 */
export const PythonParser: ParserPlugin = {
	name: "python",
	toolPattern: /^(python|python3|mypy|pylint|flake8|ruff|pytest)\b/,
	language: "python",

	parse(stdout: string, stderr: string, exitCode?: number): ParsedResult {
		const startTime = Date.now()
		const combined = stripAnsiCodes(stdout + "\n" + stderr)
		const rawOutput = stdout + "\n" + stderr

		const errors: ParsedError[] = []
		const warnings: ParsedError[] = []
		const genericMessages: string[] = []
		const seenSignatures = new Set<string>()

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

		let match: RegExpExecArray | null

		// 1. Parse mypy output
		while ((match = MYPY_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				severity: groups.severity as "error" | "warning",
				message: groups.message.trim(),
				code: groups.code ?? undefined,
				rule: "mypy",
				raw: match[0],
			})
		}

		// 2. Parse pylint output
		while ((match = PYLINT_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "error",
				message: groups.message.trim(),
				code: groups.code,
				rule: "pylint",
				raw: match[0],
			})
		}

		// Track matched raw lines to avoid double-counting between flake8/ruff (identical patterns)
		const matchedRaw = new Set<string>()

		// 3. Parse ruff output first (ruff is newer, takes precedence over flake8)
		while ((match = RUFF_PATTERN.exec(combined)) !== null) {
			const raw = match[0]
			matchedRaw.add(raw)
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "error",
				message: groups.message.trim(),
				code: groups.code,
				rule: "ruff",
				raw,
			})
		}

		// 4. Parse flake8 output — skip lines already captured by ruff
		while ((match = FLAKE8_PATTERN.exec(combined)) !== null) {
			const raw = match[0]
			if (matchedRaw.has(raw)) continue
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "error",
				message: groups.message.trim(),
				code: groups.code,
				rule: "flake8",
				raw,
			})
		}

		// 5. Parse pytest output
		while ((match = PYTEST_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: 0,
				severity: "error",
				message: groups.message.trim(),
				rule: "pytest",
				raw: match[0],
			})
		}

		// 6. Remaining unmatched lines
		const matchedGenericRaw = new Set<string>()
		for (const diag of [...errors, ...warnings]) {
			matchedGenericRaw.add(diag.raw)
		}
		const lines = combined.split("\n")
		for (const line of lines) {
			const trimmed = line.trim()
			if (trimmed && !matchedGenericRaw.has(trimmed)) {
				genericMessages.push(trimmed)
			}
		}

		const summary =
			errors.length + warnings.length === 0
				? "No Python issues found"
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
