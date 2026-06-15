import { describe, it, expect } from "vitest"

import { PythonParser } from "../parsers/PythonParser"

describe("PythonParser", () => {
	it("should parse mypy output", () => {
		const output = `src/app.py:42: error: Incompatible return type [return-value]\nsrc/utils.py:10: warning: Unused import [unused-import]`
		const result = PythonParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.warnings).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.py",
			line: 42,
			severity: "error",
			code: "return-value",
			message: "Incompatible return type",
			rule: "mypy",
		})
	})

	it("should parse pylint output", () => {
		const output = `src/app.py:15:3: C0301: Line too long (100/80)`
		const result = PythonParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.py",
			line: 15,
			column: 3,
			code: "C0301",
			message: "Line too long (100/80)",
			rule: "pylint",
		})
	})

	it("should parse flake8 output", () => {
		// Ruff and flake8 use identical line patterns — ruff takes precedence when both match
		const output = `src/app.py:7:1: E302 expected 2 blank lines, found 1`
		const result = PythonParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.py",
			line: 7,
			column: 1,
			code: "E302",
			message: "expected 2 blank lines, found 1",
			rule: "ruff", // ruff pattern is checked first (ruff replaces flake8)
		})
	})

	it("should parse ruff output", () => {
		const output = `src/app.py:5:8: F841 Local variable 'unused' is assigned to but never used`
		const result = PythonParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.py",
			line: 5,
			column: 8,
			code: "F841",
			message: "Local variable 'unused' is assigned to but never used",
			rule: "ruff",
		})
	})

	it("should handle empty output", () => {
		const result = PythonParser.parse("", "")
		expect(result.errors).toHaveLength(0)
		expect(result.warnings).toHaveLength(0)
	})
})

it("should parse pytest output", () => {
	const output =
		"FAILED test_file.py::test_name - AssertionError: assert False\nFAILED test_other.py::test_other - TypeError: unsupported operand"
	const result = PythonParser.parse(output, "")
	expect(result.errors).toHaveLength(2)
	expect(result.errors[0]).toMatchObject({
		file: "test_file.py",
		line: 0,
		severity: "error",
		message: "test_name - AssertionError: assert False",
		rule: "pytest",
	})
	expect(result.errors[1]).toMatchObject({
		file: "test_other.py",
		message: "test_other - TypeError: unsupported operand",
		rule: "pytest",
	})
})

it("should parse mixed tool output (mypy + pylint)", () => {
	const output =
		"src/app.py:42: error: Incompatible return type [return-value]\nsrc/app.py:15:3: C0301: Line too long (100/80)"
	const result = PythonParser.parse(output, "")
	expect(result.errors).toHaveLength(2)
	const mypyError = result.errors.find((e: any) => e.rule === "mypy")
	const pylintError = result.errors.find((e: any) => e.rule === "pylint")
	expect(mypyError).toBeDefined()
	expect(mypyError!.code).toBe("return-value")
	expect(pylintError).toBeDefined()
	expect(pylintError!.code).toBe("C0301")
})

it("should preserve rawOutput in parsed result", () => {
	const output = "src/app.py:42: error: Incompatible return type [return-value]"
	const result = PythonParser.parse(output, "")
	expect(result.rawOutput).toBe(output + "\n")
})

it("should collect generic messages for unmatched lines", () => {
	const output = "Running mypy...\nFound 1 issue\nsrc/app.py:42: error: Incompatible return type [return-value]"
	const result = PythonParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.genericMessages.length).toBeGreaterThanOrEqual(1)
	expect(result.genericMessages).toContain("Running mypy...")
})

it("should handle empty output with no errors or warnings", () => {
	const result = PythonParser.parse("", "")
	expect(result.errors).toHaveLength(0)
	expect(result.warnings).toHaveLength(0)
	expect(result.genericMessages).toHaveLength(0)
})
