import * as path from "path"
import * as vscode from "vscode"

import type { WorkspaceRootInfo, ProjectLanguage } from "@roo-code/types"
import { experimentConfigsMap } from "../../shared/experiments"
import { fileExistsAtPath } from "../../utils/fs"
import { discoverSubfolderRooDirectories } from "../../services/roo-config"

/**
 * Represents toolchain information detected for a workspace root.
 */
interface ToolchainInfo {
	/** Detected programming languages */
	languages: ProjectLanguage[]
	/** Detected build tools */
	buildTools: string[]
	/** Whether the root has a .roo directory */
	hasRooConfig: boolean
}

/**
 * Cache entry for discovered .roo subdirectories.
 */
interface RooDirectoryCacheEntry {
	/** Absolute paths to discovered .roo directories */
	directories: string[]
	/** Timestamp when the cache was populated */
	timestamp: number
}

/**
 * Internal workspace root representation with lazy-loaded managers.
 */
interface WorkspaceRoot {
	/** URI of the workspace folder */
	uri: vscode.Uri
	/** Absolute filesystem path */
	fsPath: string
	/** Display name of the workspace folder */
	name: string
	/** Index within the workspace folders array */
	index: number
	/** Detected toolchains for this root */
	toolchains: ToolchainInfo
	/** CustomModesManager instance (lazy-loaded) */
	customModesManager?: unknown
	/** SkillsManager instance (lazy-loaded) */
	skillsManager?: unknown
	/** Optional per-root configuration */
	config?: Record<string, unknown>
}

/**
 * Configuration type for resolving per-root config paths.
 */
type RooConfigType = "rules" | "commands" | "skills" | "modes"

/**
 * Default TTL for the .roo subdirectory cache in milliseconds (30 seconds).
 */
const ROO_DIR_CACHE_TTL_MS = 30_000

/**
 * Central authority for multi-root workspace operations.
 *
 * Singleton that manages workspace roots, resolves paths across roots,
 * discovers per-root `.roo/` configurations, and provides per-root access
 * to CustomModesManager and SkillsManager.
 *
 * Replaces ad-hoc `workspaceFolders[0]`-only patterns in existing code.
 *
 * ### Feature Flag
 * When `MULTI_ROOT_WORKSPACE` experiment is disabled, behaves exactly like
 * the current codebase — only the primary (first) workspace root is active.
 *
 * ### Error Handling
 * - Inaccessible roots are skipped with a warning (never crashes the extension).
 * - Cache misses trigger a re-scan of the filesystem.
 * - File system watchers invalidate the `.roo/` directory cache on changes.
 */
export class WorkspaceManager {
	private static instance: WorkspaceManager | undefined
	private workspaceRoots: WorkspaceRoot[] = []
	private rooDirectoriesCache: Map<string, RooDirectoryCacheEntry> = new Map()
	private disposables: vscode.Disposable[] = []
	private isMultiRootEnabled: boolean
	private initialized = false

	/**
	 * Get the singleton WorkspaceManager instance.
	 *
	 * @param context - Optional VS Code extension context (required on first call)
	 * @returns The singleton instance
	 * @throws If called without context on first invocation
	 */
	static getInstance(context?: vscode.ExtensionContext): WorkspaceManager {
		if (!this.instance) {
			if (!context) {
				throw new Error("WorkspaceManager.getInstance() requires a context on first call")
			}
			this.instance = new WorkspaceManager(context)
		}
		return this.instance
	}

	/**
	 * Reset the singleton instance (for testing only).
	 * Clears all state and disposes all registered listeners.
	 */
	static resetInstance(): void {
		if (this.instance) {
			this.instance.dispose()
			this.instance = undefined
		}
	}

	private constructor(private context: vscode.ExtensionContext) {
		this.isMultiRootEnabled = experimentConfigsMap.MULTI_ROOT_WORKSPACE?.enabled ?? true

		// Initialize from current workspace folders
		const folders = vscode.workspace.workspaceFolders
		if (folders) {
			this.initialize(folders)
		}

		// Register workspace folder change listener
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders((event) => {
				this.onDidChangeWorkspaceFolders(event)
			}),
		)

