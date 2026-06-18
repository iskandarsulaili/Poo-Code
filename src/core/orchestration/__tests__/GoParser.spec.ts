import { describe, it, expect } from "vitest"

import { GoParser } from "../parsers/GoParser"

describe("GoParser", () => {
	it("should parse go build errors", () => {
		const output = `src/app.go:12:5: undefined: someFunc`
		const result = GoParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.go",
			line: 12,
			column: 5,
			severity: "error",
			message: "undefined: someFunc",
		})
	})

	it("should parse go vet output", () => {
		// go vet uses the same file:line:col: message format as go build
		const output = `src/app.go:42:7: unreachable code`
		const result = GoParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.go",
			line: 42,
			column: 7,
			severity: "error",
		})
		expect(result.errors[0].message.length).toBeGreaterThan(0)
	})

	it("should parse golangci-lint output", () => {
		const output = `src/app.go:15:2: unusedFunction  function is unused`
		const result = GoParser.parse(output, "")
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]).toMatchObject({
			file: "src/app.go",
			line: 15,
			column: 2,
			severity: "error",
			rule: "unusedFunction",
			message: "function is unused",
		})
	})

	it("should handle empty output", () => {
		const result = GoParser.parse("", "")
		expect(result.errors).toHaveLength(0)
		expect(result.warnings).toHaveLength(0)
	})
})

it("should parse go test FAIL markers", () => {
	const output =
		"--- FAIL: TestAddUser\n    app_test.go:42: unexpected error\n--- FAIL: TestDeleteUser\n    app_test.go:99: timeout"
	const result = GoParser.parse(output, "")
	expect(result.errors.length).toBeGreaterThanOrEqual(2)
	expect(result.errors[0]).toMatchObject({
		file: "",
		line: 0,
		severity: "error",
		rule: "go-test",
	})
	expect(result.errors[0].message).toContain("TestAddUser")
	expect(result.errors[1].message).toContain("TestDeleteUser")
})

it("should collect generic messages for unmatched lines", () => {
	const output = "Running tests...\nok  src/app 0.001s\nsrc/app.go:12:5: undefined: someFunc\nPASS"
	const result = GoParser.parse(output, "")
	expect(result.errors).toHaveLength(1)
	expect(result.genericMessages.length).toBeGreaterThanOrEqual(2)
	expect(result.genericMessages).toContain("Running tests...")
	expect(result.genericMessages).toContain("PASS")
})

it("should preserve rawOutput in parsed result", () => {
	const output = "src/app.go:12:5: undefined: someFunc"
	const result = GoParser.parse(output, "")
	expect(result.rawOutput).toBe(output + "\n")
})

it("should handle empty output with no errors or warnings", () => {
	const result = GoParser.parse("", "")
	expect(result.errors).toHaveLength(0)
	expect(result.warnings).toHaveLength(0)
	expect(result.genericMessages).toHaveLength(0)
})
