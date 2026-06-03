/**
 * Fuzzy Patching — Type Definitions
 *
 * Defines all types for F8: Fuzzy Patching feature.
 * Implements multi-strategy fuzzy matching and V4A patch format (Add/Update/Delete/Move).
 */

/**
 * Strategy to use for fuzzy matching.
 */
export type PatchStrategy =
	| "exact"
	| "ignore_whitespace"
	| "ignore_indent"
	| "ignore_comments"
	| "fuzzy_line"
	| "semantic_similarity"
	| "regex_pattern"
	| "best_effort"

/**
 * Result of a fuzzy match attempt.
 */
export interface MatchResult {
	/** Whether a match was found */
	found: boolean
	/** Start line of the match (1-based) */
	startLine: number
	/** End line of the match (1-based) */
	endLine: number
	/** Confidence score [0–1] */
	confidence: number
	/** Strategy that produced this match */
	strategyUsed: PatchStrategy
	/** Original content that was matched */
	originalContent: string
}

/**
 * A patch operation in V4A format.
 */
export type PatchOperation = AddOperation | UpdateOperation | DeleteOperation | MoveOperation

/**
 * Add a new block of content.
 */
export interface AddOperation {
	type: "add"
	/** Content to add */
	content: string
	/** Anchor line for insertion (mutually exclusive with afterLine) */
	beforeLine?: string
	/** Insert after this line (mutually exclusive with beforeLine) */
	afterLine?: string
}

/**
 * Update (replace) an existing block of content.
 */
export interface UpdateOperation {
	type: "update"
	/** Original content to find (used for fuzzy matching) */
	original: string
	/** Replacement content */
	replacement: string
	/** Whether to apply fuzzy matching (default: false) */
	fuzzy?: boolean
}

/**
 * Delete a block of content.
 */
export interface DeleteOperation {
	type: "delete"
	/** Content to delete (used for fuzzy matching) */
	content: string
}

/**
 * Move content from one location to another.
 */
export interface MoveOperation {
	type: "move"
	/** Content to move (used for fuzzy matching) */
	content: string
	/** Target anchor: insert before this line */
	beforeLine?: string
	/** Target anchor: insert after this line (mutually exclusive with beforeLine) */
	afterLine?: string
}

/**
 * A full V4A patch document (array of operations).
 */
export interface V4APatch {
	/** Version marker */
	version: "v4a"
	/** Optional description of the patch */
	description?: string
	/** Ordered list of operations */
	operations: PatchOperation[]
}

/**
 * Errors thrown by patcher operations.
 */
export class PatcherError extends Error {
	constructor(
		message: string,
		public readonly code: PatcherErrorCode,
		public readonly strategy?: PatchStrategy,
	) {
		super(message)
		this.name = "PatcherError"
	}
}

/**
 * Categorised error codes for patcher operations.
 */
export type PatcherErrorCode =
	| "NO_MATCH_FOUND"
	| "AMBIGUOUS_MATCH"
	| "INVALID_PATCH_FORMAT"
	| "OPERATION_FAILED"
	| "STRATEGY_CHAIN_EXHAUSTED"
