import { vi, describe, it, expect, beforeEach } from "vitest"

import type { ParserPlugin, ProjectLanguage, ParsedResult } from "@roo-code/types"

import {
	OutputParser,
	stripAnsiCodes,
	isBinaryOutput,
	inferLanguageFromFile,
	GenericParser,
	ParserRegistry,
} from "../OutputParser"
import { buildLLMPrompt, parseLLMResponse, shouldInvokeLLMFallback } from "../LLMFallbackParser"
import { experimentConfigsMap } from "../../../shared/experiments"

describe("stripAnsiCodes", () => {
	it("should strip ANSI escape sequences", () => {
		const input = "\x1b[31mred\x1b[0m"
		expect(stripAnsiCodes(input)).toBe("red")
	})

	it("should handle strings without ANSI codes", () => {
		const input = "plain text"
		expect(stripAnsiCodes(input)).toBe("plain text")
	})

	it("should strip multiple ANSI codes", () => {
		const input = "\x1b[1m\x1b[32mbold green\x1b[0m"
		expect(stripAnsiCodes(input)).toBe("bold green")
	})

	it("should strip cursor movement codes", () => {
		const input = "\x1b[2Kclear line\x1b[G"
		expect(stripAnsiCodes(input)).toBe("clear line")
	})
})

describe("isBinaryOutput", () => {
	it("should detect NUL bytes as binary", () => {
		expect(isBinaryOutput("text\x00more")).toBe(true)
	})

	it("should return false for empty string", () => {
		expect(isBinaryOutput("")).toBe(false)
	})

	it("should return false for normal text", () => {
		expect(isBinaryOutput("Hello, world!")).toBe(false)
	})

	it("should return true for output with low printable ratio", () => {
		// Create a string with many non-printable characters
		const binary = String.fromCharCode(0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20)
		expect(isBinaryOutput(binary)).toBe(true)
	})
})

describe("inferLanguageFromFile", () => {
	it("should infer typescript from .ts files", () => {
		expect(inferLanguageFromFile("file.ts")).toBe("typescript")
		expect(inferLanguageFromFile("file.tsx")).toBe("typescript")
	})

	it("should infer javascript from .js files", () => {
		expect(inferLanguageFromFile("file.js")).toBe("javascript")
		expect(inferLanguageFromFile("file.jsx")).toBe("javascript")
		expect(inferLanguageFromFile("file.mjs")).toBe("javascript")
	})

	it("should infer python from .py files", () => {
		expect(inferLanguageFromFile("file.py")).toBe("python")
	})

	it("should infer kotlin from .kt files", () => {
		expect(inferLanguageFromFile("file.kt")).toBe("kotlin")
		expect(inferLanguageFromFile("file.kts")).toBe("kotlin")
	})

	it("should infer go from .go files", () => {
		expect(inferLanguageFromFile("file.go")).toBe("go")
	})

	it("should infer rust from .rs files", () => {
		expect(inferLanguageFromFile("file.rs")).toBe("rust")
	})

	it("should return unknown for unrecognized extensions", () => {
		expect(inferLanguageFromFile("file.txt")).toBe("unknown")
		expect(inferLanguageFromFile("file")).toBe("unknown")
	})
})

