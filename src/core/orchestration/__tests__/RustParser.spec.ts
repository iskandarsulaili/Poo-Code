import { describe, it, expect } from "vitest"

import { RustParser } from "../parsers/RustParser"

describe("RustParser", () => {
	it("should parse cargo build errors", () => {
		const output = [
			"error[E0425]: cannot find value 'someVar' in this scope",
			"  --> src/app.rs:12:5",
			"   |",
			"12 |     let x = someVar;",
			"   |             ^^^^^^^ not found in this scope",
		].join("\n")
		const result = RustParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			code: "E0425",
			message: "cannot find value 'someVar' in this scope",
			file: "src/app.rs",
			line: 12,
			column: 5,
			severity: "error",
		})
	})

	it("should parse rustc error output", () => {
		const output = [
			"error[E0308]: mismatched types",
			"  --> src/main.rs:42:7",
			"   |",
			'42 |     let x: i32 = "hello";',
			"   |             ^^^^^^^^^^^ expected i32, found &str",
		].join("\n")
		const result = RustParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			code: "E0308",
			message: "mismatched types",
			file: "src/main.rs",
			line: 42,
			column: 7,
			severity: "error",
		})
	})

	it("should parse clippy warnings", () => {
		const output = [
			"warning: unused variable `x`",
			"  --> src/app.rs:5:9",
			"   |",
			"5  |     let x = 42;",
			"   |         ^ help: if you don't need the variable, prefix it with an underscore: `_x`",
			"   |",
			"   = note: `#[warn(unused_variables)]` on by default",
			"   = help: use `_x` instead",
		].join("\n")
		const result = RustParser.parse(output, "")
		expect(result.errors).toHaveLength(0)
		expect(result.warnings.length).toBeGreaterThanOrEqual(1)
		expect(result.warnings[0]).toMatchObject({
			message: "unused variable `x`",
			severity: "warning",
			file: "src/app.rs",
			line: 5,
			column: 9,
		})
	})

	it("should parse cargo test results", () => {
		const output = "test result: FAILED. 1 passed; 1 failed"
		const result = RustParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			severity: "error",
			rule: "cargo-test",
			message: expect.stringContaining("FAILED"),
		})
	})

	it("should extract error codes (E0308)", () => {
		const output = ["error[E0308]: mismatched types", "  --> src/main.rs:1:1"].join("\n")
		const result = RustParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].code).toBe("E0308")
	})

	it("should handle empty output", () => {
		const result = RustParser.parse("", "")
		expect(result.errors).toHaveLength(0)
		expect(result.warnings).toHaveLength(0)
	})
})

it("should parse combined error and warning output in single parse", () => {
	const output = [
		"error[E0425]: cannot find value 'someVar' in this scope",
		"  --> src/app.rs:12:5",
		"   |",
		"12 |     let x = someVar;",
		"   |             ^^^^^^^ not found in this scope",
		"warning: unused variable `x`",
		"  --> src/app.rs:5:9",
		"   |",
		"5  |     let x = 42;",
		"   |         ^ help: if you don't need the variable, prefix it with an underscore: `_x`",
	].join("\n")
	const result = RustParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.warnings.length).toBeGreaterThanOrEqual(1)
	expect(result.errors[0].code).toBe("E0425")
	expect(result.warnings[0].severity).toBe("warning")
})

it("should handle multi-line location parsing with location on next line after error", () => {
	const output = ["error[E0308]: mismatched types", "  --> src/main.rs:42:7"].join("\n")
	const result = RustParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.errors[0]).toMatchObject({
		code: "E0308",
		file: "src/main.rs",
		line: 42,
		column: 7,
	})
})

it("should preserve rawOutput in parsed result", () => {
	const output = ["error[E0425]: cannot find value 'someVar' in this scope", "  --> src/app.rs:12:5"].join("\n")
	const result = RustParser.parse(output, "")
	expect(result.rawOutput).toBe(output + "\n")
})

it("should collect generic messages for unmatched lines", () => {
	const output = [
		"   Compiling myproject v0.1.0",
		"error[E0425]: cannot find value 'someVar' in this scope",
		"  --> src/app.rs:12:5",
		"   |",
		"12 |     let x = someVar;",
		"   |             ^^^^^^^ not found in this scope",
		"    Finished dev [unoptimized + debuginfo]",
	].join("\n")
	const result = RustParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.genericMessages.length).toBeGreaterThanOrEqual(1)
	expect(result.genericMessages).toContain("Compiling myproject v0.1.0")
})

it("should handle empty output with no errors or warnings", () => {
	const result = RustParser.parse("", "")
	expect(result.errors).toHaveLength(0)
	expect(result.warnings).toHaveLength(0)
	expect(result.genericMessages).toHaveLength(0)
})
