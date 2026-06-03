import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFile, unlink } from "fs/promises"
import { join } from "path"
import { PostWriteVerifier } from "../../verification/PostWriteVerifier"
import { FileCheckRequest, SyntaxError } from "../../verification/types"

describe("PostWriteVerifier", () => {
	let verifier: PostWriteVerifier
	const tmpDir = join(process.cwd(), "tmp-test-verifier")

	beforeEach(async () => {
		verifier = new PostWriteVerifier()
		const { mkdir } = await import("fs/promises")
		await mkdir(tmpDir, { recursive: true })
	})

	afterEach(async () => {
		const { rm } = await import("fs/promises")
		await rm(tmpDir, { recursive: true, force: true })
	})

	describe("verify", () => {
		it("should pass valid JSON files", async () => {
			const filePath = join(tmpDir, "valid.json")
			const content = '{"key": "value"}'
			await writeFile(filePath, content)

			const result = await verifier.verify({ filePath, content })
			expect(result.success).toBe(true)
			expect(result.newErrors).toEqual([])
		})

		it("should detect errors in modified content", async () => {
			const filePath = join(tmpDir, "invalid.json")
			// Pre-write content is valid
			const preContent = '{"key": "value"}'
			// Post-write content is invalid (written to disk)
			const postContent = "{invalid json}"
			await writeFile(filePath, postContent)

			const result = await verifier.verify({ filePath, content: preContent })
			// Since pre and post differ, error should NOT be filtered out by refineWithSourceCheck
			expect(result.newErrors.length).toBeGreaterThan(0)
		})

		it("should skip binary files", async () => {
			const filePath = join(tmpDir, "image.png")
			const content = "fake binary"
			await writeFile(filePath, content)

			const result = await verifier.verify({ filePath, content })
			expect(result.success).toBe(true)
			expect(result.warnings.some((w) => w.includes("binary"))).toBe(true)
		})

		it("should skip unsupported file types", async () => {
			const filePath = join(tmpDir, "file.unsupported")
			const content = "some content"
			await writeFile(filePath, content)

			const result = await verifier.verify({ filePath, content })
			expect(result.success).toBe(true)
		})

		it("should return pre-existing errors when provided as option", async () => {
			const filePath = join(tmpDir, "pre-existing.json")
			const content = "{invalid}"
			await writeFile(filePath, content)

			const preWriteErrors: SyntaxError[] = [
				{
					line: 1,
					column: 1,
					message: "Existing error",
					severity: "error",
					errorCode: "PRE001",
					source: "json",
				},
			]

			const result = await verifier.verify({
				filePath,
				content,
				preWriteErrors,
			})
			// preWriteErrors passed in options are captured and returned as preExistingErrors
			expect(result.preExistingErrors).toEqual(preWriteErrors)
		})

		it("should error when file does not exist", async () => {
			const filePath = join(tmpDir, "nonexistent.json")
			await expect(verifier.verify({ filePath, content: '{"key": "val"}' })).rejects.toThrow()
		})
	})

	describe("verifyMultiple", () => {
		it("should verify multiple files in parallel", async () => {
			const filePath1 = join(tmpDir, "valid1.json")
			const filePath2 = join(tmpDir, "valid2.json")
			await writeFile(filePath1, '{"a": 1}')
			await writeFile(filePath2, '{"b": 2}')

			const requests: FileCheckRequest[] = [
				{ filePath: filePath1, content: '{"a": 1}' },
				{ filePath: filePath2, content: '{"b": 2}' },
			]

			const results = await verifier.verifyMultiple(requests)
			expect(results.size).toBe(2)
			expect(results.get(filePath1)!.success).toBe(true)
			expect(results.get(filePath2)!.success).toBe(true)
		})
	})
})