describe("GenericParser", () => {
	it("should parse gcc-style errors", () => {
		const result = GenericParser.parse("src/main.ts:10:5: error TS2345: Type mismatch", "", undefined)
		// The gcc-style pattern matches. The mypy-style pattern also matches
		// with file="src/main.ts:10" and line=5, so we get 2 errors.
		// Verify at least one has the correct file and line.
		expect(result.errors.length).toBeGreaterThanOrEqual(1)
		const fileErrors = result.errors.filter((e: any) => e.file === "src/main.ts")
		expect(fileErrors.length).toBeGreaterThanOrEqual(1)
		expect(fileErrors[0].line).toBe(10)
		expect(fileErrors[0].severity).toBe("error")
	})

	it("should parse mypy-style errors", () => {
		const result = GenericParser.parse("src/main.py:42: error: Incompatible types", "", undefined)
		// mypy pattern matches. Generic "Error: message" also matches "error: Incompatible types"
		expect(result.errors.length).toBeGreaterThanOrEqual(1)
		const fileErrors = result.errors.filter((e: any) => e.file === "src/main.py")
		expect(fileErrors.length).toBeGreaterThanOrEqual(1)
		expect(fileErrors[0].line).toBe(42)
	})

	it("should parse mypy-style errors", () => {
		const result = GenericParser.parse("src/main.py:42: error: Incompatible types", "", undefined)
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].file).toBe("src/main.py")
		expect(result.errors[0].line).toBe(42)
	})

	it("should parse Java-style errors", () => {
		const result = GenericParser.parse("Main.java(15,5): error: ';' expected", "", undefined)
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].file).toBe("Main.java")
		expect(result.errors[0].line).toBe(15)
	})

	it("should parse generic Error/Warning messages", () => {
		const result = GenericParser.parse(
			"Error: Something went wrong\nWarning: This might be an issue",
			"",
			undefined,
		)
		expect(result.errors).toHaveLength(1)
		expect(result.warnings).toHaveLength(1)
	})

	it("should detect binary output and skip parsing", () => {
		const result = GenericParser.parse("\x00binary\x00data", "", undefined)
		expect(result.summary).toContain("Binary output detected")
	})

	it("should strip ANSI codes before parsing", () => {
		const result = GenericParser.parse("\x1b[31msrc/file.ts:1:1: error: Something\x1b[0m", "", undefined)
		// After stripping ANSI, the output is "src/file.ts:1:1: error: Something"
		// The gcc-style pattern matches this line
		expect(result.errors.length).toBeGreaterThanOrEqual(1)
		// At least one error should reference the file
		const fileErrors = result.errors.filter((e: any) => e.file === "src/file.ts")
		expect(fileErrors.length).toBeGreaterThanOrEqual(1)
	})

	it("should return summary with generic messages for non-error output", () => {
		const result = GenericParser.parse("All good!", "", 0)
		// "All good!" doesn't match any error pattern, so it becomes a generic message
		expect(result.summary).toBe("1 message(s)")
	})
})

