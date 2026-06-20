import { describe, it, expect } from "vitest"
import { ASTParser } from "../ast-parser.js"
import { Language } from "../types.js"

describe("ASTParser", () => {
	it("should create instance with default config", () => {
		const parser = new ASTParser()
		expect(parser).toBeInstanceOf(ASTParser)
	})

	it("should return empty root node for empty content", async () => {
		const parser = new ASTParser()
		const result = await parser.parse("/test.ts", "", Language.TypeScript)
		expect(result.filePath).toBe("/test.ts")
		expect(result.language).toBe(Language.TypeScript)
		expect(result.ast).not.toBeNull()
		expect(result.ast!.kind).toBe("program")
		expect(result.ast!.children).toHaveLength(0)
		expect(result.error).toBeNull()
	})

	it("should return parse result with content hash", async () => {
		const parser = new ASTParser()
		const result = await parser.parse("/test.ts", "const x = 1;", Language.TypeScript)
		expect(result.contentHash).toBeDefined()
		expect(result.contentHash.length).toBeGreaterThan(0)
	})
})
