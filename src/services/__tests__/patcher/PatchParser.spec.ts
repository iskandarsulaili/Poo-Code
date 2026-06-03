// npx vitest services/__tests__/patcher/PatchParser.spec.ts

import { PatchParser } from "../../patcher/PatchParser"
import { PatcherError } from "../../patcher/types"
import type { V4APatch } from "../../patcher/types"

describe("PatchParser", () => {
	let parser: PatchParser

	beforeEach(() => {
		parser = new PatchParser()
	})

	describe("parse", () => {
		it("should parse a valid V4A patch", () => {
			const patchJson = JSON.stringify({
				version: "v4a",
				description: "Add logging",
				operations: [
					{
						type: "add",
						content: "console.log('done')",
						afterLine: "// end",
					},
				],
			})

			const patch = parser.parse(patchJson)
			expect(patch.version).toBe("v4a")
			expect(patch.description).toBe("Add logging")
			expect(patch.operations).toHaveLength(1)
			expect(patch.operations[0].type).toBe("add")
		})

		it("should throw for invalid JSON", () => {
			expect(() => parser.parse("not json")).toThrow(PatcherError)
		})

		it("should throw for missing version field", () => {
			const patchJson = JSON.stringify({
				operations: [{ type: "add", content: "test" }],
			})
			expect(() => parser.parse(patchJson)).toThrow(PatcherError)
		})

		it("should throw for unsupported version", () => {
			const patchJson = JSON.stringify({
				version: "v3",
				operations: [],
			})
			expect(() => parser.parse(patchJson)).toThrow(PatcherError)
		})
	})

	describe("apply", () => {
		it("should apply an update operation", () => {
			const content = "const x = 1\nconst y = 2\n"
			const patch: V4APatch = {
				version: "v4a",
				operations: [
					{
						type: "update",
						original: "const x = 1",
						replacement: "const x = 10",
					},
				],
			}

			const result = parser.apply(patch, content)
			expect(result).toContain("const x = 10")
			expect(result).toContain("const y = 2")
		})

		it("should apply a delete operation", () => {
			const content = "line1\nline2\nline3\n"
			const patch: V4APatch = {
				version: "v4a",
				operations: [
					{
						type: "delete",
						content: "line2",
					},
				],
			}

			const result = parser.apply(patch, content)
			expect(result).toContain("line1")
			expect(result).not.toContain("line2")
			expect(result).toContain("line3")
		})

		it("should apply an add operation without anchor", () => {
			const content = "const x = 1\n"
			const patch: V4APatch = {
				version: "v4a",
				operations: [
					{
						type: "add",
						content: "const y = 2",
					},
				],
			}

			const result = parser.apply(patch, content)
			expect(result).toContain("const x = 1")
			expect(result).toContain("const y = 2")
		})
	})

	describe("parse + apply integration", () => {
		it("should parse and apply a complete patch", () => {
			const original = "function foo() {\n  return 1\n}\n"
			const patchJson = JSON.stringify({
				version: "v4a",
				operations: [
					{
						type: "update",
						original: "  return 1",
						replacement: "  return 42",
					},
				],
			})

			const patch = parser.parse(patchJson)
			const result = parser.apply(patch, original)
			expect(result).toContain("return 42")
			expect(result).not.toContain("return 1")
		})
	})
})
