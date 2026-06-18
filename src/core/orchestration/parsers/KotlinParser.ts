import type { ParsedResult, ParsedError, ParserPlugin } from "@roo-code/types"
import { stripAnsiCodes } from "../OutputParser"

/** kotlinc: `file.kt:123:45 error: unresolved reference X` */
const KOTLINC_PATTERN =
	/^(?<file>.+?\.kts?):(?<line>\d+):(?<column>\d+)\s+(?<severity>error|warning):\s*(?<message>.+)$/gm

/** Gradle: `e: file.kt: (123, 45): message` */
const GRADLE_PATTERN = /^e:\s+(?<file>.+?\.kts?):\s+\((?<line>\d+),\s*(?<column>\d+)\):\s+(?<message>.+)$/gm

/** Gradle: `> Task :compileKotlin FAILED\nfile.kt:123: error: message` */
const GRADLE_TASK_PATTERN = /^>\s+Task\s+:.+?\s+FAILED$/gm

/** detekt: `file.kt:123:45: [RuleName] TooManyFunctions - message` */
const DETEKT_PATTERN = /^(?<file>.+?\.kts?):(?<line>\d+):(?<column>\d+):\s+\[(?<rule>\w+)\]\s+(?<message>.+)$/gm

/** ktlint: `file.kt:123:45: RuleName: message` */
const KTLINT_PATTERN = /^(?<file>.+?\.kts?):(?<line>\d+):(?<column>\d+):\s+(?<rule>\w[\w-]*):\s+(?<message>.+)$/gm

/** Gradle build failed marker: `BUILD FAILED` */
const BUILD_FAILED_PATTERN = /^(BUILD FAILED|BUILD SUCCESSFUL)/gm

/**
 * Kotlin tool output parser.
 *
 * Supports parsing output from:
 * - **kotlinc**: `file.kt:123:45 error: unresolved reference X`
 * - **Gradle**: `e: file.kt: (123, 45): message` and `> Task :compileKotlin FAILED`
 * - **detekt**: `file.kt:123:45: [RuleName] TooManyFunctions - message`
 * - **ktlint**: `file.kt:123:45: RuleName: message`
 *
 * Extracts file, line, column, severity, message, and rule.
 */
export const KotlinParser: ParserPlugin = {
	name: "kotlin",
	toolPattern: /^(kotlinc|gradle|gradlew|\.\/gradlew)\b/,
	language: "kotlin",

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

		let match: RegExpExecArray | null

		// 1. Parse kotlinc output
		while ((match = KOTLINC_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: groups.severity as "error" | "warning",
				message: groups.message.trim(),
				rule: "kotlinc",
				raw: match[0],
			})
		}

		// 2. Parse Gradle Kotlin compilation errors
		while ((match = GRADLE_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "error",
				message: groups.message.trim(),
				rule: "gradle",
				raw: match[0],
			})
		}

		// 3. Parse detekt output
		while ((match = DETEKT_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "error",
				message: groups.message.trim(),
				rule: groups.rule,
				raw: match[0],
			})
		}

		// 4. Parse ktlint output
		while ((match = KTLINT_PATTERN.exec(combined)) !== null) {
			const groups = match.groups!
			addDiagnostic({
				file: groups.file,
				line: parseInt(groups.line, 10),
				column: parseInt(groups.column, 10),
				severity: "warning",
				message: groups.message.trim(),
				rule: groups.rule,
				raw: match[0],
			})
		}

		// 5. Look for Gradle FAILED task lines — add as generic errors
		while ((match = GRADLE_TASK_PATTERN.exec(combined)) !== null) {
			addDiagnostic({
				file: "",
				line: 0,
				severity: "error",
				message: match[0].trim(),
				rule: "gradle",
				raw: match[0],
			})
		}

		// 6. Look for BUILD FAILED / BUILD SUCCESSFUL markers
		while ((match = BUILD_FAILED_PATTERN.exec(combined)) !== null) {
			const msg = match[0].trim()
			if (msg.startsWith("BUILD FAILED")) {
				addDiagnostic({
					file: "",
					line: 0,
					severity: "error",
					message: msg,
					rule: "gradle",
					raw: match[0],
				})
			}
		}

		// 7. Remaining unmatched lines
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
				? "No Kotlin issues found"
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
