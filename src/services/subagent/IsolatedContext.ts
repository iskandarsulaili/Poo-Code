import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import crypto from "crypto"
import { ContextError, LEAF_BLOCKED_TOOLS } from "./types"
import type { SubagentRole } from "./types"

/**
 * Options for creating an isolated context.
 */
export interface IsolatedContextOptions {
	/** Subagent role — determines which tools are blocked by default */
	role: SubagentRole

	/** Additional env vars to inject */
	envVars?: Record<string, string>

	/** Allowed tool names; empty = all available */
	allowedTools?: string[]

	/** Working directory for the subagent */
	workdir?: string

	/** The workspace root path (used to scope symlinks / relative paths) */
	workspaceRoot: string
}

/**
 * An isolated context for subagent execution.
 *
 * Provides:
 * - A temporary directory (tempDir) for scratch files
 * - A restricted tool set
 * - Environment variable overrides
 * - Working directory isolation
 */
export interface IsolatedContext {
	/** Unique context ID */
	id: string

	/** Temporary directory created for this context */
	tempDir: string

	/** Working directory the subagent operates in */
	workdir: string

	/** Environment variables to inject */
	envVars: Record<string, string>

	/** Tool names the subagent is permitted to use */
	allowedTools: string[]

	/** Tools explicitly blocked (deny-list, takes precedence over allowedTools) */
	blockedTools: string[]

	/** Timestamp when the context was created */
	createdAt: number
}

/**
 * Factory & manager for creating and destroying isolated subagent contexts.
 */
export const IsolatedContextFactory = {
	/**
	 * Create an isolated context for a subagent.
	 *
	 * Creates a temp directory, resolves the working directory, computes
	 * the effective allowed and blocked tool sets based on the subagent role,
	 * and captures environment variables.
	 *
	 * @param options - Context creation options
	 * @returns A new IsolatedContext
	 * @throws {ContextError} If temp directory creation fails
	 */
	async create(options: IsolatedContextOptions): Promise<IsolatedContext> {
		const contextId = crypto.randomUUID()

		let tempDir: string
		try {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `zoo-subagent-${contextId}-`))
		} catch (err) {
			throw new ContextError("Failed to create subagent temp directory", err)
		}

		// Resolve workdir
		const workdir = options.workdir ? path.resolve(options.workdir) : path.resolve(options.workspaceRoot)

		// Compute effective allowed tools
		// Role "leaf" blocks certain tools by default (e.g. delegate_task, memory)
		const blockedTools: string[] = []
		if (options.role === "leaf") {
			blockedTools.push(...LEAF_BLOCKED_TOOLS)
		}

		const allowedTools = options.allowedTools ?? []

		return {
			id: contextId,
			tempDir,
			workdir,
			envVars: { ...options.envVars },
			allowedTools,
			blockedTools,
			createdAt: Date.now(),
		}
	},

	/**
	 * Destroy an isolated context — cleans up its temp directory.
	 *
	 * @param context - The context to destroy
	 * @throws {ContextError} If cleanup fails
	 */
	async destroy(context: IsolatedContext): Promise<void> {
		try {
			await fs.rm(context.tempDir, { recursive: true, force: true })
		} catch (err) {
			throw new ContextError(`Failed to clean up context ${context.id} temp directory: ${context.tempDir}`, err)
		}
	},

	/**
	 * Restrict the tools a subagent can use by setting the allowed list.
	 * Calling this replaces any previously set allowed tools.
	 *
	 * @param context - The context to modify
	 * @param allowedTools - Array of tool names the subagent may use
	 */
	restrictTools(context: IsolatedContext, allowedTools: string[]): void {
		context.allowedTools = [...allowedTools]
	},

	/**
	 * Add additional blocked tools to the context's deny-list.
	 *
	 * @param context - The context to modify
	 * @param tools - Array of tool names to add to the blocked list
	 */
	addBlockedTools(context: IsolatedContext, tools: string[]): void {
		const existing = new Set(context.blockedTools)
		for (const t of tools) {
			existing.add(t)
		}
		context.blockedTools = [...existing]
	},

	/**
	 * Set the working directory for this context.
	 *
	 * @param context - The context to modify
	 * @param workdir - New working directory
	 */
	setWorkdir(context: IsolatedContext, workdir: string): void {
		context.workdir = path.resolve(workdir)
	},
}
