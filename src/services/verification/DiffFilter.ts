import { DiffFilterError, SyntaxError } from "./types"

/**
 * DiffFilter — pre-existing error filtering for file mutation verification.
 *
 * Compares pre-write and post-write syntax errors to return ONLY new errors.
 * Error matching uses: error code + line proximity (tolerance for line shifts).
 */
export class DiffFilter {
	private preWriteErrorCache: Map<string, SyntaxError[]> = new Map()
	private preWriteLineCounts: Map<string, number> = new Map()

	/**
	 * Tolerance for line number shifts when matching pre-existing errors.
	 */
	private static readonly LINE_TOLERANCE = 3

	/**
	 * Capture pre-write errors for a file.
	 *
	 * @param filePath - Path to the file being checked
	 * @param errors - Syntax errors found before the write
	 */
	async capturePreWriteErrors(filePath: string, errors: SyntaxError[]): Promise<void> {
		this.preWriteErrorCache.set(filePath, [...errors])
	}

	/**
	 * Get previously captured pre-write errors for a file.
	 *
	 * @param filePath - Path to check
	 * @returns Pre-write syntax errors
	 */
	async getPreWriteErrors(filePath: string): Promise<SyntaxError[]> {
		return this.preWriteErrorCache.get(filePath) ?? []
	}

	/**
	 * Filter out pre-existing errors from post-write results.
	 *
	 * An error is considered pre-existing if:
	 * 1. It has the same errorCode as a pre-write error
	 * 2. Its line number is within LINE_TOLERANCE of the pre-write error's line
	 *
	 * @param preWriteErrors - Errors captured before the write
	 * @param postWriteErrors - Errors found after the write
	 * @param preWriteLineCount - Line count of file before write (for line shift compensation)
	 * @returns Only the errors that are genuinely new
	 */
	filterNewErrors(
		preWriteErrors: SyntaxError[],
		postWriteErrors: SyntaxError[],
		preWriteLineCount?: number,
	): SyntaxError[] {
		const newErrors: SyntaxError[] = []

		for (const postErr of postWriteErrors) {
			const isNew = !this.isPreExisting(postErr, preWriteErrors, preWriteLineCount)

			if (isNew) {
				newErrors.push(postErr)
			}
		}

		return newErrors
	}

	/**
	 * Capture the line count of a file before write (for line shift compensation).
	 *
	 * @param filePath - File path
	 * @param content - File content before write
	 */
	async capturePreWriteLineCount(filePath: string, content: string): Promise<void> {
		this.preWriteLineCounts.set(filePath, content.split("\n").length)
	}

	/**
	 * Clear cached data for a file (post-verification).
	 *
	 * @param filePath - File to clear
	 */
	async clearCache(filePath: string): Promise<void> {
		this.preWriteErrorCache.delete(filePath)
		this.preWriteLineCounts.delete(filePath)
	}

	/**
	 * Check if a post-write error matches a pre-existing error.
	 */
	private isPreExisting(postError: SyntaxError, preWriteErrors: SyntaxError[], preWriteLineCount?: number): boolean {
		for (const preErr of preWriteErrors) {
			// Match by error code first (fast path)
			if (preErr.errorCode !== postError.errorCode) continue

			// Match by source
			if (preErr.source !== postError.source) continue

			// Check line proximity with tolerance for shifts
			const lineShift = this.estimateLineShift(preWriteLineCount, preErr.line, postError.line)

			const lineDiff = Math.abs(postError.line - (preErr.line + lineShift))

			if (lineDiff <= DiffFilter.LINE_TOLERANCE) {
				return true
			}
		}

		return false
	}

	/**
	 * Estimate how many lines were added/removed before the error line.
	 *
	 * Uses original line count as heuristic. If the new file is longer,
	 * lines were likely added before the error point.
	 *
	 * @param preWriteLineCount - Original file line count
	 * @param preLine - Line of pre-existing error
	 * @param postLine - Line of post-write error
	 * @returns Estimated line shift
	 */
	private estimateLineShift(preWriteLineCount: number | undefined, _preLine: number, _postLine: number): number {
		if (preWriteLineCount === undefined) return 0
		return 0 // Conservative: don't guess line shifts, rely on tolerance
	}

	/**
	 * Invalidate the entire cache (e.g., on session end).
	 */
	clearAll(): void {
		this.preWriteErrorCache.clear()
		this.preWriteLineCounts.clear()
	}
}