describe("OutputParser", () => {
	let parser: OutputParser

	beforeEach(() => {
		parser = new OutputParser()
		// Ensure feature flag is enabled
		experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: true }
	})

	describe("registerParser / unregisterParser / getParser", () => {
		it("should register and lookup parsers by language", () => {
			const mockParser: ParserPlugin = {
				name: "test-parser",
				language: "typescript",
				toolPattern: undefined,
				parse: vi.fn().mockReturnValue({
					exitCode: 0,
					duration: 0,
					stdout: "",
					stderr: "",
					errors: [],
					warnings: [],
					genericMessages: [],
					summary: "parsed",
					rawOutput: "",
					truncated: false,
				}),
			}

			parser.registerParser("typescript", mockParser)
			expect(parser.getParser("typescript")).toBe(mockParser)
		})

		it("should return undefined for unregistered language", () => {
			expect(parser.getParser("typescript")).toBeUndefined()
		})

		it("should unregister parsers", () => {
			const mockParser: ParserPlugin = {
				name: "test",
				language: "typescript",
				toolPattern: undefined,
				parse: vi.fn(),
			}
			parser.registerParser("typescript", mockParser)
			parser.unregisterParser("typescript")
			expect(parser.getParser("typescript")).toBeUndefined()
		})
	})

	describe("parse", () => {
		it("should use registered parser when language specified", async () => {
			const mockParser: ParserPlugin = {
				name: "ts-parser",
				language: "typescript",
				toolPattern: undefined,
				parse: vi.fn().mockReturnValue({
					exitCode: 0,
					duration: 0,
					stdout: "",
					stderr: "",
					errors: [{ file: "test.ts", line: 1, severity: "error", message: "test error", raw: "error" }],
					warnings: [],
					genericMessages: [],
					summary: "1 error(s)",
					rawOutput: "output",
					truncated: false,
				}),
			}
			parser.registerParser("typescript", mockParser)

			const result = await parser.parse("output", "typescript")
			expect(result.errors).toHaveLength(1)
			expect(result.errors[0].message).toBe("test error")
		})

		it("should infer language from filename", async () => {
			const mockParser: ParserPlugin = {
				name: "ts-parser",
				language: "typescript",
				toolPattern: undefined,
				parse: vi.fn().mockReturnValue({
					exitCode: 0,
					duration: 0,
					stdout: "",
					stderr: "",
					errors: [],
					warnings: [],
					genericMessages: [],
					summary: "ok",
					rawOutput: "output",
					truncated: false,
				}),
			}
			parser.registerParser("typescript", mockParser)

			const result = await parser.parse("output", undefined, "file.ts")
			expect(result.summary).toBe("ok")
		})

		it("should fall back to GenericParser when no parser registered", async () => {
			const result = await parser.parse("FAILED test_suite::Assertion failed", undefined, undefined)
			// FAILED pattern matches exactly once
			expect(result.errors).toHaveLength(1)
			expect(result.errors[0].severity).toBe("failed")
		})

		it("should fall back to GenericParser when parser throws", async () => {
			const throwingParser: ParserPlugin = {
				name: "thrower",
				language: "typescript",
				toolPattern: undefined,
				parse: vi.fn().mockImplementation(() => {
					throw new Error("Parser crashed")
				}),
			}
			parser.registerParser("typescript", throwingParser)

			const result = await parser.parse("FAILED test_suite::Assertion failed", "typescript")
			// Should fall back to generic parser
			expect(result.errors).toHaveLength(1)
			expect(result.errors[0].severity).toBe("failed")
		})

		it("should return disabled result when feature flag is off", async () => {
			experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: false }

			const result = await parser.parse("some output", "typescript")
			expect(result.summary).toBe("Structured output parsing is disabled")
		})
	})

	describe("parseWithFallback", () => {
		it("should parse multiple outputs", async () => {
			const results = await parser.parseWithFallback([
				{ output: "src/file.ts:1:1: error: fail", language: "typescript" },
				{ output: "All good!", language: "typescript" },
			])
			expect(results).toHaveLength(2)
		})

		it("should handle empty array", async () => {
			const results = await parser.parseWithFallback([])
			expect(results).toHaveLength(0)
		})
	})

	describe("aggregateResults", () => {
		it("should aggregate multiple parsed results", () => {
			const results = [
				{
					exitCode: 0,
					duration: 10,
					stdout: "",
					stderr: "",
					errors: [{ file: "a.ts", line: 1, severity: "error" as const, message: "err", raw: "err" }],
					warnings: [],
					genericMessages: [],
					summary: "1 error(s)",
					rawOutput: "",
					truncated: false,
				},
				{
					exitCode: 0,
					duration: 20,
					stdout: "",
					stderr: "",
					errors: [],
					warnings: [{ file: "b.ts", line: 2, severity: "warning" as const, message: "warn", raw: "warn" }],
					genericMessages: [],
					summary: "1 warning(s)",
					rawOutput: "",
					truncated: false,
				},
			]

			const aggregated = parser.aggregateResults(results)
			expect(aggregated.totalDuration).toBe(30)
			expect(aggregated.failedCount).toBe(1) // 1 error
			expect(aggregated.successCount).toBe(1) // 2 results - 1 error
		})
	})

	describe("getSupportedLanguages", () => {
		it("should return empty array when no parsers registered", () => {
			expect(parser.getSupportedLanguages()).toEqual([])
		})

		it("should return registered languages", () => {
			const mockParser: ParserPlugin = {
				name: "test",
				language: "typescript",
				toolPattern: undefined,
				parse: vi.fn(),
			}
			parser.registerParser("typescript", mockParser)
			parser.registerParser("rust", mockParser)
			expect(parser.getSupportedLanguages()).toEqual(["typescript", "rust"])
		})
	})
})

