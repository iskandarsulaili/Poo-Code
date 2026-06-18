import { describe, it, expect } from "vitest"

import { KotlinParser } from "../parsers/KotlinParser"

describe("KotlinParser", () => {
	it("should parse kotlinc output", () => {
		const output = `src/app.kt:12:5 error: unresolved reference 'someRef'\nsrc/utils.kt:3:1 warning: unused variable 'x'`
		const result = KotlinParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.warnings).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.kt",
			line: 12,
			column: 5,
			severity: "error",
			message: "unresolved reference 'someRef'",
			rule: "kotlinc",
		})
	})

	it("should parse Gradle Kotlin compilation errors", () => {
		const output = `e: src/app.kt: (12, 5): Unresolved reference: someRef`
		const result = KotlinParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.kt",
			line: 12,
			column: 5,
			severity: "error",
			message: "Unresolved reference: someRef",
			rule: "gradle",
		})
	})

	it("should handle empty output", () => {
		const result = KotlinParser.parse("", "")
		expect(result.errors).toHaveLength(0)
		expect(result.warnings).toHaveLength(0)
	})

	it("should extract line and column numbers", () => {
		const output = `src/app.kt:42:7 error: syntax error`
		const result = KotlinParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].line).toBe(42)
		expect(result.errors[0].column).toBe(7)
	})
})

it("should parse detekt output", () => {
	const output = "src/app.kt:1:2: [TooManyFunctions] Class has too many functions - reduce complexity"
	const result = KotlinParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.errors[0]).toMatchObject({
		file: "src/app.kt",
		line: 1,
		column: 2,
		severity: "error",
		message: "Class has too many functions - reduce complexity",
		rule: "TooManyFunctions",
	})
})

it("should parse ktlint output", () => {
	const output = "src/app.kt:1:2: Indentation: Unexpected indentation (expected 4, actual 2)"
	const result = KotlinParser.parse(output, "")
	expect(result.warnings).toHaveLength(1)
	expect(result.warnings[0]).toMatchObject({
		file: "src/app.kt",
		line: 1,
		column: 2,
		severity: "warning",
		message: "Unexpected indentation (expected 4, actual 2)",
		rule: "Indentation",
	})
})

it("should detect Gradle BUILD FAILED", () => {
	const output = "> Task :compileKotlin FAILED\nBUILD FAILED in 1s"
	const result = KotlinParser.parse(output, "")
	expect(result.errors.length).toBeGreaterThanOrEqual(1)
	const buildFailed = result.errors.find((e: any) => e.message.includes("BUILD FAILED"))
	expect(buildFailed).toBeDefined()
})

it("should collect generic messages for unmatched lines", () => {
	const output =
		"Starting Gradle Daemon...\nConfigured project\nsrc/app.kt:12:5 error: unresolved reference 'someRef'\nBUILD SUCCESSFUL in 2s"
	const result = KotlinParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.genericMessages.length).toBeGreaterThanOrEqual(2)
	expect(result.genericMessages).toContain("Starting Gradle Daemon...")
	expect(result.genericMessages).toContain("Configured project")
})

it("should preserve rawOutput in parsed result", () => {
	const output = "src/app.kt:12:5 error: unresolved reference 'someRef'"
	const result = KotlinParser.parse(output, "")
	expect(result.rawOutput).toBe(output + "\n")
})
