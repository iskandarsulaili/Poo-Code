import type { ParsedResult, ParsedError, ParserPlugin } from "@roo-code/types"
import { stripAnsiCodes } from "../OutputParser"

/** go build / go vet: `file.go:123:45: undefined: X` */
const GO_BUILD_PATTERN = /^(?<file>.+?\.go):(?<line>\d+):(?<column>\d+):\s+(?<message>.+)$/gm

/** golangci-lint: `file.go:123:45: ruleName: message` */
const GOLANGCI_LINT_PATTERN = /^(?<file>.+?\.go):(?<line>\d+):(?<column>\d+):\s+(?<rule>[\w-]+)\s+(?<message>.+)$/gm

/** go test failure: `--- FAIL: TestName` */
const GO_TEST_FAIL_PATTERN = /^---\s+FAIL:\s+(?<message>.+)$/gm

/** go test output: `FAIL` marker */
const GO_TEST_RESULT_PATTERN = /^(ok\s+|FAIL\s+)/gm

/**
 * Go tool output parser.
 *
 * Supports parsing output from:
 * - **go build**: `file.go:123:45: undefined: X`
 * - **go vet**: `file.go:123:45: message`
 * - **golangci-lint**: `file.go:123:45: ruleName: message`
 * - **go test**: `--- FAIL: TestName`
 *
 * Extracts file, line, column, severity, message, and rule.
 */
export const GoParser: ParserPlugin = {
	name: "go",
	toolPattern: /^(go\s+(build|vet|test|run)|golangci-lint)\b/,
	language: "go",

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

		// Track raw lines already matched to avoid double-counting
		const matchedRawLines = new Set<string>()

		let match: RegExpExecArray | null

		// 1. Parse golangci-lint output first (more specific — includes rule name)
		while ((match = GOLANGCI_LINT_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			const raw = match[0]
			matchedRawLines.add(raw)
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "error",
				message: groups.message.trim(),
				rule: groups.rule,
				raw,
			})
		}

		// 2. Parse go build/vet output — skip lines already captured by golangci-lint
		while ((match = GO_BUILD_PATTERN.exec(combined)) !== null) {
			const raw = match[0]
			if (matchedRawLines.has(raw)) continue
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "error",
				message: groups.message.trim(),
				raw,
			})
		}

		// 3. Parse go test failure markers
		while ((match = GO_TEST_FAIL_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: "",
				line: 0,
				severity: "error",
				message: groups.message.trim(),
				rule: "go-test",
				raw: match[0],
			})
		}

		// 4. Remaining unmatched lines
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
				? "No Go issues found"
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
