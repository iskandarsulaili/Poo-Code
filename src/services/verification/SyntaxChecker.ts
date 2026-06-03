import { execFile } from "child_process"
import { promisify } from "util"
import { SyntaxCheckError, SyntaxCheckResult, SyntaxError } from "./types"

const execFileAsync = promisify(execFile)

/**
 * SyntaxChecker — language-specific syntax validation.
 *
 * Supported languages:
 * - Python: uses `python3 -c "compile(...)"` (AST validation)
 * - JSON/JSONC: uses JSON.parse
 * - YAML: uses js-yaml if available
 * - TOML: uses smol-toml or @iarna/toml if available
 *
 * Falls back gracefully when parsers are unavailable.
 */
export class SyntaxChecker {
	/**
	 * Run syntax check on file content.
	 *
	 * @param filePath - Path to the file (used for language detection)
	 * @param content - File content to check
	 * @param language - Optional explicit language override
	 * @returns Syntax check result
	 */
	async check(filePath: string, content: string, language?: string): Promise<SyntaxCheckResult> {
		const lang = language ?? this.detectLanguage(filePath)
		const warnings: string[] = []

		try {
			switch (lang) {
				case "python":
					return await this.checkPython(content, filePath)
				case "json":
					return this.checkJson(content, filePath)
				case "jsonc":
					return this.checkJson(content, filePath, true)
				case "yaml":
					return await this.checkYaml(content, filePath)
				case "toml":
					return await this.checkToml(content, filePath)
				default:
					warnings.push(`No syntax checker available for language: ${lang}`)
					return {
						valid: true,
						errors: [],
						warnings,
						language: lang,
					}
			}
		} catch (err) {
			if (err instanceof SyntaxCheckError) throw err
			throw new SyntaxCheckError(`Syntax check failed for ${filePath}: ${(err as Error).message}`, filePath)
		}
	}

	/**
	 * Detect language from file extension.
	 */
	private detectLanguage(filePath: string): string {
		const ext = filePath.substring(filePath.lastIndexOf("."))
		const langMap: Record<string, string> = {
			".py": "python",
			".json": "json",
			".jsonc": "jsonc",
			".yaml": "yaml",
			".yml": "yaml",
			".toml": "toml",
		}
		return langMap[ext] ?? "unknown"
	}

