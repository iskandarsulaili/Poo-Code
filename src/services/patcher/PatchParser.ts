/**
 * PatchParser — Parses V4A patch format and applies operations.
 *
 * The V4A format supports four operation types:
 * - Add: Insert new content before/after an anchor line
 * - Update: Replace existing content (exact or fuzzy)
 * - Delete: Remove a block of content
 * - Move: Relocate content to a new position
 *
 * Uses FuzzyMatcher for content location in all operations.
 */

import type { V4APatch, PatchOperation, AddOperation, UpdateOperation, DeleteOperation, MoveOperation } from "./types"
import { FuzzyMatcher } from "./FuzzyMatcher"
import { PatcherError } from "./types"

/**
 * Result of a single operation application.
 */
interface OperationResult {
	content: string
	/** Whether this operation modified the content */
	modified: boolean
}

export class PatchParser {
	private matcher: FuzzyMatcher

	constructor() {
		this.matcher = new FuzzyMatcher()
	}

	/**
	 * Parse a V4A patch document from a JSON string.
	 */
	parse(patchContent: string): V4APatch {
		try {
			const parsed = JSON.parse(patchContent)
			this.validate(parsed)
			return parsed as V4APatch
		} catch (error) {
			if (error instanceof PatcherError) throw error
			throw new PatcherError(
				`Invalid V4A patch format: ${error instanceof Error ? error.message : "parse error"}`,
				"INVALID_PATCH_FORMAT",
			)
		}
	}

	/**
	 * Apply a V4A patch to a file's content.
	 * Operations are applied sequentially; each operation works on the result
	 * of the previous operation.
	 */
	apply(patch: V4APatch, fileContent: string): string {
		let current = fileContent
		let operationIndex = 0

		for (const op of patch.operations) {
			try {
				const result = this.applyOperation(op, current)
				current = result.content
			} catch (error) {
				if (error instanceof PatcherError) {
					throw new PatcherError(
						`Operation ${operationIndex} (${op.type}) failed: ${error.message}`,
						"OPERATION_FAILED",
						(error as PatcherError).strategy,
					)
				}
				throw error
			}
			operationIndex++
		}

		return current
	}

	/**
	 * Apply a single operation to content.
	 */
	private applyOperation(op: PatchOperation, content: string): OperationResult {
		switch (op.type) {
			case "add":
				return this.applyAdd(op, content)
			case "update":
				return this.applyUpdate(op, content)
			case "delete":
				return this.applyDelete(op, content)
			case "move":
				return this.applyMove(op, content)
		}
	}

	private applyAdd(op: AddOperation, content: string): OperationResult {
		if (!op.beforeLine && !op.afterLine) {
			// Default: append to end
			return {
				content: content + "\n" + op.content,
				modified: true,
			}
		}

		const lines = content.split("\n")

		if (op.beforeLine) {
			const match = this.matcher.findMatch(content, op.beforeLine)
			lines.splice(match.startLine - 1, 0, op.content)
			return { content: lines.join("\n"), modified: true }
		}

		if (op.afterLine) {
			const match = this.matcher.findMatch(content, op.afterLine)
			lines.splice(match.endLine, 0, op.content)
			return { content: lines.join("\n"), modified: true }
		}

		return { content, modified: false }
	}

	private applyUpdate(op: UpdateOperation, content: string): OperationResult {
		if (op.fuzzy) {
			const match = this.matcher.findMatch(content, op.original)
			const lines = content.split("\n")
			lines.splice(match.startLine - 1, match.endLine - match.startLine + 1, op.replacement)
			return { content: lines.join("\n"), modified: true }
		}

		// Exact replacement
		const replaced = content.replace(op.original, op.replacement)
		if (replaced === content) {
			// Fall back to fuzzy if exact failed
			return this.applyUpdate({ ...op, fuzzy: true }, content)
		}
		return { content: replaced, modified: replaced !== content }
	}

	private applyDelete(op: DeleteOperation, content: string): OperationResult {
		const match = this.matcher.findMatch(content, op.content)
		const lines = content.split("\n")
		lines.splice(match.startLine - 1, match.endLine - match.startLine + 1)
		return { content: lines.join("\n"), modified: true }
	}

	private applyMove(op: MoveOperation, content: string): OperationResult {
		if (op.beforeLine && op.afterLine) {
			throw new PatcherError(
				"Move operation cannot specify both beforeLine and afterLine",
				"INVALID_PATCH_FORMAT",
			)
		}

		// Find the content to move
		const match = this.matcher.findMatch(content, op.content)

		// Convert to lines and extract the content
		const lines = content.split("\n")
		const movedContent = lines.splice(match.startLine - 1, match.endLine - match.startLine + 1)

		// After splicing, the remaining content doesn't have the moved block
		const remainingContent = lines.join("\n")

		// Find target position in the remaining content
		let insertIndex: number

		if (op.beforeLine) {
			const targetMatch = this.matcher.findMatch(remainingContent, op.beforeLine)
			insertIndex = targetMatch.startLine - 1
		} else if (op.afterLine) {
			const targetMatch = this.matcher.findMatch(remainingContent, op.afterLine)
			insertIndex = targetMatch.endLine
		} else {
			insertIndex = lines.length
		}

		// Insert at the target position
		lines.splice(insertIndex, 0, ...movedContent)
		return { content: lines.join("\n"), modified: true }
	}

