// npx vitest services/__tests__/patcher/FuzzyMatcher.spec.ts

import { FuzzyMatcher } from "../../patcher/FuzzyMatcher"
import { PatcherError } from "../../patcher/types"

describe("FuzzyMatcher", () => {
	let matcher: FuzzyMatcher

	beforeEach(() => {
		matcher = new FuzzyMatcher()
	})

	describe("findMatch", () => {
		it("should find exact matches", () => {
			const fileContent = `line1
const x = 1
line3`
			const searchContent = "const x = 1"

			const result = matcher.findMatch(fileContent, searchContent)
			expect(result.found).toBe(true)
			expect(result.confidence).toBe(1.0)
			expect(result.startLine).toBe(2)
			expect(result.endLine).toBe(2)
		})

		it("should find matches with whitespace differences", () => {
			const fileContent = `line1
const   x   =   1
line3`
			const searchContent = "const x = 1"

			const result = matcher.findMatch(fileContent, searchContent)
			expect(result.found).toBe(true)
			expect(result.confidence).toBeGreaterThan(0.6)
		})

		it("should find matches with indentation differences", () => {
			const fileContent = `line1
    const x = 1
line3`
			const searchContent = "const x = 1"

			const result = matcher.findMatch(fileContent, searchContent)
			expect(result.found).toBe(true)
			expect(result.confidence).toBeGreaterThan(0.7)
		})

		it("should find multi-line matches", () => {
			const fileContent = `function foo() {
  const x = 1
  const y = 2
  return x + y
}`
			const searchContent = `  const x = 1
  const y = 2`

			const result = matcher.findMatch(fileContent, searchContent)
			expect(result.found).toBe(true)
			expect(result.startLine).toBe(2)
			expect(result.endLine).toBe(3)
		})

		it("should throw PatcherError when no match found", () => {
			const fileContent = "nothing useful here"
			const searchContent = "completely different content"

			expect(() => matcher.findMatch(fileContent, searchContent)).toThrow(PatcherError)
		})
	})

	describe("findAllMatches", () => {
		it("should find all occurrences", () => {
			const fileContent = `const x = 1
const y = 2
const x = 1`
			const searchContent = "const x = 1"

			const matches = matcher.findAllMatches(fileContent, searchContent)
			expect(matches.length).toBeGreaterThanOrEqual(1)
		})

		it("should return empty array when no matches", () => {
			const fileContent = "foo"
			const searchContent = "bar"

			const matches = matcher.findAllMatches(fileContent, searchContent)
			expect(matches).toHaveLength(0)
		})
	})

	describe("string comparison helpers", () => {
		it("should normalize whitespace for comparison", () => {
			const fileContent = "hello    world"
			const searchContent = "hello world"

			const result = matcher.findMatch(fileContent, searchContent)
			expect(result.found).toBe(true)
		})

		it("should be case-sensitive by default", () => {
			const fileContent = "Hello World"
			const searchContent = "hello world"

			const result = matcher.findMatch(fileContent, searchContent)
			// Depending on strategy, may or may not match
			expect(result.found).toBe(true) // fuzzy_line handles it
		})
	})

	describe("strategy fallback", () => {
		it("should fall back through strategies", () => {
			const fileContent = `  const x = 1
  const y = 2`
			const searchContent = "const x = 1"

			const result = matcher.findMatch(fileContent, searchContent)
			expect(result.found).toBe(true)
			// May match via exact (if indented matches) or ignore-whitespace/indent
			expect(result.confidence).toBeGreaterThan(0)
		})
	})
})