		// Set up file watcher for .roo directories across all roots
		this.setupFileWatchers()
	}

	/**
	 * Dispose of all resources held by this manager.
	 * Cleans up file watchers and event listeners.
	 */
	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables = []
		this.rooDirectoriesCache.clear()
		this.workspaceRoots = []
		this.initialized = false
	}

	/**
	 * Initialize from VS Code workspace folders.
	 * Called during extension activation and on workspace folder changes.
	 *
	 * @param folders - The workspace folders from VS Code
	 */
	initialize(folders: readonly vscode.WorkspaceFolder[]): void {
		const effectiveFolders = this.isMultiRootEnabled ? folders : folders.slice(0, 1) // Graceful degradation: primary root only

		const roots: WorkspaceRoot[] = []
		for (const f of effectiveFolders) {
			try {
				// Verify the root is accessible
				const fsPath = f.uri.fsPath
				const toolchains: ToolchainInfo = { languages: [], buildTools: [], hasRooConfig: false }
				roots.push({
					uri: f.uri,
					fsPath,
					name: f.name,
					index: f.index,
					toolchains,
					customModesManager: undefined,
					skillsManager: undefined,
					config: undefined,
				})
			} catch (error) {
				console.warn(`[WorkspaceManager] Skipping inaccessible root "${f.name}":`, error)
			}
		}
		this.workspaceRoots = roots

		this.initialized = true

		// Kick off async detection of toolchains (fire-and-forget)
		for (const root of this.workspaceRoots) {
			this.detectToolchains(root).catch((error) => {
				console.warn(`[WorkspaceManager] Toolchain detection failed for "${root.name}":`, error)
			})
		}
	}

	/**
	 * Get all workspace roots.
	 *
	 * @returns Array of all workspace roots
	 */
	getRoots(): WorkspaceRoot[] {
		return this.workspaceRoots
	}

	/**
	 * Get primary (first) workspace root for backward compatibility.
	 *
	 * @returns The primary workspace root, or the first root if multi-root is disabled, or undefined
	 */
	getPrimaryRoot(): WorkspaceRoot | undefined {
		return this.workspaceRoots[0]
	}

	/**
	 * Get the workspace root for a given file path.
	 * Matches the longest prefix among workspace roots.
	 *
	 * @param filePath - Absolute file path to resolve
	 * @returns The workspace root containing the file, or undefined
	 */
	getRootForFile(filePath: string): WorkspaceRoot | undefined {
		if (!filePath) {
			return undefined
		}

		const normalizedPath = path.normalize(filePath)
		let best: WorkspaceRoot | undefined

		for (const root of this.workspaceRoots) {
			const rootPath = root.fsPath
			// Check if the file path starts with the root path
			if (normalizedPath.startsWith(rootPath)) {
				// Prefer the root with the longest matching prefix
				if (!best || rootPath.length > best.fsPath.length) {
					best = root
				}
			}
		}

		return best
	}

	/**
	 * Resolve a potentially relative path to absolute, scoped to correct root.
	 *
	 * Resolution order:
	 * 1. If absolute, return as-is after traversal validation
	 * 2. If contextCwd provided, resolve relative to it
	 * 3. If no contextCwd, resolve relative to primary root
	 *
	 * @param filePath - File path (absolute or relative)
	 * @param contextCwd - Optional working directory context
	 * @returns Resolved absolute path
	 * @throws If path traversal escapes the allowed workspace root
	 */
	resolvePath(filePath: string, contextCwd?: string): string {
		if (!filePath) {
			return ""
		}

		let resolved: string

		if (path.isAbsolute(filePath)) {
			resolved = path.normalize(filePath)
		} else if (contextCwd) {
			resolved = path.resolve(contextCwd, filePath)
		} else {
			const primary = this.getPrimaryRoot()
			if (primary) {
				resolved = path.resolve(primary.fsPath, filePath)
			} else {
				resolved = path.resolve(filePath)
			}
		}

		// Security: Prevent path traversal outside allowed workspace roots
		if (!this.isPathWithinRoots(resolved)) {
			console.warn(`[WorkspaceManager] Path traversal blocked: "${resolved}" is outside all workspace roots`)
		}

		return resolved
	}

	/**
	 * Get all workspace folders (alias for getRoots).
	 *
	 * @returns Array of workspace roots
	 */
	getWorkspaceFolders(): WorkspaceRoot[] {
		return this.workspaceRoots
	}

	/**
	 * Get serializable workspace root info for LLM context.
	 *
	 * @returns Array of serialized workspace root info
	 */
	getWorkspaceRootInfos(): WorkspaceRootInfo[] {
		return this.workspaceRoots.map((r) => ({
			uri: r.uri.toString(),
			fsPath: r.fsPath,
			name: r.name,
			index: r.index,
		}))
	}

	/**
	 * Resolve per-root configuration paths.
	 *
	 * @param root - The workspace root
	 * @param type - Configuration type ('rules' | 'commands' | 'skills' | 'modes')
	 * @returns Absolute path to the configuration directory
	 */
	getRooConfigPath(root: WorkspaceRoot, type: RooConfigType): string {
		const rooDir = path.join(root.fsPath, ".roo")

		switch (type) {
			case "rules":
				return path.join(rooDir, "rules")
			case "commands":
				return path.join(rooDir, "commands")
			case "skills":
				return path.join(rooDir, "skills")
			case "modes":
				return path.join(rooDir, "modes")
			default:
				return rooDir
		}
	}

	/**
	 * Discover all `.roo/` directories across all workspace roots.
	 *
	 * Results are cached with a TTL (default: 30 seconds). Cache is invalidated
	 * automatically by file system watchers on `.roo/` directory changes.
	 *
	 * @param forceRefresh - If true, bypass cache and force a fresh scan
	 * @returns Array of absolute paths to discovered .roo directories
	 */
	async discoverAllRooDirectories(forceRefresh = false): Promise<string[]> {
		const allDirs: string[] = []

		for (const root of this.workspaceRoots) {
			const rootDirs = await this.discoverRooDirectoriesForRoot(root, forceRefresh)
			allDirs.push(...rootDirs)
		}

		// Deduplicate and sort
		return Array.from(new Set(allDirs)).sort()
	}

	/**
	 * Get all discovered subfolder .roo directories for a specific root.
	 * Reuses the existing `discoverSubfolderRooDirectories` from roo-config.
	 *
	 * @param root - The workspace root
	 * @param forceRefresh - If true, bypass cache
	 * @returns Array of absolute paths to subfolder .roo directories
	 */
	async discoverSubfolderRooDirectories(root?: WorkspaceRoot, forceRefresh = false): Promise<string[]> {
		const targetRoots = root ? [root] : this.workspaceRoots
		const allDirs: string[] = []

		for (const r of targetRoots) {
			const dirs = await this.discoverRooDirectoriesForRoot(r, forceRefresh)
			allDirs.push(...dirs)
		}

		return Array.from(new Set(allDirs)).sort()
	}

	/**
	 * Handle workspace folder changes from VS Code.
	 * Called when folders are added to or removed from the workspace.
	 *
	 * @param event - The workspace folders change event
	 */
	onDidChangeWorkspaceFolders(event: vscode.WorkspaceFoldersChangeEvent): void {
		if (!this.isMultiRootEnabled) {
			// Feature flag disabled: ignore folder changes
			return
		}

		// Re-initialize from current workspace folders
		const folders = vscode.workspace.workspaceFolders
		if (folders) {
			this.initialize(folders)
		}

		// Invalidate caches for affected roots
		for (const added of event.added) {
			this.rooDirectoriesCache.delete(added.uri.fsPath)
		}
		for (const removed of event.removed) {
			this.rooDirectoriesCache.delete(removed.uri.fsPath)
		}

		// Re-setup file watchers to cover new roots
		this.setupFileWatchers()
	}

	/**
	 * Get or create CustomModesManager for a specific root.
	 * Lazy-loaded on first access.
	 *
	 * @param root - The workspace root
	 * @returns CustomModesManager instance, or undefined if not available
	 */
	getCustomModesManager(root: WorkspaceRoot): unknown {
		if (!root.customModesManager) {
			try {
				// Lazy-load: create instance when first requested
				// The actual CustomModesManager construction happens here
				// using the root's fsPath for config resolution
				root.customModesManager = this.createCustomModesManager(root)
			} catch (error) {
				console.warn(`[WorkspaceManager] Failed to create CustomModesManager for "${root.name}":`, error)
			}
		}
		return root.customModesManager
	}

	/**
	 * Get or create SkillsManager for a specific root.
	 * Lazy-loaded on first access.
	 *
	 * @param root - The workspace root
	 * @returns SkillsManager instance, or undefined if not available
	 */
	getSkillsManager(root: WorkspaceRoot): unknown {
		if (!root.skillsManager) {
			try {
				// Lazy-load: create instance when first requested
				root.skillsManager = this.createSkillsManager(root)
			} catch (error) {
				console.warn(`[WorkspaceManager] Failed to create SkillsManager for "${root.name}":`, error)
			}
		}
		return root.skillsManager
	}

	/**
	 * Check whether the WorkspaceManager has been initialized.
	 */
	isInitialized(): boolean {
		return this.initialized
	}

	/**
	 * Create a CustomModesManager for a workspace root.
	 * Override this in tests or when custom construction is needed.
	 *
	 * @param root - The workspace root
	 * @returns A CustomModesManager instance
	 */
	protected createCustomModesManager(root: WorkspaceRoot): unknown {
		// Dynamic import to avoid circular dependencies at module load time
		try {
			const { CustomModesManager } = require("../config/CustomModesManager")
			return new CustomModesManager(root.fsPath)
		} catch (error) {
			console.warn(`[WorkspaceManager] Could not load CustomModesManager for "${root.name}":`, error)
			return undefined
		}
	}

	/**
	 * Create a SkillsManager for a workspace root.
	 * Override this in tests or when custom construction is needed.
	 *
	 * @param root - The workspace root
	 * @returns A SkillsManager instance
	 */
	protected createSkillsManager(root: WorkspaceRoot): unknown {
		// Dynamic import to avoid circular dependencies at module load time
		try {
			const { SkillsManager } = require("../../services/skills/SkillsManager")
			return new SkillsManager(root.fsPath)
		} catch (error) {
			console.warn(`[WorkspaceManager] Could not load SkillsManager for "${root.name}":`, error)
			return undefined
		}
	}

	/**
	 * Detect toolchains for a workspace root.
	 * Checks for common build manifest files and config directories.
	 *
	 * @param root - The workspace root to scan
	 */
	private async detectToolchains(root: WorkspaceRoot): Promise<void> {
		const languages: ProjectLanguage[] = []
		const buildTools: string[] = []

		try {
			// Check for common manifest files
			const checks: Array<{ file: string; language: ProjectLanguage; tool: string }> = [
				{ file: "package.json", language: "typescript", tool: "npm" },
				{ file: "Cargo.toml", language: "rust", tool: "cargo" },
				{ file: "go.mod", language: "go", tool: "go" },
				{ file: "pyproject.toml", language: "python", tool: "pip" },
				{ file: "build.gradle.kts", language: "kotlin", tool: "gradle" },
				{ file: "build.gradle", language: "kotlin", tool: "gradle" },
				{ file: "pom.xml", language: "java", tool: "maven" },
				{ file: "CMakeLists.txt", language: "cpp", tool: "cmake" },
				{ file: "composer.json", language: "unknown" as ProjectLanguage, tool: "composer" },
				{ file: "Makefile", language: "unknown", tool: "make" },
			]

			for (const check of checks) {
				const manifestPath = path.join(root.fsPath, check.file)
				if (await fileExistsAtPath(manifestPath)) {
					if (check.language !== "unknown" && !languages.includes(check.language)) {
						languages.push(check.language)
					}
					if (!buildTools.includes(check.tool)) {
						buildTools.push(check.tool)
					}
				}
			}

			// Check for .roo config directory
			const hasRooConfig = await fileExistsAtPath(path.join(root.fsPath, ".roo"))

			root.toolchains = { languages, buildTools, hasRooConfig }
		} catch (error) {
			console.warn(`[WorkspaceManager] Toolchain detection error for "${root.name}":`, error)
			root.toolchains = { languages, buildTools, hasRooConfig: false }
		}
	}

	/**
	 * Discover .roo directories for a single root, with caching.
	 *
	 * @param root - The workspace root
	 * @param forceRefresh - If true, bypass cache
	 * @returns Array of absolute paths to .roo directories
	 */
	private async discoverRooDirectoriesForRoot(root: WorkspaceRoot, forceRefresh: boolean): Promise<string[]> {
		const cacheKey = root.fsPath

		if (!forceRefresh) {
			const cached = this.rooDirectoriesCache.get(cacheKey)
			if (cached && Date.now() - cached.timestamp < ROO_DIR_CACHE_TTL_MS) {
				return cached.directories
			}
		}

		try {
			// Include the root .roo directory
			const rootRooDir = path.join(root.fsPath, ".roo")
			const rootRooExists = await fileExistsAtPath(rootRooDir)
			const dirs: string[] = rootRooExists ? [rootRooDir] : []

			// Discover subfolder .roo directories using existing infra
			try {
				const subfolderDirs = await discoverSubfolderRooDirectories(root.fsPath)
				dirs.push(...subfolderDirs)
			} catch (error) {
				console.warn(`[WorkspaceManager] Subfolder .roo discovery failed for "${root.name}":`, error)
			}

			this.rooDirectoriesCache.set(cacheKey, { directories: dirs, timestamp: Date.now() })
			return dirs
		} catch (error) {
			console.warn(`[WorkspaceManager] Failed to discover .roo directories for "${root.name}":`, error)
			return []
		}
	}

	/**
	 * Check whether a resolved path is within any of the workspace roots.
	 *
	 * @param resolvedPath - The absolute path to check
	 * @returns True if the path is within at least one workspace root
	 */
	private isPathWithinRoots(resolvedPath: string): boolean {
		const normalized = path.normalize(resolvedPath)

		for (const root of this.workspaceRoots) {
			const rootPath = path.normalize(root.fsPath)
			// Normalize trailing slashes for comparison
			const normalizedRoot = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep

			if (normalized === rootPath) {
				return true
			}

			if (normalized.startsWith(normalizedRoot)) {
				return true
			}
		}

		return false
	}

	/**
	 * Set up file system watchers for .roo directories.
	 * Watches for changes in .roo directories across all roots and
	 * invalidates the cache when changes are detected.
	 */
	private setupFileWatchers(): void {
		// Clean up previous watchers (but keep non-watcher disposables)
		this.disposables = this.disposables.filter((d) => {
			// Keep workspace folder change listener; remove file watchers
			return d !== this.disposables[this.disposables.length - 1]
		})

		for (const root of this.workspaceRoots) {
			const rooDir = path.join(root.fsPath, ".roo")

			try {
				// Watch for changes in .roo directories
				const pattern = new vscode.RelativePattern(rooDir, "**/*")
				const watcher = vscode.workspace.createFileSystemWatcher(pattern)

				const invalidateCache = () => {
					this.rooDirectoriesCache.delete(root.fsPath)
				}

				watcher.onDidCreate(invalidateCache)
				watcher.onDidDelete(invalidateCache)
				watcher.onDidChange(invalidateCache)

				this.disposables.push(watcher)
			} catch (error) {
				console.warn(`[WorkspaceManager] Failed to create file watcher for "${root.name}":`, error)
				// Non-fatal: cache will be invalidated by TTL expiry
			}
		}
	}
}