	/**
	 * Check Python syntax using python3 compile().
	 * This catches syntax errors without executing the code.
	 */
	private async checkPython(content: string, filePath: string): Promise<SyntaxCheckResult> {
		const errors: SyntaxError[] = []

		try {
			// Use python3 -c to compile the source (read from stdin)
			const { stderr } = await execFileAsync(
				"python3",
				[
					"-c",
					`
import sys, ast
source = sys.stdin.read()
try:
    ast.parse(source)
except SyntaxError as e:
    print(f"{e.lineno}:{e.offset}:{e.msg}:{type(e).__name__}")
`,
				],
				{
					input: content,
					timeout: 10_000,
				},
			)

			if (stderr) {
				// Parse python SyntaxError output
				const lines = stderr.trim().split("\n")
				for (const line of lines) {
					const parts = line.split(":")
					if (parts.length >= 3) {
						errors.push({
							line: parseInt(parts[0], 10) || 1,
							column: parseInt(parts[1], 10) || 1,
							message: parts.slice(2, -1).join(":"),
							severity: "error",
							errorCode: parts[parts.length - 1] ?? "SyntaxError",
							source: "python3",
						})
					}
				}
			}
		} catch (err: unknown) {
			const execErr = err as Error & { stderr?: string; stdout?: string }
			// python3 returns non-zero for syntax errors but we capture them in stderr
			if (execErr.stderr) {
				const lines = execErr.stderr.trim().split("\n")
				for (const line of lines) {
					const parts = line.split(":")
					if (parts.length >= 3) {
						errors.push({
							line: parseInt(parts[0], 10) || 1,
							column: parseInt(parts[1], 10) || 1,
							message: parts.slice(2, -1).join(":"),
							severity: "error",
							errorCode: parts[parts.length - 1] ?? "SyntaxError",
							source: "python3",
						})
					}
				}
			} else {
				// If python3 isn't available, try python command
				try {
					return await this.checkPythonFallback(content, filePath)
				} catch {
					throw new SyntaxCheckError(
						`Python syntax check failed: python3 not available and fallback failed. ${execErr.message}`,
						filePath,
					)
				}
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings: [],
			language: "python",
		}
	}

	/**
	 * Fallback Python check using 'python' command instead of 'python3'.
	 */
	private async checkPythonFallback(content: string, filePath: string): Promise<SyntaxCheckResult> {
		const errors: SyntaxError[] = []

		try {
			const { stderr } = await execFileAsync("python", ["-c", "import sys, ast; ast.parse(sys.stdin.read())"], {
				input: content,
				timeout: 10_000,
			})

			if (stderr) {
				const lines = stderr.trim().split("\n")
				for (const line of lines) {
					const match = line.match(/line\s+(\d+)/)
					errors.push({
						line: match ? parseInt(match[1], 10) : 1,
						column: 1,
						message: line,
						severity: "error",
						errorCode: "SyntaxError",
						source: "python",
					})
				}
			}
		} catch (err: unknown) {
			const execErr = err as Error & { stderr?: string }
			if (execErr.stderr) {
				const lines = execErr.stderr.trim().split("\n")
				for (const line of lines) {
					const match = line.match(/line\s+(\d+)/)
					errors.push({
						line: match ? parseInt(match[1], 10) : 1,
						column: 1,
						message: line.replace(/^[^:]+:\d+:/, "").trim(),
						severity: "error",
						errorCode: "SyntaxError",
						source: "python",
					})
				}
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings: [],
			language: "python",
		}
	}

	/**
	 * Check JSON syntax.
	 */
	private checkJson(content: string, filePath: string, allowComments = false): SyntaxCheckResult {
		const errors: SyntaxError[] = []

		try {
			if (allowComments) {
				// JSONC: strip comments before parse
				const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
				JSON.parse(stripped)
			} else {
				JSON.parse(content)
			}
		} catch (err) {
			const parseErr = err as Error
			// Extract position from JSON.parse error message
			const posMatch = parseErr.message.match(/position\s+(\d+)/)
			const lineColMatch = parseErr.message.match(/line\s+(\d+)\s+column\s+(\d+)/)

			let line = 1
			let column = 1

			if (lineColMatch) {
				line = parseInt(lineColMatch[1], 10)
				column = parseInt(lineColMatch[2], 10)
			} else if (posMatch) {
				const pos = parseInt(posMatch[1], 10)
				// Approximate line/column from position
				const before = content.slice(0, pos)
				line = (before.match(/\n/g) || []).length + 1
				const lastNewline = before.lastIndexOf("\n")
				column = pos - lastNewline
			}

			errors.push({
				line,
				column,
				message: parseErr.message,
				severity: "error",
				errorCode: "JSON_PARSE_ERROR",
				source: "json",
			})
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings: [],
			language: allowComments ? "jsonc" : "json",
		}
	}

	/**
	 * Check YAML syntax using js-yaml (dynamic import).
	 */
	private async checkYaml(content: string, filePath: string): Promise<SyntaxCheckResult> {
		const errors: SyntaxError[] = []
		let warnings: string[] = []

		try {
			const yaml = await import("js-yaml")
			yaml.load(content, { filename: filePath })
		} catch (err: unknown) {
			const yamlErr = err as Error
			if (yamlErr.message.includes("Cannot find module")) {
				warnings = ["js-yaml not available; install with: npm install js-yaml"]
				return { valid: true, errors: [], warnings, language: "yaml" }
			}

			// Parse line number from js-yaml error messages
			const lineMatch = yamlErr.message.match(/line\s+(\d+)/i)
			const colMatch = yamlErr.message.match(/column\s+(\d+)/i)

			errors.push({
				line: lineMatch ? parseInt(lineMatch[1], 10) : 1,
				column: colMatch ? parseInt(colMatch[1], 10) : 1,
				message: yamlErr.message,
				severity: "error",
				errorCode: "YAML_PARSE_ERROR",
				source: "js-yaml",
			})
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
			language: "yaml",
		}
	}

	/**
	 * Check TOML syntax using smol-toml (dynamic import, with fallback to @iarna/toml).
	 */
	private async checkToml(content: string, filePath: string): Promise<SyntaxCheckResult> {
		const errors: SyntaxError[] = []
		let warnings: string[] = []

		try {
			// Try smol-toml first (preferred)
			const toml = await import("smol-toml")
			toml.parse(content)
		} catch (err: unknown) {
			const tomlErr = err as Error

			if (tomlErr.message.includes("Cannot find module")) {
				// Fallback to @iarna/toml
				try {
					const toml2 = await import("@iarna/toml")
					toml2.parse(content)
				} catch (err2: unknown) {
					const tomlErr2 = err2 as Error
					if (tomlErr2.message.includes("Cannot find module")) {
						warnings = ["No TOML parser available; install smol-toml or @iarna/toml"]
						return { valid: true, errors: [], warnings, language: "toml" }
					}
					errors.push({
						line: 1,
						column: 1,
						message: tomlErr2.message,
						severity: "error",
						errorCode: "TOML_PARSE_ERROR",
						source: "@iarna/toml",
					})
				}
			} else {
				const lineMatch = tomlErr.message.match(/line\s+(\d+)/i)
				const colMatch = tomlErr.message.match(/column\s+(\d+)/i)

				errors.push({
					line: lineMatch ? parseInt(lineMatch[1], 10) : 1,
					column: colMatch ? parseInt(colMatch[1], 10) : 1,
					message: tomlErr.message,
					severity: "error",
					errorCode: "TOML_PARSE_ERROR",
					source: "smol-toml",
				})
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
			language: "toml",
		}
	}
}
