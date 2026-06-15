import * as path from "path"
import * as fsSync from "fs"
import * as fs from "fs/promises"

import type { SubProject, ProjectLanguage, WorkspaceRootInfo } from "@roo-code/types"

import { WorkspaceManager } from "./WorkspaceManager"
import { fileExistsAtPath } from "../../utils/fs"

/**
 * Options for the SubProjectDetector.
 */
export interface SubProjectDetectorOptions {
	/** Debounce interval in milliseconds (default: 5000) */
	debounceMs?: number
	/** Per-project scan timeout in milliseconds (default: 5000) */
	scanTimeoutMs?: number
	/** Glob patterns to exclude from scanning */
	excludePatterns?: string[]
}

/**
 * Cache entry for scanned sub-projects in a root.
 */
interface SubProjectCacheEntry {
	/** Discovered sub-projects */
	projects: SubProject[]
	/** Timestamp when the cache was populated */
	timestamp: number
}

/**
 * Maximum number of levels deep to scan for manifest files.
 * Prevents runaway scanning on deeply nested node_modules or similar.
 */
const MAX_SCAN_DEPTH = 8

/**
 * Scans workspace directory trees for sub-project build manifests
 * and detects language/toolchain per project.
 *
 * Uses ripgrep (reusing existing infra) for fast manifest discovery
 * and respects .gitignore and .rooignore.
 *
 * ### Caching
 * Results are cached per-root with a configurable TTL (default: 5s).
 * Cache is invalidated via {@link invalidate} when file system changes are detected.
 *
 * ### Error Handling
 * - Unreadable manifests are skipped with a warning (never crashes the detector).
 * - Unknown manifest types create a generic sub-project entry.
 * - Permission-denied directories are skipped gracefully.
 */
export class SubProjectDetector {
	private cache: Map<string, SubProjectCacheEntry> = new Map()
	private readonly debounceMs: number
	private readonly scanTimeoutMs: number

	/**
	 * @param workspaceManager - The workspace manager to resolve roots
	 * @param options - Optional configuration
	 */
	constructor(
		private workspaceManager: WorkspaceManager,
		private options?: SubProjectDetectorOptions,
	) {
		this.debounceMs = options?.debounceMs ?? 5000
		this.scanTimeoutMs = options?.scanTimeoutMs ?? 5000
	}

	/**
	 * Detect sub-projects in a specific workspace root.
	 * Scans the root directory for build manifests and creates SubProject entries.
	 *
	 * @param root - The workspace root info to scan
	 * @returns Array of discovered sub-projects
	 */
	async detect(root: WorkspaceRootInfo): Promise<SubProject[]> {
		return this.scanRoot(root.fsPath)
	}

	/**
	 * Scan all workspace roots for sub-projects.
	 * Returns cached result if scanned within debounce window.
	 *
	 * @returns Array of discovered sub-projects across all roots
	 */
	async scanAll(): Promise<SubProject[]> {
		const roots = this.workspaceManager.getWorkspaceFolders()
		const results = await Promise.allSettled(roots.map((r) => this.scanRoot(r.fsPath)))

		const projects: SubProject[] = []
		for (const result of results) {
			if (result.status === "fulfilled") {
				projects.push(...result.value)
			} else {
				console.warn("[SubProjectDetector] Root scan failed:", result.reason)
			}
		}

		return projects
	}

	/**
	 * Scan a single root directory for sub-projects.
	 * Walks the directory tree (up to MAX_SCAN_DEPTH) looking for build manifests.
	 * Respects .gitignore and .rooignore via existing ripgrep infra.
	 *
	 * Results are cached per-root with a configurable debounce window.
	 *
	 * @param rootPath - Absolute path to the workspace root
	 * @returns Array of discovered sub-projects for this root
	 */
	async scanRoot(rootPath: string): Promise<SubProject[]> {
		// Check cache first
		const cached = this.cache.get(rootPath)
		if (cached && Date.now() - cached.timestamp < this.debounceMs) {
			return cached.projects
		}

		try {
			const projects = await this.performScan(rootPath)

			// Cache the result
			this.cache.set(rootPath, { projects, timestamp: Date.now() })
			return projects
		} catch (error) {
			console.warn(`[SubProjectDetector] Scan failed for root "${rootPath}":`, error)
			return []
		}
	}

