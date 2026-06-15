import { describe, it, expect } from "vitest"

import { TypeScriptParser } from "../parsers/TypeScriptParser"

describe("TypeScriptParser", () => {
	it("should parse tsc error output", () => {
		const output = `src/app.ts(12,5): error TS2304: Cannot find name 'someVar'\nsrc/utils.ts(3,1): warning TS6192: 'unused' is declared but its value is never read`
		const result = TypeScriptParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.warnings).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.ts",
			line: 12,
			column: 5,
			severity: "error",
			code: "TS2304",
			message: "Cannot find name 'someVar'",
		})
		expect(result.warnings[0]).toMatchObject({
			file: "src/utils.ts",
			line: 3,
			column: 1,
			severity: "warning",
			code: "TS6192",
		})
	})

	it("should parse eslint output", () => {
		const output = `src/app.ts:15:3: error 'x' is assigned a value but never used  [no-unused-vars]\nsrc/utils.ts:1:1: warning 'unused' is defined but never used  [no-unused-vars]`
		const result = TypeScriptParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.warnings).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.ts",
			line: 15,
			column: 3,
			severity: "error",
			rule: "'x'",
			message: "is assigned a value but never used",
		})
	})

	it("should handle empty output", () => {
		const result = TypeScriptParser.parse("", "")
		expect(result.errors).toHaveLength(0)
		expect(result.warnings).toHaveLength(0)
		expect(result.rawOutput).toBe("\n")
	})

	it("should handle output with no errors", () => {
		const output = "Build succeeded\nNo issues found"
		const result = TypeScriptParser.parse(output, "")
		expect(result.errors).toHaveLength(0)
		expect(result.warnings).toHaveLength(0)
		expect(result.summary).toBe("No TypeScript/ESLint issues found")
	})

	it("should extract error codes (TS2345)", () => {
		const output = `src/app.ts(5,22): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'`
		const result = TypeScriptParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].code).toBe("TS2345")
	})

	it("should parse file, line, and column numbers", () => {
		const output = `src/deep/nested/file.ts(42,7): error TS1000: Some error`
		const result = TypeScriptParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].file).toBe("src/deep/nested/file.ts")
		expect(result.errors[0].line).toBe(42)
		expect(result.errors[0].column).toBe(7)
	})
})

it("should parse prettier warning output", () => {
	const output = "[warn] src/file.ts: Code style issue\n[error] src/other.ts: Syntax error"
	const result = TypeScriptParser.parse(output, "")
	expect(result.warnings).toHaveLength(1)
	expect(result.errors).toHaveLength(1)
	expect(result.warnings[0]).toMatchObject({
		file: "src/file.ts",
		line: 0,
		severity: "warning",
		message: "Code style issue",
		rule: "prettier",
	})
	expect(result.errors[0]).toMatchObject({
		file: "src/other.ts",
		line: 0,
		severity: "error",
		message: "Syntax error",
		rule: "prettier",
	})
})

it("should strip ANSI escape codes before parsing", () => {
	const output = "\x1b[31msrc/app.ts(12,5): error TS2304: Cannot find name 'someVar'\x1b[0m"
	const result = TypeScriptParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.errors[0].code).toBe("TS2304")
	expect(result.errors[0].message).toBe("Cannot find name 'someVar'")
})

it("should preserve rawOutput in parsed result", () => {
	const output = "src/app.ts(12,5): error TS2304: Cannot find name 'someVar'"
	const result = TypeScriptParser.parse(output, "")
	expect(result.rawOutput).toBe(output + "\n")
})

it("should collect generic messages for unmatched lines", () => {
	const output =
		"Build started at 10:00\nCompiling modules...\nsrc/app.ts(12,5): error TS2304: Cannot find name 'someVar'\nDone in 2s"
	const result = TypeScriptParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.genericMessages.length).toBeGreaterThanOrEqual(2)
	expect(result.genericMessages).toContain("Build started at 10:00")
	expect(result.genericMessages).toContain("Compiling modules...")
})
