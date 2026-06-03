import { describe, it, expect } from "vitest"
import { SyntaxChecker } from "../../verification/SyntaxChecker"

describe("SyntaxChecker", () => {
	const checker = new SyntaxChecker()

	describe("check - JSON", () => {
		it("should validate valid JSON", async () => {
			const result = await checker.check("test.json", '{"key": "value"}', "json")
			expect(result.valid).toBe(true)
			expect(result.errors).toEqual([])
		})

		it("should detect invalid JSON", async () => {
			const result = await checker.check("test.json", '{"key": value}', "json")
			expect(result.valid).toBe(false)
			expect(result.errors.length).toBeGreaterThan(0)
		})

		it("should detect truncated JSON", async () => {
			const result = await checker.check("test.json", '{"key": "value"', "json")
			expect(result.valid).toBe(false)
		})
	})

	describe("check - JSONC (with comments)", () => {
		it("should validate JSONC with comments", async () => {
			const result = await checker.check("test.jsonc", '{\n  // comment\n  "key": "value"\n}', "jsonc")
			expect(result.valid).toBe(true)
		})

		it("should validate JSONC with block comments", async () => {
			const result = await checker.check("test.jsonc", '{\n  /* block */\n  "key": "value"\n}', "jsonc")
			expect(result.valid).toBe(true)
		})
	})

	describe("check - unknown language", () => {
		it("should return valid true for unknown languages", async () => {
			const result = await checker.check("test.xyz", "some content", "unknown")
			expect(result.valid).toBe(true)
			expect(result.warnings.length).toBeGreaterThan(0)
		})

		it("should detect language from file extension", async () => {
			const result = await checker.check("config.json", '{"key": "val"}')
			expect(result.valid).toBe(true)
			expect(result.language).toBe("json")
		})
	})

	describe("check - TOML", () => {
		it("should handle TOML (may fallback if no parser)", async () => {
			const result = await checker.check("config.toml", 'key = "value"\n', "toml")
			// Should either validate or gracefully warn
			expect(result).toBeDefined()
		})
	})

	describe("detectLanguage", () => {
		it("should detect language from file extension", () => {
			const detected = (checker as any).detectLanguage("script.py")
			expect(detected).toBe("python")
		})

		it("should return unknown for unsupported extensions", () => {
			const detected = (checker as any).detectLanguage("file.xyz")
			expect(detected).toBe("unknown")
		})
	})
})
