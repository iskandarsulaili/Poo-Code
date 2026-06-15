/**
 * Type definitions for Zoo-Code multi-language monorepo orchestration.
 *
 * Includes types for parallel execution, output parsing, dependency graphs,
 * and workspace management.
 *
 * @module
 */

// ============================================================================
// Parallel Execution Types
// ============================================================================

/**
 * A single command to execute within a parallel group.
 */
export interface ParallelCommand {
	/** The shell command string to execute */
	command: string
	/** Optional working directory (null = use default) */
	cwd?: string | null
	/** Optional timeout in seconds (null = no timeout) */
	timeout?: number | null
}

/**
 * A group of commands that execute with shared scheduling behavior.
 * Commands within a group can be sequential (one after another) or concurrent.
 */
export interface ParallelCommandGroup {
	/** Unique identifier for this group */
	id: string
	/** If true, commands within this group execute sequentially; otherwise concurrently */
	sequential: boolean
	/** Array of commands to execute as part of this group */
	commands: ParallelCommand[]
	/** IDs of groups that must complete before this group starts */
	wait_for: string[]
	/** If true, continue executing remaining commands even if one fails */
	continue_on_error: boolean
}

/**
 * Parameters for the execute_parallel tool.
 */
export interface ExecuteParallelParams {
	/** Array of command groups to execute */
	groups: ParallelCommandGroup[]
	/** Maximum number of groups to execute in parallel (null = use default based on CPU count) */
	max_parallel?: number | null
}

/**
 * Result of executing a single command.
 */
export interface CommandResult {
	/** The command string that was executed */
	command: string
	/** Working directory where the command was executed */
	cwd: string
	/** Exit code (undefined if command did not complete) */
	exitCode: number | undefined
	/** Duration in milliseconds */
	duration: number
	/** Captured stdout */
	stdout: string
	/** Captured stderr */
	stderr: string
	/** Parsed structured result from output parser */
	parsed: ParsedResult
	/** Raw concatenated output (stdout + stderr) */
	rawOutput: string
	/** Whether output was truncated due to size limits */
	truncated: boolean
	/** Path to persisted output artifact (if truncated) */
	artifactPath?: string
	/** Error message if command failed to start or was aborted */
	error?: string
}

/**
 * Aggregated result for a group of commands.
 */
export interface GroupResult {
	/** Group identifier matching ParallelCommandGroup.id */
	id: string
	/** Whether commands in this group were executed sequentially */
	sequential: boolean
	/** Results of individual commands in execution order */
	commands: CommandResult[]
	/** Number of commands that completed successfully */
	successCount: number
	/** Number of commands that failed */
	failedCount: number
	/** Number of commands that were skipped (due to prior failure) */
	skippedCount: number
	/** Total wall-clock duration for this group in milliseconds */
	totalDuration: number
}

/**
 * Aggregated result for the entire parallel execution.
 */
export interface AggregatedResult {
	/** Results per command group */
	groups: GroupResult[]
	/** Total wall-clock duration across all groups in milliseconds */
	totalDuration: number
	/** Total commands succeeded */
	successCount: number
	/** Total commands failed */
	failedCount: number
	/** Total commands skipped */
	skippedCount: number
}

// ============================================================================
// Output Parsing Types
// ============================================================================

/**
 * Severity level for parsed diagnostic messages.
 */
export type ParsedSeverity = "error" | "warning" | "info"

/**
 * A single parsed diagnostic item from command output.
 */
export interface ParsedError {
	/** Source file path (relative or absolute) */
	file: string
	/** 1-based line number */
	line: number
	/** Optional 1-based column number */
	column?: number
	/** Severity classification */
	severity: ParsedSeverity
	/** Human-readable error/warning message */
	message: string
	/** Optional error code (e.g., "TS2345", "E0308") */
	code?: string
	/** Optional lint rule identifier (e.g., "no-unused-vars") */
	rule?: string
	/** Raw original line as captured from output */
	raw: string
}

/**
 * Fully parsed result from a command's output.
 * Always preserves the original raw output alongside structured fields.
 */
