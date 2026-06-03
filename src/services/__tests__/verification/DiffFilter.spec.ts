import { describe, it, expect, beforeEach } from "vitest"
import { DiffFilter } from "../../verification/DiffFilter"
import { SyntaxError } from "../../verification/types"

describe("DiffFilter", () => {
	let filter: DiffFilter

	beforeEach(() => {
		filter = new DiffFilter()
	})

	describe("capturePreWriteErrors and getPreWriteErrors", () => {
		it("should store and retrieve pre-write errors", async () => {
			const errors: SyntaxError[] = [
				{ line: 5, column: 1, message: "Test error", severity: "error", errorCode: "E001", source: "test" },
			]
			await filter.capturePreWriteErrors("test.ts", errors)
			const retrieved = await filter.getPreWriteErrors("test.ts")
			expect(retrieved).toEqual(errors)
		})

		it("should return empty array for unknown file", async () => {
			const retrieved = await filter.getPreWriteErrors("unknown.ts")
			expect(retrieved).toEqual([])
		})
	})

	describe("filterNewErrors", () => {
		it("should return empty array when no new errors", () => {
			const pre: SyntaxError[] = [
				{ line: 10, column: 1, message: "Old error", severity: "error", errorCode: "E001", source: "tsc" },
			]
			const post: SyntaxError[] = [
				{ line: 10, column: 1, message: "Old error", severity: "error", errorCode: "E001", source: "tsc" },
			]
			const newErrors = filter.filterNewErrors(pre, post)
			expect(newErrors).toEqual([])
		})

		it("should identify genuinely new errors", () => {
			const pre: SyntaxError[] = [
				{ line: 10, column: 1, message: "Old error", severity: "error", errorCode: "E001", source: "tsc" },
			]
			const post: SyntaxError[] = [
				{ line: 10, column: 1, message: "Old error", severity: "error", errorCode: "E001", source: "tsc" },
				{ line: 25, column: 3, message: "New error", severity: "error", errorCode: "E002", source: "tsc" },
			]
			const newErrors = filter.filterNewErrors(pre, post)
			expect(newErrors).toHaveLength(1)
			expect(newErrors[0].errorCode).toBe("E002")
		})

		it("should match errors by code and source within line tolerance", () => {
			const pre: SyntaxError[] = [
				{ line: 10, column: 1, message: "Error", severity: "error", errorCode: "E001", source: "eslint" },
			]
			const post: SyntaxError[] = [
				// Line shifted by 1 (within tolerance of 3)
				{ line: 11, column: 1, message: "Error", severity: "error", errorCode: "E001", source: "eslint" },
			]
			const newErrors = filter.filterNewErrors(pre, post, 15)
			expect(newErrors).toEqual([])
		})

		it("should NOT match same error code from different source", () => {
			const pre: SyntaxError[] = [
				{ line: 10, column: 1, message: "Error", severity: "error", errorCode: "E001", source: "tsc" },
			]
			const post: SyntaxError[] = [
				{ line: 10, column: 1, message: "Error", severity: "error", errorCode: "E001", source: "eslint" },
			]
			const newErrors = filter.filterNewErrors(pre, post)
			expect(newErrors).toHaveLength(1)
		})
	})

	describe("capturePreWriteLineCount and clearCache", () => {
		it("should store and clear line count", async () => {
			await filter.capturePreWriteLineCount("test.ts", "line1\nline2\nline3\n")
			await filter.clearCache("test.ts")
			const retrieved = await filter.getPreWriteErrors("test.ts")
			expect(retrieved).toEqual([])
		})
	})

	describe("clearAll", () => {
		it("should clear all cached data", () => {
			filter.clearAll()
			// No errors expected after clear
		})
	})
})