	/**
	 * Serialize a V4APatch to JSON string.
	 */
	serialize(patch: V4APatch): string {
		return JSON.stringify(patch, null, 2)
	}

	/**
	 * Create a simple add operation.
	 */
	static createAdd(content: string, options?: { beforeLine?: string; afterLine?: string }): V4APatch {
		return {
			version: "v4a",
			operations: [
				{
					type: "add",
					content,
					beforeLine: options?.beforeLine,
					afterLine: options?.afterLine,
				},
			],
		}
	}

	/**
	 * Create a simple update operation.
	 */
	static createUpdate(original: string, replacement: string, fuzzy?: boolean): V4APatch {
		return {
			version: "v4a",
			operations: [
				{
					type: "update",
					original,
					replacement,
					fuzzy,
				},
			],
		}
	}

	/**
	 * Create a simple delete operation.
	 */
	static createDelete(content: string): V4APatch {
		return {
			version: "v4a",
			operations: [
				{
					type: "delete",
					content,
				},
			],
		}
	}

	/**
	 * Create a simple move operation.
	 */
	static createMove(content: string, options?: { beforeLine?: string; afterLine?: string }): V4APatch {
		return {
			version: "v4a",
			operations: [
				{
					type: "move",
					content,
					beforeLine: options?.beforeLine,
					afterLine: options?.afterLine,
				},
			],
		}
	}

	/**
	 * Validate a parsed V4A patch structure.
	 * Throws PatcherError if validation fails.
	 */
	private validate(patch: unknown): asserts patch is V4APatch {
		if (!patch || typeof patch !== "object") {
			throw new PatcherError("Patch must be an object", "INVALID_PATCH_FORMAT")
		}

		const p = patch as Record<string, unknown>

		if (p.version !== "v4a") {
			throw new PatcherError(`Patch version must be "v4a", got "${String(p.version)}"`, "INVALID_PATCH_FORMAT")
		}

		if (!Array.isArray(p.operations)) {
			throw new PatcherError("Patch must contain an operations array", "INVALID_PATCH_FORMAT")
		}

		for (let i = 0; i < p.operations.length; i++) {
			this.validateOperation(p.operations[i] as Record<string, unknown>, i)
		}
	}

	/**
	 * Validate a single operation structure.
	 */
	private validateOperation(op: Record<string, unknown>, index: number): asserts op is PatchOperation {
		if (!op || typeof op !== "object") {
			throw new PatcherError(`Operation ${index} must be an object`, "INVALID_PATCH_FORMAT")
		}

		const type = op.type as string
		const validTypes = ["add", "update", "delete", "move"]

		if (!validTypes.includes(type)) {
			throw new PatcherError(
				`Operation ${index}: invalid type "${type}". Must be one of: ${validTypes.join(", ")}`,
				"INVALID_PATCH_FORMAT",
			)
		}

		switch (type) {
			case "add": {
				if (typeof op.content !== "string" || op.content.trim() === "") {
					throw new PatcherError(
						`Operation ${index} (add): content must be a non-empty string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				if (op.beforeLine && typeof op.beforeLine !== "string") {
					throw new PatcherError(
						`Operation ${index} (add): beforeLine must be a string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				if (op.afterLine && typeof op.afterLine !== "string") {
					throw new PatcherError(
						`Operation ${index} (add): afterLine must be a string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				if (op.beforeLine && op.afterLine) {
					throw new PatcherError(
						`Operation ${index} (add): cannot specify both beforeLine and afterLine`,
						"INVALID_PATCH_FORMAT",
					)
				}
				break
			}
			case "update": {
				if (typeof op.original !== "string" || op.original.trim() === "") {
					throw new PatcherError(
						`Operation ${index} (update): original must be a non-empty string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				if (typeof op.replacement !== "string") {
					throw new PatcherError(
						`Operation ${index} (update): replacement must be a string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				break
			}
			case "delete": {
				if (typeof op.content !== "string" || op.content.trim() === "") {
					throw new PatcherError(
						`Operation ${index} (delete): content must be a non-empty string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				break
			}
			case "move": {
				if (typeof op.content !== "string" || op.content.trim() === "") {
					throw new PatcherError(
						`Operation ${index} (move): content must be a non-empty string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				if (op.beforeLine && typeof op.beforeLine !== "string") {
					throw new PatcherError(
						`Operation ${index} (move): beforeLine must be a string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				if (op.afterLine && typeof op.afterLine !== "string") {
					throw new PatcherError(
						`Operation ${index} (move): afterLine must be a string`,
						"INVALID_PATCH_FORMAT",
					)
				}
				if (op.beforeLine && op.afterLine) {
					throw new PatcherError(
						`Operation ${index} (move): cannot specify both beforeLine and afterLine`,
						"INVALID_PATCH_FORMAT",
					)
				}
				break
			}
		}
	}
}
