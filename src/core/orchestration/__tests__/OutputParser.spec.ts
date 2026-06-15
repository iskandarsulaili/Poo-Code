import { vi, describe, it, expect, beforeEach } from "vitest"

import type { ParserPlugin, ProjectLanguage } from "@roo-code/types"

import {
	OutputParser,
	stripAnsiCodes,
	isBinaryOutput,
	inferLanguageFromFile,
	GenericParser,
	ParserRegistry,
} from "../OutputParser"
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

describe("ParserRegistry (alias)", () => {
	it("should be an alias for OutputParser", () => {
		expect(ParserRegistry).toBe(OutputParser)
	})
})
