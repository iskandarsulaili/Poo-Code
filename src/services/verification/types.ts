/**
 * File mutation verification system types for F5.
 *
 * Validates file changes post-write to catch syntax errors and regressions.
 */

// ─── File Check Request ──────────────────────────────────────

export interface FileCheckRequest {
	filePath: string
	content: string
	language?: string
	preWriteErrors?: SyntaxError[]
}

// ─── Verification Result ─────────────────────────────────────

export interface VerificationResult {
	filePath: string
	success: boolean
	newErrors: SyntaxError[]
	preExistingErrors: SyntaxError[]
	warnings: string[]
	executionTimeMs: number
}

// ─── Syntax Check Result ─────────────────────────────────────

export interface SyntaxCheckResult {
	valid: boolean
	errors: SyntaxError[]
	warnings: string[]
	language: string
}

// ─── Syntax Error ────────────────────────────────────────────

export interface SyntaxError {
	line: number
	column: number
	message: string
	severity: "error" | "warning"
	errorCode: string
	source: string
}

// ─── Supported Languages ─────────────────────────────────────

export const SUPPORTED_LANGUAGES = new Map<string, string>([
	[".py", "python"],
	[".json", "json"],
	[".jsonc", "jsonc"],
	[".yaml", "yaml"],
	[".yml", "yaml"],
	[".toml", "toml"],
	[".js", "javascript"],
	[".jsx", "javascript"],
	[".ts", "typescript"],
	[".tsx", "typescript"],
	[".css", "css"],
	[".html", "html"],
	[".md", "markdown"],
])

// ─── Binary File Extensions ──────────────────────────────────

export const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
	".ico",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".pdf",
	".zip",
	".tar",
	".gz",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".dat",
	".mp3",
	".mp4",
	".avi",
	".mov",
])

// ─── Error Classes ───────────────────────────────────────────

export class VerificationError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly filePath?: string,
	) {
		super(message)
		this.name = "VerificationError"
	}
}

export class SyntaxCheckError extends VerificationError {
	constructor(message: string, filePath?: string) {
		super(message, "SYNTAX_CHECK_ERROR", filePath)
		this.name = "SyntaxCheckError"
	}
}

export class DiffFilterError extends VerificationError {
	constructor(message: string, filePath?: string) {
		super(message, "DIFF_FILTER_ERROR", filePath)
		this.name = "DiffFilterError"
	}
}