export interface ParsedResult {
	/** Exit code of the command */
	exitCode: number | undefined
	/** Duration in milliseconds */
	duration: number
	/** Captured stdout content */
	stdout: string
	/** Captured stderr content */
	stderr: string
	/** Extracted error diagnostics */
	errors: ParsedError[]
	/** Extracted warning diagnostics */
	warnings: ParsedError[]
	/** Lines that did not match any known diagnostic pattern */
	genericMessages: string[]
	/** Human-readable summary of the result */
	summary: string
	/** Raw concatenated output (always preserved) */
	rawOutput: string
	/** Whether the output was truncated */
	truncated: boolean
}

/**
 * Interface that all language-specific parsers must implement.
 */
export interface ParserPlugin {
	/** Unique name for this parser plugin */
	readonly name: string
	/** Optional regex to match tool/command names (e.g., /^(tsc|eslint)\b/) */
	readonly toolPattern?: RegExp
	/** Optional language identifier (e.g., "typescript", "rust") */
	readonly language?: string
	/**
	 * Parse command stdout/stderr into a structured result.
	 *
	 * @param stdout - Captured stdout content
	 * @param stderr - Captured stderr content
	 * @param exitCode - Optional exit code from the command
	 * @returns ParsedResult with extracted diagnostics
	 */
	parse(stdout: string, stderr: string, exitCode?: number): ParsedResult
}

// ============================================================================
// Dependency Graph Types
// ============================================================================

/**
 * Supported programming language identifiers for sub-projects.
 */
export type ProjectLanguage =
	| "typescript"
	| "javascript"
	| "python"
	| "rust"
	| "go"
	| "kotlin"
	| "java"
	| "c"
	| "cpp"
	| "unknown"

/**
 * Describes a sub-project discovered within a workspace root.
 */
export interface SubProject {
	/** Unique identifier (typically name@rootPath) */
	id: string
	/** Display name of the project */
	name: string
	/** Absolute path to the project root */
	rootPath: string
	/** Detected programming language */
	language: ProjectLanguage
	/** Path to the build manifest file (relative to rootPath) */
	buildManifest: string
	/** Type of build manifest file */
	buildManifestType:
		| "package.json"
		| "Cargo.toml"
		| "go.mod"
		| "pyproject.toml"
		| "build.gradle"
		| "build.gradle.kts"
		| "BUILD"
		| "CMakeLists.txt"
	/** Names of projects this project depends on (inter-project) */
	dependencies: string[]
	/** Names of dev-only dependencies */
	devDependencies: string[]
	/** Whether this project is a root-level project (no dependents) */
	isRoot: boolean
	/** Whether this project is a leaf project (no dependencies) */
	isLeaf: boolean
}

/**
 * A directed dependency graph of sub-projects.
 */
export interface DependencyGraph {
	/** All projects in the graph */
	projects: SubProject[]
	/** Topologically sorted project IDs (leaves first, roots last) */
	buildOrder: string[]
	/** Detected cycles (each cycle is an ordered list of project IDs) */
	cycles: Array<string[]>
	/** Timestamp when the graph was last built */
	updatedAt: Date
}

/**
 * Manual override for dependency graph edges.
 * Used to add or remove edges that auto-detection gets wrong.
 */
export interface DependencyOverride {
	/** "add" to create an edge, "remove" to delete an edge */
	type: "add" | "remove"
	/** Source project ID */
	from: string
	/** Target project ID (required for "add", optional for "remove") */
	to?: string
}

// ============================================================================
// Workspace Management Types
// ============================================================================

/**
 * Serializable representation of a workspace root.
 */
export interface WorkspaceRootInfo {
	/** Serialized vscode.Uri */
	uri: string
	/** Filesystem path */
	fsPath: string
	/** Workspace folder name */
	name: string
	/** Index within the workspace folders array */
	index: number
}

/**
 * A context section injected into the LLM system prompt.
 */
export interface ContextSection {
	/** Section type identifier */
	type: "monorepo_structure"
	/** Formatted content string */
	content: string
	/** Estimated token count for this section */
	tokenCount: number
}
