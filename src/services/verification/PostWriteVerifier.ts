import { readFile } from "fs/promises"
import { extname } from "path"
import {
	BINARY_EXTENSIONS,
	FileCheckRequest,
	SyntaxError,
	SUPPORTED_LANGUAGES,
	VerificationError,
	VerificationResult,
} from "./types"
import { SyntaxChecker } from "./SyntaxChecker"
import { DiffFilter } from "./DiffFilter"

/**
 * Maximum file size for verification (1MB).
 */
const MAX_FILE_SIZE = 1 * 1024 * 1024

/**
 * PostWriteVerifier — verification orchestrator for file mutations (F5).
 *
 * Pipeline:
 * 1. Read file from disk
 * 2. Run syntax check on content
 * 3. Diff against pre-existing errors
 * 4. Return only NEW errors
 *
 * Skips: binary files, files >1MB, unsupported types.
 */
export class PostWriteVerifier {
	private syntaxChecker: SyntaxChecker
	private diffFilter: DiffFilter

	constructor() {
		this.syntaxChecker = new SyntaxChecker()
		this.diffFilter = new DiffFilter()
	}

	/**
	 * Verify a single file after write.
	 *
	 * @param options - File check request with content and optional pre-existing errors
	 * @returns Verification result with only new errors
	 */
	async verify(options: FileCheckRequest): Promise<VerificationResult> {
		const startTime = Date.now()
		const { filePath } = options

		// Pre-checks
		const skipReason = await this.shouldSkip(filePath, options.content)
		if (skipReason) {
			return {
				filePath,
				success: true,
				newErrors: [],
				preExistingErrors: [],
				warnings: [skipReason],
				executionTimeMs: Date.now() - startTime,
			}
		}

		const warnings: string[] = []

		try {
			// Read the actual file from disk
			const diskContent = await this.readFileContent(filePath)
			const preWriteLineCount = options.content.split("\n").length

			// Capture pre-write errors if provided
			if (options.preWriteErrors && options.preWriteErrors.length > 0) {
				await this.diffFilter.capturePreWriteErrors(filePath, options.preWriteErrors)
			} else {
				// Try to get pre-write errors from disk version
				const preWriteErrors = await this.getErrorsFromContent(filePath, options.content, options.language)
				if (preWriteErrors.length > 0) {
					await this.diffFilter.capturePreWriteErrors(filePath, preWriteErrors)
				}
			}

			await this.diffFilter.capturePreWriteLineCount(filePath, options.content)

			// Run syntax check on the written content
			const checkResult = await this.syntaxChecker.check(filePath, diskContent, options.language)

			if (!checkResult.valid) {
				// Filter out pre-existing errors
				const preExisting = await this.diffFilter.getPreWriteErrors(filePath)
				const newErrors = this.diffFilter.filterNewErrors(preExisting, checkResult.errors, preWriteLineCount)

				// Also filter by checking which errors existed pre-write at source level
				const filteredNewErrors = this.refineWithSourceCheck(newErrors, options.content, diskContent)

				warnings.push(...checkResult.warnings)

				// Clean up cache
				await this.diffFilter.clearCache(filePath)

				return {
					filePath,
					success: filteredNewErrors.length === 0,
					newErrors: filteredNewErrors,
					preExistingErrors: preExisting,
					warnings,
					executionTimeMs: Date.now() - startTime,
				}
			}

			// Clean up cache
			await this.diffFilter.clearCache(filePath)

			return {
				filePath,
				success: true,
				newErrors: [],
				preExistingErrors: [],
				warnings: checkResult.warnings,
				executionTimeMs: Date.now() - startTime,
			}
		} catch (err) {
			if (err instanceof VerificationError) throw err
			throw new VerificationError(
				`Verification failed for ${filePath}: ${(err as Error).message}`,
				"VERIFICATION_FAILED",
				filePath,
			)
		}
	}

	/**
	 * Verify multiple files in batch.
	 *
	 * @param files - Array of file check requests
	 * @returns Map of file paths to verification results
	 */
	async verifyMultiple(files: FileCheckRequest[]): Promise<Map<string, VerificationResult>> {
		const results = new Map<string, VerificationResult>()

		await Promise.all(
			files.map(async (file) => {
				try {
					const result = await this.verify(file)
					results.set(file.filePath, result)
				} catch (err) {
					results.set(file.filePath, {
						filePath: file.filePath,
						success: false,
						newErrors: [],
						preExistingErrors: [],
						warnings: [(err as Error).message],
						executionTimeMs: 0,
					})
				}
			}),
		)

		return results
	}

	/**
	 * Check if a file should be skipped for verification.
	 */
	private async shouldSkip(filePath: string, content: string): Promise<string | null> {
		const ext = extname(filePath).toLowerCase()

		// Skip binary files
		if (BINARY_EXTENSIONS.has(ext)) {
			return `Skipping binary file: ${filePath}`
		}

		// Skip unsupported file types
		if (!SUPPORTED_LANGUAGES.has(ext) && !ext) {
			return `Skipping unsupported file type: ${filePath}`
		}

		// Skip large files
		if (content.length > MAX_FILE_SIZE) {
			return `Skipping large file (${(content.length / 1024 / 1024).toFixed(1)}MB > 1MB): ${filePath}`
		}

		return null
	}

	/**
	 * Read file content from disk.
	 */
	private async readFileContent(filePath: string): Promise<string> {
		try {
			const buffer = await readFile(filePath, "utf-8")
			return buffer
		} catch (err) {
			throw new VerificationError(
				`Cannot read file: ${filePath} — ${(err as Error).message}`,
				"FILE_READ_ERROR",
				filePath,
			)
		}
	}

	/**
	 * Get syntax errors from content (pre-write version).
	 */
	private async getErrorsFromContent(filePath: string, content: string, language?: string): Promise<SyntaxError[]> {
		try {
			const result = await this.syntaxChecker.check(filePath, content, language)
			return result.errors
		} catch {
			return []
		}
	}

	/**
	 * Refine new errors by comparing source lines between pre and post content.
	 * If the same error message exists on the same line in the pre-write content,
	 * it's likely pre-existing even with different error codes.
	 */
	private refineWithSourceCheck(newErrors: SyntaxError[], preContent: string, postContent: string): SyntaxError[] {
		const preLines = preContent.split("\n")
		const postLines = postContent.split("\n")

		return newErrors.filter((error) => {
			const postLine = postLines[error.line - 1]
			if (!postLine) return true

			// Check if the same line existed in pre-content with the same issue
			const preLine = preLines[error.line - 1]
			if (!preLine) return true

			// If the line content is identical and only whitespace changed, filter it
			if (preLine.trim() === postLine.trim() && preLine !== postLine) {
				return false
			}

			return true
		})
	}
}