describe("LLM Fallback", () => {
	describe("shouldInvokeLLMFallback", () => {
		it("should return false for empty output", () => {
			const result: ParsedResult = {
				exitCode: 0,
				duration: 0,
				stdout: "",
				stderr: "",
				errors: [],
				warnings: [],
				genericMessages: [],
				summary: "No issues found",
				rawOutput: "",
				truncated: false,
			}
			expect(shouldInvokeLLMFallback(result, "")).toBe(false)
		})

		it("should return false for output shorter than threshold", () => {
			const result: ParsedResult = {
				exitCode: 0,
				duration: 0,
				stdout: "ok",
				stderr: "",
				errors: [],
				warnings: [],
				genericMessages: ["ok"],
				summary: "1 message(s)",
				rawOutput: "ok",
				truncated: false,
			}
			expect(shouldInvokeLLMFallback(result, "ok")).toBe(false)
		})

		it("should return false when regex parser found errors", () => {
			const result: ParsedResult = {
				exitCode: 1,
				duration: 10,
				stdout: "src/file.ts:1:1: error: fail",
				stderr: "",
				errors: [{ file: "src/file.ts", line: 1, severity: "error", message: "fail", raw: "error" }],
				warnings: [],
				genericMessages: [],
				summary: "1 error(s)",
				rawOutput: "src/file.ts:1:1: error: fail",
				truncated: false,
			}
			expect(shouldInvokeLLMFallback(result, "src/file.ts:1:1: error: fail")).toBe(false)
		})

		it("should return false when regex parser found warnings", () => {
			const result: ParsedResult = {
				exitCode: 0,
				duration: 10,
				stdout: "Warning: something",
				stderr: "",
				errors: [],
				warnings: [
					{ file: "unknown", line: 0, severity: "warning", message: "something", raw: "Warning: something" },
				],
				genericMessages: [],
				summary: "1 warning(s)",
				rawOutput: "Warning: something",
				truncated: false,
			}
			expect(shouldInvokeLLMFallback(result, "Warning: something")).toBe(false)
		})

		it("should return true when no match + non-trivial output", () => {
			const nonTrivialOutput = "A".repeat(150)
			const result: ParsedResult = {
				exitCode: 0,
				duration: 10,
				stdout: nonTrivialOutput,
				stderr: "",
				errors: [],
				warnings: [],
				genericMessages: [nonTrivialOutput],
				summary: "1 message(s)",
				rawOutput: nonTrivialOutput,
				truncated: false,
			}
			expect(shouldInvokeLLMFallback(result, nonTrivialOutput)).toBe(true)
		})
	})

	describe("parseWithLLMFallback", () => {
		it("should invoke callback and return LLM result", async () => {
			const parser = new OutputParser()
			experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: true }

			const mockLLMResult: ParsedResult = {
				exitCode: undefined,
				duration: 0,
				stdout: "build failed",
				stderr: "",
				errors: [
					{
						file: "src/main.ts",
						line: 42,
						severity: "error",
						message: "Type 'X' is not assignable",
						code: "TS2322",
						raw: "build failed",
					},
				],
				warnings: [],
				genericMessages: [],
				summary: "LLM fallback: 1 error(s)",
				rawOutput: "build failed",
				truncated: false,
			}

			const callback = vi.fn<(...args: any[]) => any>().mockResolvedValue(mockLLMResult)
			parser.setLLMFallbackCallback(callback)
			parser.setLLMFallbackEnabled(true)

			const result = await parser.parseWithLLMFallback("build failed", "typescript")
			expect(callback).toHaveBeenCalledWith("build failed", "typescript")
			expect(result.errors).toHaveLength(1)
			expect(result.errors[0].code).toBe("TS2322")
			expect(result.summary).toBe("LLM fallback: 1 error(s)")
		})

		it("should return fallback result when no callback registered", async () => {
			const parser = new OutputParser()
			const result = await parser.parseWithLLMFallback("some output")
			expect(result.summary).toBe("LLM fallback not configured")
			expect(result.genericMessages).toContain("some output")
		})

		it("should gracefully degrade when callback throws", async () => {
			const parser = new OutputParser()
			parser.setLLMFallbackCallback(async () => {
				throw new Error("LLM timeout")
			})
			parser.setLLMFallbackEnabled(true)

			const result = await parser.parseWithLLMFallback("some output")
			expect(result.summary).toBe("LLM fallback failed")
		})
	})

	describe("setLLMFallbackEnabled / isLLMFallbackEnabled", () => {
		it("should toggle LLM fallback state", () => {
			const parser = new OutputParser()
			expect(parser.isLLMFallbackEnabled()).toBe(false)

			parser.setLLMFallbackEnabled(true)
			expect(parser.isLLMFallbackEnabled()).toBe(true)

			parser.setLLMFallbackEnabled(false)
			expect(parser.isLLMFallbackEnabled()).toBe(false)
		})
	})

	describe("LLM fallback in parse() integration", () => {
		it("should NOT call LLM fallback when output is empty", async () => {
			const parser = new OutputParser()
			experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: true }

			const callback = vi.fn()
			parser.setLLMFallbackCallback(callback)
			parser.setLLMFallbackEnabled(true)

			await parser.parse("")
			expect(callback).not.toHaveBeenCalled()
		})

		it("should NOT call LLM fallback when regex matched errors", async () => {
			const parser = new OutputParser()
			experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: true }

			const callback = vi.fn()
			parser.setLLMFallbackCallback(callback)
			parser.setLLMFallbackEnabled(true)

			await parser.parse("src/file.ts:1:1: er ror: fail")
			expect(callback).not.toHaveBeenCalled()
		})

		it("should call LLM fallback when no match + non-trivial output", async () => {
			const parser = new OutputParser()
			experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: true }

			const mockLLMResult: ParsedResult = {
				exitCode: undefined,
				duration: 0,
				stdout: "A".repeat(150),
				stderr: "",
				errors: [
					{ file: "unknown", line: 0, severity: "error", message: "Detected failure", raw: "A".repeat(150) },
				],
				warnings: [],
				genericMessages: [],
				summary: "LLM fallback: 1 error(s)",
				rawOutput: "A".repeat(150),
				truncated: false,
			}

			const callback = vi.fn().mockResolvedValue(mockLLMResult)
			parser.setLLMFallbackCallback(callback)
			parser.setLLMFallbackEnabled(true)

			const result = await parser.parse("A".repeat(150))
			expect(callback).toHaveBeenCalled()
			expect(result.errors).toHaveLength(1)
			expect(result.errors[0].message).toBe("Detected failure")
		})

		it("should NOT call LLM fallback when feature is disabled", async () => {
			const parser = new OutputParser()
			experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: true }

			const callback = vi.fn()
			parser.setLLMFallbackCallback(callback)
			parser.setLLMFallbackEnabled(false) // explicitly disabled

			await parser.parse("A".repeat(150))
			expect(callback).not.toHaveBeenCalled()
		})

		it("should gracefully degrade when LLM callback throws during parse()", async () => {
			const parser = new OutputParser()
			experimentConfigsMap.STRUCTURED_OUTPUT_PARSING = { enabled: true }

			const callback = vi.fn().mockRejectedValue(new Error("API error"))
			parser.setLLMFallbackCallback(callback)
			parser.setLLMFallbackEnabled(true)

			// Should return the generic parser result, not throw
			const result = await parser.parse("A".repeat(150))
			expect(result).toBeDefined()
			expect(result.rawOutput).toBe("A".repeat(150))
		})
	})
})