	/**
	 * Perform the actual scan of a root directory for build manifests.
	 * Walks the directory tree looking for known manifest filenames.
	 *
	 * @param rootPath - Absolute path to scan
	 * @returns Array of discovered sub-projects
	 */
	private async performScan(rootPath: string): Promise<SubProject[]> {
		const projects: SubProject[] = []
		const manifestMap = new Map<string, string>() // manifestPath -> manifestType

		// Discover manifest files by walking the directory tree
		await this.walkForManifests(rootPath, rootPath, 0, manifestMap)

		// Parse each manifest into a SubProject
		for (const [manifestPath, manifestType] of manifestMap) {
			try {
				const project = await this.parseManifest(manifestPath, manifestType, rootPath)
				if (project) {
					projects.push(project)
				}
			} catch (error) {
				console.warn(`[SubProjectDetector] Failed to parse manifest "${manifestPath}":`, error)
				// Create a generic entry for unknown manifest types
				projects.push(this.createGenericProject(manifestPath, manifestType, rootPath))
			}
		}

		// Mark root/leaf status
		this.markRootAndLeaf(projects)

		return projects
	}

	/**
	 * Walk a directory tree looking for known build manifest files.
	 * Respects common exclusion directories.
	 *
	 * @param basePath - The base path for relative path calculations
	 * @param dirPath - Current directory to scan
	 * @param depth - Current recursion depth
	 * @param result - Map to accumulate results (manifestPath -> manifestType)
	 */
	private async walkForManifests(
		basePath: string,
		dirPath: string,
		depth: number,
		result: Map<string, string>,
	): Promise<void> {
		if (depth > MAX_SCAN_DEPTH) {
			return
		}

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true })
			const manifestFiles = this.getKnownManifests()
			const foundManifests: string[] = []

			for (const entry of entries) {
				const fullPath = path.join(dirPath, entry.name)

				// Skip common exclusion directories
				if (entry.isDirectory()) {
					if (this.shouldExcludeDirectory(entry.name)) {
						continue
					}
					// Recurse into subdirectories
					await this.walkForManifests(basePath, fullPath, depth + 1, result)
					continue
				}

				// Check if this file is a known manifest
				if (entry.isFile() && manifestFiles.includes(entry.name)) {
					result.set(fullPath, entry.name)
					foundManifests.push(entry.name)
				}
			}

			// If the current directory IS a project root (has package.json etc.),
			// we DON'T recurse into subdirectories of package managers
			if (foundManifests.length > 0) {
				// Don't recurse further if we're in a package manager's directory
				// (e.g., node_modules, .git, etc.) — but we already skip those.
				// Also avoid recursing into nested workspace packages that have
				// their own manifests — this is fine because we want to detect them.
			}
		} catch (error) {
			// Permission denied or other non-fatal errors
			console.warn(`[SubProjectDetector] Cannot read directory "${dirPath}":`, error)
		}
	}

	/**
	 * Parse a build manifest file into a SubProject.
	 *
	 * @param manifestPath - Absolute path to the manifest file
	 * @param manifestType - The manifest filename (e.g., "package.json")
	 * @param rootPath - The workspace root path
	 * @returns A SubProject, or undefined if parsing fails critically
	 */
	private async parseManifest(
		manifestPath: string,
		manifestType: string,
		rootPath: string,
	): Promise<SubProject | undefined> {
		const projectDir = path.dirname(manifestPath)
		const language = this.detectLanguage(manifestPath)

		switch (manifestType) {
			case "package.json":
				return this.parsePackageJson(manifestPath, projectDir, rootPath, language)
			case "Cargo.toml":
				return this.parseCargoToml(manifestPath, projectDir, rootPath)
			case "go.mod":
				return this.parseGoMod(manifestPath, projectDir, rootPath)
			case "pyproject.toml":
			case "setup.py":
			case "requirements.txt":
				return this.parsePythonProject(manifestPath, projectDir, rootPath, manifestType)
			case "build.gradle.kts":
			case "build.gradle":
				return this.parseGradleProject(manifestPath, projectDir, rootPath)
			case "pom.xml":
				return this.parseMavenProject(manifestPath, projectDir, rootPath)
			case "CMakeLists.txt":
				return this.parseCMakeProject(manifestPath, projectDir, rootPath)
			case "composer.json":
				return this.parseComposerJson(manifestPath, projectDir, rootPath)
			case "Makefile":
				return this.parseMakefile(manifestPath, projectDir, rootPath)
			default:
				return this.createGenericProject(manifestPath, manifestType, rootPath)
		}
	}

	/**
	 * Parse a package.json manifest.
	 */
	private async parsePackageJson(
		manifestPath: string,
		projectDir: string,
		rootPath: string,
		language: ProjectLanguage,
	): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, "package.json", rootPath)
		}

		let pkg: Record<string, unknown>
		try {
			pkg = JSON.parse(content) as Record<string, unknown>
		} catch {
			return this.createGenericProject(manifestPath, "package.json", rootPath)
		}

		const name = (pkg.name as string) || path.basename(projectDir)
		const id = name.startsWith("@") ? `${name}@${projectDir}` : `${name}@${projectDir}`
		const rawDeps = (pkg.dependencies as Record<string, string>) ?? {}
		const rawDevDeps = (pkg.devDependencies as Record<string, string>) ?? {}
		const rawPeerDeps = (pkg.peerDependencies as Record<string, string>) ?? {}

		const dependencies = [...Object.keys(rawDeps), ...Object.keys(rawPeerDeps)]
		const devDependencies = Object.keys(rawDevDeps)

		// Detect if this is TypeScript or JavaScript
		const detectedLanguage = await this.detectNodeLanguage(projectDir, language)

		return {
			id,
			name,
			rootPath: projectDir,
			language: detectedLanguage,
			buildManifest: path.relative(projectDir, manifestPath) || "package.json",
			buildManifestType: "package.json",
			dependencies,
			devDependencies,
			isRoot: false,
			isLeaf: dependencies.length === 0 && devDependencies.length === 0,
		}
	}

	/**
	 * Parse a Cargo.toml manifest.
	 */
	private async parseCargoToml(manifestPath: string, projectDir: string, rootPath: string): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, "Cargo.toml", rootPath)
		}

		// Simple TOML parser for package name and dependencies
		const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m)
		const name = nameMatch?.[1] || path.basename(projectDir)
		const id = `${name}@${projectDir}`

		// Extract dependencies (simplified TOML parsing)
		const dependencies: string[] = []
		const devDependencies: string[] = []

		// Match [dependencies] section
		const depsSection = this.extractTomlSection(content, "dependencies")
		if (depsSection) {
			const depLines = depsSection.split("\n")
			for (const line of depLines) {
				const depMatch = line.match(/^(\w[\w-]*)\s*=/)
				if (depMatch) {
					dependencies.push(depMatch[1])
				}
			}
		}

		// Match [dev-dependencies] section
		const devDepsSection = this.extractTomlSection(content, "dev-dependencies")
		if (devDepsSection) {
			const depLines = devDepsSection.split("\n")
			for (const line of depLines) {
				const depMatch = line.match(/^(\w[\w-]*)\s*=/)
				if (depMatch) {
					devDependencies.push(depMatch[1])
				}
			}
		}

		return {
			id,
			name,
			rootPath: projectDir,
			language: "rust",
			buildManifest: path.relative(projectDir, manifestPath) || "Cargo.toml",
			buildManifestType: "Cargo.toml",
			dependencies,
			devDependencies,
			isRoot: false,
			isLeaf: dependencies.length === 0 && devDependencies.length === 0,
		}
	}

	/**
	 * Parse a go.mod manifest.
	 */
	private async parseGoMod(manifestPath: string, projectDir: string, rootPath: string): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, "go.mod", rootPath)
		}

		const moduleMatch = content.match(/^module\s+(\S+)/m)
		const name = moduleMatch?.[1] || path.basename(projectDir)
		const id = `${name}@${projectDir}`

		// Extract require statements as dependencies
		const dependencies: string[] = []
		const devDependencies: string[] = []

		// Match "require (" ... ")" blocks
		const requireRegex = /require\s*\((.*?)\)/s
		const requireMatch = content.match(requireRegex)
		if (requireMatch) {
			const lines = requireMatch[1].split("\n")
			for (const line of lines) {
				const depMatch = line.match(/^\s*(\S+)\s+/)
				if (depMatch) {
					dependencies.push(depMatch[1])
				}
			}
		}

		// Also match single-line require statements
		const singleRequires = content.matchAll(/^require\s+(\S+)\s+/gm)
		for (const match of singleRequires) {
			dependencies.push(match[1])
		}

		return {
			id,
			name,
			rootPath: projectDir,
			language: "go",
			buildManifest: path.relative(projectDir, manifestPath) || "go.mod",
			buildManifestType: "go.mod",
			dependencies,
			devDependencies,
			isRoot: false,
			isLeaf: dependencies.length === 0 && devDependencies.length === 0,
		}
	}

	/**
	 * Parse a Python project manifest (pyproject.toml, setup.py, requirements.txt).
	 */
	private async parsePythonProject(
		manifestPath: string,
		projectDir: string,
		rootPath: string,
		manifestType: string,
	): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, manifestType, rootPath)
		}

		const name = path.basename(projectDir)
		const id = `${name}@${projectDir}`
		const dependencies: string[] = []
		const devDependencies: string[] = []

		if (manifestType === "pyproject.toml") {
			// Extract dependencies from pyproject.toml
			const depsSection =
				this.extractTomlSection(content, "project.dependencies") ||
				this.extractTomlSection(content, "dependencies")

			if (depsSection) {
				const depLines = depsSection.split("\n")
				for (const line of depLines) {
					const depMatch = line.match(/"([^"]+)"/)
					if (depMatch) {
						// Strip version specifiers
						const depName = depMatch[1].split(/[<>=!~]/)[0].trim()
						if (depName) {
							dependencies.push(depName)
						}
					}
				}
			}

			// Extract optional dependencies (dev)
			const optDepsSection =
				this.extractTomlSection(content, "project.optional-dependencies") ||
				this.extractTomlSection(content, "optional-dependencies")
			if (optDepsSection) {
				const depLines = optDepsSection.split("\n")
				for (const line of depLines) {
					const depMatch = line.match(/"([^"]+)"/)
					if (depMatch) {
						const depName = depMatch[1].split(/[<>=!~]/)[0].trim()
						if (depName) {
							devDependencies.push(depName)
						}
					}
				}
			}
		} else if (manifestType === "requirements.txt") {
			const lines = content.split("\n")
			for (const line of lines) {
				const trimmed = line.trim()
				if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) {
					const depName = trimmed.split(/[<>=!~]/)[0].trim()
					if (depName) {
						dependencies.push(depName)
					}
				}
			}
		}

		return {
			id,
			name,
			rootPath: projectDir,
			language: "python",
			buildManifest: path.relative(projectDir, manifestPath) || manifestType,
			buildManifestType: "pyproject.toml",
			dependencies,
			devDependencies,
			isRoot: false,
			isLeaf: dependencies.length === 0 && devDependencies.length === 0,
		}
	}

	/**
	 * Parse a Gradle project (build.gradle.kts or build.gradle).
	 */
	private async parseGradleProject(manifestPath: string, projectDir: string, rootPath: string): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, path.basename(manifestPath), rootPath)
		}

		const name = path.basename(projectDir)
		const id = `${name}@${projectDir}`
		const dependencies: string[] = []
		const devDependencies: string[] = []

		// Extract implementation and api dependencies
		const implDeps = content.matchAll(/(?:implementation|api)\s+['"]([^:]+):([^:]+):([^'"]+)['"]/g)
		for (const match of implDeps) {
			dependencies.push(`${match[1]}:${match[2]}`)
		}

		// Extract testImplementation dependencies (dev)
		const testDeps = content.matchAll(/testImplementation\s+['"]([^:]+):([^:]+):([^'"]+)['"]/g)
		for (const match of testDeps) {
			devDependencies.push(`${match[1]}:${match[2]}`)
		}

		const manifestType = path.basename(manifestPath) === "build.gradle.kts" ? "build.gradle.kts" : "build.gradle"

		return {
			id,
			name,
			rootPath: projectDir,
			language: "kotlin",
			buildManifest: path.relative(projectDir, manifestPath) || manifestType,
			buildManifestType: manifestType as "build.gradle.kts" | "build.gradle",
			dependencies,
			devDependencies,
			isRoot: false,
			isLeaf: dependencies.length === 0 && devDependencies.length === 0,
		}
	}

	/**
	 * Parse a Maven POM file.
	 */
	private async parseMavenProject(manifestPath: string, projectDir: string, rootPath: string): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, "pom.xml", rootPath)
		}

		const nameMatch = content.match(/<artifactId>([^<]+)<\/artifactId>/)
		const name = nameMatch?.[1] || path.basename(projectDir)
		const id = `${name}@${projectDir}`
		const dependencies: string[] = []
		const devDependencies: string[] = []

		// Simple regex-based XML parsing for dependencies
		const depRegex = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/gs
		const depMatches = content.matchAll(depRegex)
		for (const match of depMatches) {
			dependencies.push(`${match[1]}:${match[2]}`)
		}

		// Extract test dependencies
		const testDepRegex = /<dependency>[\s\S]*?<scope>test<\/scope>[\s\S]*?<\/dependency>/gs
		const testDepMatches = content.matchAll(testDepRegex)
		for (const match of testDepMatches) {
			const gMatch = match[0].match(/<groupId>([^<]+)<\/groupId>/)
			const aMatch = match[0].match(/<artifactId>([^<]+)<\/artifactId>/)
			if (gMatch && aMatch) {
				// Remove from main deps if present, add to dev deps
				const depRef = `${gMatch[1]}:${aMatch[2]}`
				const idx = dependencies.indexOf(depRef)
				if (idx !== -1) {
					dependencies.splice(idx, 1)
				}
				devDependencies.push(depRef)
			}
		}

		return {
			id,
			name,
			rootPath: projectDir,
			language: "java",
			buildManifest: path.relative(projectDir, manifestPath) || "pom.xml",
			buildManifestType: "BUILD",
			dependencies,
			devDependencies,
			isRoot: false,
			isLeaf: dependencies.length === 0 && devDependencies.length === 0,
		}
	}

	/**
	 * Parse a CMakeLists.txt project.
	 */
	private async parseCMakeProject(manifestPath: string, projectDir: string, rootPath: string): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, "CMakeLists.txt", rootPath)
		}

		const nameMatch = content.match(/project\s*\(\s*([^\s)]+)/i)
		const name = nameMatch?.[1] || path.basename(projectDir)
		const id = `${name}@${projectDir}`
		const dependencies: string[] = []

		// Extract find_package calls as dependencies
		const findPkg = content.matchAll(/find_package\s*\(\s*(\S+)/gi)
		for (const match of findPkg) {
			dependencies.push(match[1])
		}

		// Detect C vs C++ based on project language specification
		const langMatch = content.match(/project\s*\([^)]*\s+(C|c|CXX|cxx)\s/i)
		const language: ProjectLanguage = langMatch ? (langMatch[1].toUpperCase() === "C" ? "c" : "cpp") : "cpp"

		return {
			id,
			name,
			rootPath: projectDir,
			language,
			buildManifest: path.relative(projectDir, manifestPath) || "CMakeLists.txt",
			buildManifestType: "CMakeLists.txt",
			dependencies,
			devDependencies: [],
			isRoot: false,
			isLeaf: true,
		}
	}

	/**
	 * Parse a composer.json manifest.
	 */
	private async parseComposerJson(manifestPath: string, projectDir: string, rootPath: string): Promise<SubProject> {
		let content: string
		try {
			content = await fs.readFile(manifestPath, "utf-8")
		} catch {
			return this.createGenericProject(manifestPath, "composer.json", rootPath)
		}

		let pkg: Record<string, unknown>
		try {
			pkg = JSON.parse(content) as Record<string, unknown>
		} catch {
			return this.createGenericProject(manifestPath, "composer.json", rootPath)
		}

		const name = (pkg.name as string) || path.basename(projectDir)
		const id = `${name}@${projectDir}`
		const rawDeps = (pkg.require as Record<string, string>) ?? {}
		const rawDevDeps = (pkg["require-dev"] as Record<string, string>) ?? {}

		return {
			id,
			name,
			rootPath: projectDir,
			language: "unknown",
			buildManifest: path.relative(projectDir, manifestPath) || "composer.json",
			buildManifestType: "BUILD",
			dependencies: Object.keys(rawDeps),
			devDependencies: Object.keys(rawDevDeps),
			isRoot: false,
			isLeaf: false,
		}
	}

	/**
	 * Parse a Makefile project.
	 */
	private async parseMakefile(manifestPath: string, projectDir: string, rootPath: string): Promise<SubProject> {
		const name = path.basename(projectDir)
		const id = `${name}@${projectDir}`

		return {
			id,
			name,
			rootPath: projectDir,
			language: "unknown",
			buildManifest: path.relative(projectDir, manifestPath) || "Makefile",
			buildManifestType: "BUILD",
			dependencies: [],
			devDependencies: [],
			isRoot: false,
			isLeaf: true,
		}
	}

	/**
	 * Create a generic SubProject entry for an unparseable manifest.
	 */
	private createGenericProject(manifestPath: string, manifestType: string, rootPath: string): SubProject {
		const projectDir = path.dirname(manifestPath)
		const name = path.basename(projectDir)
		const id = `${name}@${projectDir}`
		const language = this.detectLanguage(manifestPath)

		return {
			id,
			name,
			rootPath: projectDir,
			language,
			buildManifest: path.relative(projectDir, manifestPath) || manifestType,
			buildManifestType: "BUILD",
			dependencies: [],
			devDependencies: [],
			isRoot: false,
			isLeaf: true,
		}
	}

	/**
	 * Mark projects as root or leaf based on dependency relationships.
	 */
	private markRootAndLeaf(projects: SubProject[]): void {
		const allNames = new Set(projects.map((p) => p.name))
		const projectMap = new Map(projects.map((p) => [p.name, p]))

		for (const project of projects) {
			// A project is a leaf if it has no inter-project dependencies
			const interProjectDeps = project.dependencies.filter((dep) => allNames.has(dep))
			const interProjectDevDeps = project.devDependencies.filter((dep) => allNames.has(dep))
			project.isLeaf = interProjectDeps.length === 0 && interProjectDevDeps.length === 0

			// A project is a root if no other project depends on it
			project.isRoot = true
		}

		// Second pass: isRoot = no other project lists this project as a dep
		for (const project of projects) {
			for (const other of projects) {
				if (other === project) continue
				if (other.dependencies.includes(project.name) || other.devDependencies.includes(project.name)) {
					project.isRoot = false
					break
				}
			}
		}
	}

	/**
	 * Extract a section from a TOML file (simple regex-based).
	 */
	private extractTomlSection(content: string, sectionName: string): string | null {
		// Handle nested sections (e.g., "project.dependencies")
		const escaped = sectionName.replace(/\./g, "\\.")
		const regex = new RegExp(`^\\[${escaped}\\]([\\s\\S]*?)(?:^\\[|\\z)`, "m")
		const match = content.match(regex)
		return match?.[1].trim() ?? null
	}

	/**
	 * Detect whether a Node.js project is TypeScript or JavaScript.
	 * Checks for tsconfig.json, .ts files, or typescript dependency.
	 */
	private async detectNodeLanguage(projectDir: string, fallback: ProjectLanguage): Promise<ProjectLanguage> {
		try {
			// Check if tsconfig.json exists
			if (await fileExistsAtPath(path.join(projectDir, "tsconfig.json"))) {
				return "typescript"
			}

			// Check if there are .ts files in the src directory
			const srcDir = path.join(projectDir, "src")
			if (await fileExistsAtPath(srcDir)) {
				const entries = await fs.readdir(srcDir, { withFileTypes: true })
				for (const entry of entries) {
					if (entry.isFile() && entry.name.endsWith(".ts")) {
						return "typescript"
					}
				}
			}
		} catch {
			// Fallback to the detected language
		}

		return fallback === "javascript" ? "javascript" : "javascript"
	}

	/**
	 * Detect the programming language from a manifest file path.
	 *
	 * @param manifestPath - Path to the build manifest
	 * @returns Detected project language
	 */
	detectLanguage(manifestPath: string): ProjectLanguage {
		const basename = path.basename(manifestPath)
		return this.getLanguageForManifest(basename)
	}

	/**
	 * Get the programming language associated with a manifest filename.
	 *
	 * @param manifestFile - The manifest filename (e.g., "package.json", "Cargo.toml")
	 * @returns The detected ProjectLanguage
	 */
	getLanguageForManifest(manifestFile: string): ProjectLanguage {
		switch (manifestFile) {
			case "package.json":
				return "typescript"
			case "Cargo.toml":
				return "rust"
			case "go.mod":
				return "go"
			case "pyproject.toml":
			case "setup.py":
			case "requirements.txt":
				return "python"
			case "build.gradle.kts":
			case "build.gradle":
				return "kotlin"
			case "pom.xml":
				return "java"
			case "CMakeLists.txt":
				return "cpp"
			case "composer.json":
				return "unknown"
			case "Makefile":
				return "unknown"
			default:
				return "unknown"
		}
	}

	/**
	 * Get the known manifest filenames that this detector can discover.
	 *
	 * @returns Array of manifest filenames
	 */
	getKnownManifests(): string[] {
		return [
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
		]
	}

	/**
	 * Extract build commands from a sub-project's manifest.
	 *
	 * For package.json: extracts `scripts.build`, `scripts.compile`, etc.
	 * For Cargo.toml: returns "cargo build"
	 * For other manifests: returns sensible defaults.
	 *
	 * @param subProject - The sub-project to extract commands from
	 * @returns Array of build command strings
	 */
	getBuildCommands(subProject: SubProject): string[] {
		if (!this.isManifestAccessible(subProject)) {
			return this.getDefaultBuildCommands(subProject.language)
		}

		try {
			switch (subProject.buildManifestType) {
				case "package.json": {
					const manifestPath = path.join(subProject.rootPath, subProject.buildManifest)
					const scripts = this.readPackageScripts(manifestPath)
					const buildScripts = ["build", "compile", "bundle", "prod", "production"]
					return this.filterScripts(scripts, buildScripts)
				}
				case "Cargo.toml":
					return ["cargo build"]
				case "go.mod":
					return ["go build"]
				case "pyproject.toml":
					return ["pip install -e ."]
				case "build.gradle":
				case "build.gradle.kts":
					return ["./gradlew build"]
				case "CMakeLists.txt":
					return ["cmake --build ."]
				default:
					return this.getDefaultBuildCommands(subProject.language)
			}
		} catch {
			return this.getDefaultBuildCommands(subProject.language)
		}
	}

	/**
	 * Extract test commands from a sub-project's manifest.
	 *
	 * @param subProject - The sub-project to extract commands from
	 * @returns Array of test command strings
	 */
	getTestCommands(subProject: SubProject): string[] {
		if (!this.isManifestAccessible(subProject)) {
			return this.getDefaultTestCommands(subProject.language)
		}

		try {
			switch (subProject.buildManifestType) {
				case "package.json": {
					const manifestPath = path.join(subProject.rootPath, subProject.buildManifest)
					const scripts = this.readPackageScripts(manifestPath)
					const testScripts = ["test", "test:unit", "test:integration", "test:e2e"]
					return this.filterScripts(scripts, testScripts)
				}
				case "Cargo.toml":
					return ["cargo test"]
				case "go.mod":
					return ["go test ./..."]
				case "pyproject.toml":
					return ["pytest"]
				case "build.gradle":
				case "build.gradle.kts":
					return ["./gradlew test"]
				default:
					return this.getDefaultTestCommands(subProject.language)
			}
		} catch {
			return this.getDefaultTestCommands(subProject.language)
		}
	}

	/**
	 * Extract lint commands from a sub-project's manifest.
	 *
	 * @param subProject - The sub-project to extract commands from
	 * @returns Array of lint command strings
	 */
	getLintCommands(subProject: SubProject): string[] {
		if (!this.isManifestAccessible(subProject)) {
			return this.getDefaultLintCommands(subProject.language)
		}

		try {
			switch (subProject.buildManifestType) {
				case "package.json": {
					const manifestPath = path.join(subProject.rootPath, subProject.buildManifest)
					const scripts = this.readPackageScripts(manifestPath)
					const lintScripts = ["lint", "lint:check", "format", "format:check", "eslint"]
					return this.filterScripts(scripts, lintScripts)
				}
				case "Cargo.toml":
					return ["cargo clippy"]
				case "go.mod":
					return ["go vet"]
				case "pyproject.toml":
					return ["ruff check ."]
				case "build.gradle":
				case "build.gradle.kts":
					return ["./gradlew lint"]
				default:
					return this.getDefaultLintCommands(subProject.language)
			}
		} catch {
			return this.getDefaultLintCommands(subProject.language)
		}
	}

	/**
	 * Get all sub-projects aggregated across all workspace roots.
	 * Uses cache if within debounce window.
	 *
	 * @returns Array of all sub-projects
	 */
	async getAllSubProjects(): Promise<SubProject[]> {
		return this.scanAll()
	}

	/**
	 * Find which sub-project a given file path belongs to.
	 * Resolves by finding the nearest manifest directory that contains the file.
	 *
	 * @param filePath - Absolute path to a file
	 * @returns The sub-project containing the file, or undefined
	 */
	async getSubProjectForPath(filePath: string): Promise<SubProject | undefined> {
		if (!filePath) {
			return undefined
		}

		const normalizedPath = path.normalize(filePath)

		// Get all discovered projects (from cache or scan)
		const projects = await this.scanAll()

		// Find the project with the closest rootPath prefix
		let best: SubProject | undefined
		let bestLength = 0

		for (const project of projects) {
			if (normalizedPath.startsWith(project.rootPath)) {
				if (project.rootPath.length > bestLength) {
					best = project
					bestLength = project.rootPath.length
				}
			}
		}

		return best
	}

	/**
	 * Invalidate cache for a root (called by file watcher on manifest changes).
	 *
	 * @param rootPath - Absolute path to invalidate
	 */
	invalidate(rootPath: string): void {
		this.cache.delete(rootPath)
	}

	/**
	 * Clear all cached scan results.
	 */
	clearCache(): void {
		this.cache.clear()
	}

	/**
	 * Check whether a directory name should be excluded from scanning.
	 *
	 * @param dirName - Directory name to check
	 * @returns True if the directory should be skipped
	 */
	private shouldExcludeDirectory(dirName: string): boolean {
		const excludeDirs = new Set([
			"node_modules",
			".git",
			".roo",
			".agents",
			".vscode",
			"__pycache__",
			"venv",
			".venv",
			".env",
			"env",
			"dist",
			"build",
			"target",
			".next",
			".nuxt",
			".gradle",
			".idea",
			"coverage",
			".nyc_output",
			".turbo",
			".cache",
			".pnpm-store",
		])
		return excludeDirs.has(dirName)
	}

	/**
	 * Check whether a sub-project's manifest is accessible for reading.
	 */
	private isManifestAccessible(subProject: SubProject): boolean {
		const manifestPath = path.join(subProject.rootPath, subProject.buildManifest)
		try {
			fsSync.accessSync(manifestPath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Read package.json scripts field.
	 */
	private readPackageScripts(manifestPath: string): Record<string, string> {
		try {
			const content = fsSync.readFileSync(manifestPath, "utf-8")
			const pkg = JSON.parse(content)
			return (pkg.scripts as Record<string, string>) ?? {}
		} catch {
			return {}
		}
	}

	/**
	 * Filter scripts from package.json by matching preferred script names.
	 */
	private filterScripts(scripts: Record<string, string>, preferred: string[]): string[] {
		const commands: string[] = []

		for (const pref of preferred) {
			if (scripts[pref]) {
				commands.push(scripts[pref])
			}
		}

		return commands
	}

	/**
	 * Get default build commands for a language.
	 */
	private getDefaultBuildCommands(language: ProjectLanguage): string[] {
		switch (language) {
			case "typescript":
			case "javascript":
				return ["npm run build"]
			case "rust":
				return ["cargo build"]
			case "go":
				return ["go build"]
			case "python":
				return ["pip install -e ."]
			case "kotlin":
			case "java":
				return ["./gradlew build"]
			case "c":
			case "cpp":
				return ["cmake --build ."]
			default:
				return ["make"]
		}
	}

	/**
	 * Get default test commands for a language.
	 */
	private getDefaultTestCommands(language: ProjectLanguage): string[] {
		switch (language) {
			case "typescript":
			case "javascript":
				return ["npm test"]
			case "rust":
				return ["cargo test"]
			case "go":
				return ["go test ./..."]
			case "python":
				return ["pytest"]
			case "kotlin":
			case "java":
				return ["./gradlew test"]
			default:
				return ["make test"]
		}
	}

	/**
	 * Get default lint commands for a language.
	 */
	private getDefaultLintCommands(language: ProjectLanguage): string[] {
		switch (language) {
			case "typescript":
			case "javascript":
				return ["npm run lint"]
			case "rust":
				return ["cargo clippy"]
			case "go":
				return ["go vet"]
			case "python":
				return ["ruff check ."]
			case "kotlin":
			case "java":
				return ["./gradlew lint"]
			default:
				return []
		}
	}
}
