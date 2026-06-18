import fs from "fs/promises"
import * as path from "path"

/**
 * Asynchronously creates all non-existing subdirectories for a given file path
 * and collects them in an array for later deletion.
 *
 * @param filePath - The full path to a file.
 * @returns A promise that resolves to an array of newly created directories.
 */
export async function createDirectoriesForFile(filePath: string): Promise<string[]> {
	const newDirectories: string[] = []
	const normalizedFilePath = path.normalize(filePath) // Normalize path for cross-platform compatibility
	const directoryPath = path.dirname(normalizedFilePath)

	let currentPath = directoryPath
	const dirsToCreate: string[] = []

	// Traverse up the directory tree and collect missing directories
	while (!(await fileExistsAtPath(currentPath))) {
		dirsToCreate.push(currentPath)
		currentPath = path.dirname(currentPath)
	}

	// Create directories from the topmost missing one down to the target directory
	for (let i = dirsToCreate.length - 1; i >= 0; i--) {
		await fs.mkdir(dirsToCreate[i])
		newDirectories.push(dirsToCreate[i])
	}

	return newDirectories
}

/**
 * Helper function to check if a path exists.
 *
 * @param path - The path to check.
 * @returns A promise that resolves to true if the path exists, false otherwise.
 */
export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

// ─── Cache for discoverSubfolderRooDirectories ─────────────────────────────

interface RooDirCacheEntry {
	/** Absolute paths to discovered .roo directories */
	directories: string[]
	/** Timestamp when the cache was populated */
	timestamp: number
}

const ROO_DIR_CACHE = new Map<string, RooDirCacheEntry>()
const ROO_DIR_CACHE_TTL_MS = 30_000 // 30 seconds

/**
 * Known directories to exclude from recursive scans.
 */
const EXCLUDED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".next",
	".nuxt",
	".gradle",
	".idea",
	".vscode",
	"coverage",
	".nyc_output",
	".turbo",
	".cache",
	".pnpm-store",
	".roo",
])

/**
 * Directories of a project's manifest files that identify sub-project roots.
 */
const PROJECT_MANIFESTS = [
	"package.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"setup.py",
	"requirements.txt",
	"build.gradle.kts",
	"build.gradle",
	"pom.xml",
	"CMakeLists.txt",
	"composer.json",
	"Makefile",
] as const

/**
 * Discover all `.roo/` subdirectories within a given root path.
 *
 * Recursively walks the directory tree (up to `maxDepth` levels) looking for
 * directories named `.roo/`. Skips common exclusion directories like
 * `node_modules/`, `.git/`, `dist/`, etc.
 *
 * Results are cached with a 30-second TTL to avoid repeated filesystem scans.
 *
 * @param rootPath - Absolute path to start scanning from
 * @param maxDepth - Maximum recursion depth (default: 8)
 * @param forceRefresh - If true, bypass cache and force a fresh scan
 * @returns Array of absolute paths to discovered .roo directories
 */
export async function discoverSubfolderRooDirectories(
	rootPath: string,
	maxDepth = 8,
	forceRefresh = false,
): Promise<string[]> {
	// Check cache first
	if (!forceRefresh) {
		const cached = ROO_DIR_CACHE.get(rootPath)
		if (cached && Date.now() - cached.timestamp < ROO_DIR_CACHE_TTL_MS) {
			return cached.directories
		}
	}

	const results: string[] = []

	try {
		await walkForRooDirs(rootPath, 0, maxDepth, results)
	} catch (error) {
		console.warn(`[discoverSubfolderRooDirectories] Scan failed for "${rootPath}":`, error)
	}

	// Deduplicate and sort
	const unique = Array.from(new Set(results)).sort()

	// Update cache
	ROO_DIR_CACHE.set(rootPath, { directories: unique, timestamp: Date.now() })

	return unique
}

/**
 * Recursively walk a directory tree looking for `.roo/` subdirectories.
 *
 * @param dirPath - Current directory path
 * @param depth - Current recursion depth
 * @param maxDepth - Maximum recursion depth
 * @param results - Accumulator array for discovered directories
 */
async function walkForRooDirs(dirPath: string, depth: number, maxDepth: number, results: string[]): Promise<void> {
	if (depth > maxDepth) {
		return
	}

	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name)

			if (entry.isDirectory()) {
				// Skip excluded directories (except .roo itself)
				if (EXCLUDED_DIRS.has(entry.name) && entry.name !== ".roo") {
					continue
				}

				// Found a .roo directory
				if (entry.name === ".roo") {
					results.push(fullPath)
					continue // Don't recurse into .roo itself
				}

				// Recurse into subdirectory
				await walkForRooDirs(fullPath, depth + 1, maxDepth, results)
			}
		}
	} catch (error) {
		// Permission denied or other non-fatal errors — skip silently
		console.warn(`[discoverSubfolderRooDirectories] Cannot read directory "${dirPath}":`, error)
	}
}

/**
 * Check whether a given path is a sub-project root (contains a recognizable
 * project manifest file).
 *
 * Checks for the presence of any known build manifest file in the directory:
 * `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, etc.
 *
 * @param dirPath - Absolute path to check
 * @returns True if the path contains a recognizable project manifest
 */
export async function isSubProjectRoot(dirPath: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true })

		for (const entry of entries) {
			if (entry.isFile() && isKnownManifest(entry.name)) {
				return true
			}
		}

		return false
	} catch {
		return false
	}
}

/**
 * Find all project manifest files in a directory.
 *
 * Searches for known build manifest files (`package.json`, `Cargo.toml`,
 * `go.mod`, etc.) within the given directory (non-recursive).
 *
 * @param rootPath - Absolute path to the directory to search
 * @returns Array of absolute paths to discovered manifest files
 */
export async function findProjectManifests(rootPath: string): Promise<string[]> {
	const manifests: string[] = []

	try {
		const entries = await fs.readdir(rootPath, { withFileTypes: true })

		for (const entry of entries) {
			if (entry.isFile() && isKnownManifest(entry.name)) {
				manifests.push(path.join(rootPath, entry.name))
			}
		}
	} catch (error) {
		console.warn(`[findProjectManifests] Failed to read directory "${rootPath}":`, error)
	}

	return manifests
}

/**
 * Safely read and parse a JSON file, returning null on any error.
 *
 * Provides a single-catch wrapper around `fs.readFile` + `JSON.parse`
 * for safe configuration file reading. Logs a warning on failure.
 *
 * @param filePath - Absolute path to the JSON file
 * @returns Parsed JSON value, or null if the file doesn't exist or is invalid
 */
export async function safeReadJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		const content = await fs.readFile(filePath, "utf-8")
		return JSON.parse(content) as T
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[safeReadJsonFile] Failed to read/parse "${filePath}":`, error)
		}
		return null
	}
}

/**
 * Check if a filename is a known project build manifest.
 *
 * @param fileName - The filename to check
 * @returns True if the filename matches a known manifest
 */
function isKnownManifest(fileName: string): boolean {
	return (PROJECT_MANIFESTS as readonly string[]).includes(fileName)
}

/**
 * Clear the internal cache used by `discoverSubfolderRooDirectories`.
 * Useful for testing or when filesystem changes are known to have occurred.
 */
export function clearRooDirCache(): void {
	ROO_DIR_CACHE.clear()
}