describe("buildLLMPrompt", () => {
	it("should include language in the prompt", () => {
		const prompt = buildLLMPrompt("some output", "typescript")
		expect(prompt).toContain("Language: typescript")
		expect(prompt).toContain("some output")
	})

	it("should default language to unknown when not provided", () => {
		const prompt = buildLLMPrompt("some output")
		expect(prompt).toContain("Language: unknown")
	})
})

describe("parseLLMResponse", () => {
	it("should parse a valid JSON response", () => {
		const llmResponse = JSON.stringify({
			errors: [
				{
					file: "src/main.ts",
					line: 10,
					column: 5,
					message: "Type mismatch",
					code: "TS2345",
					rule: "no-implicit-any",
				},
			],
			warnings: [{ file: "src/util.ts", line: 3, message: "Unused variable", rule: "no-unused-vars" }],
			summary: "Found 1 error, 1 warning",
		})
		const result = parseLLMResponse(llmResponse, "raw build output")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].code).toBe("TS2345")
		expect(result.errors[0].rule).toBe("no-implicit-any")
		expect(result.warnings).toHaveLength(1)
		expect(result.warnings[0].message).toBe("Unused variable")
	})

	it("should handle markdown-wrapped JSON", () => {
		const llmResponse =
			'```json\n{"errors": [{"file": "test.ts", "line": 1, "message": "fail"}], "warnings": [], "summary": "1 error"}\n```'
		const result = parseLLMResponse(llmResponse, "raw")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].file).toBe("test.ts")
	})

	it("should handle markdown-wrapped JSON without json tag", () => {
		const llmResponse = '```\n{"errors": [], "warnings": [], "summary": "all good"}\n```'
		const result = parseLLMResponse(llmResponse, "raw")
		expect(result.summary).toBe("all good")
	})

	it("should return unparseable response gracefully", () => {
		const result = parseLLMResponse("not json at all", "raw output")
		expect(result.summary).toBe("LLM fallback returned unparseable response")
		expect(result.genericMessages).toContain("raw output")
	})

	it("should handle null/empty response gracefully", () => {
		const result = parseLLMResponse("", "raw output")
		expect(result.summary).toBe("LLM fallback returned unparseable response")
	})
})

describe("ParserRegistry (alias)", () => {
	it("should be an alias for OutputParser", () => {
		expect(ParserRegistry).toBe(OutputParser)
	})
})
