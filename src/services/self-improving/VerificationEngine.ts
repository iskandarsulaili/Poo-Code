import * as fs from "fs/promises"
import * as path from "path"
import type { Logger } from "./types"
import type { AutoDetectedProfile, CommandSource } from "@roo-code/types"
import type { ProviderSettings } from "@roo-code/types"
import { singleCompletionHandler } from "../../utils/single-completion-handler"

/** Describes a detected project language / tech stack */
export interface ProjectProfile {
	language: string
	buildCommand?: string
	lintCommand?: string
	typeCheckCommand?: string
	testCommand?: string
	/** Source indicator for each command — where was it detected from */
	commandSources: {
		buildCommand: string | null
		lintCommand: string | null
		typeCheckCommand: string | null
		testCommand: string | null
	}
	/** The manifest file that triggered detection (e.g. "package.json") */
	detectedFrom: string | null
}

/** Result of running a single verification gate (build, lint, types, tests) */
export interface GateResult {
	name: string
	passed: boolean
	output?: string
	error?: string
	durationMs: number
	/** Number of warnings detected in stderr (0 if none or not parsed) */
	warnings: number
	/** Number of errors detected in stderr (0 if none or not parsed) */
	errors: number
	/** Truncated summary of stderr content for display */
	stderrSummary?: string
	/** Strictness level used for this gate */
	strictness: "lenient" | "moderate" | "strict" | "enterprise"
	/** Whether the gate was skipped (e.g., no tooling detected, ENOENT) */
	skipped?: boolean
	/** Reason the gate was skipped */
	skipReason?: string
}

export interface VerificationResult {
	passed: boolean
	gates: GateResult[]
	summary: string
	/** Strictness level used for this verification run */
	strictness: "lenient" | "moderate" | "strict" | "enterprise"
	/** Whether all gates were skipped (no tooling detected) */
	allSkipped?: boolean
}

export interface VerificationConfig {
	/** Whether to run build check */
	checkBuild: boolean
	/** Whether to run lint check */
	checkLint: boolean
	/** Whether to run type check */
	checkTypes: boolean
	/** Whether to run tests */
	checkTests: boolean
	/** Build command (e.g., "npm run build") */
	buildCommand?: string
	/** Lint command (e.g., "npm run lint") */
	lintCommand?: string
	/** Type check command (e.g., "npm run typecheck") */
	typeCheckCommand?: string
	/** Test command (e.g., "npm test") */
	testCommand?: string
	/** Working directory for verification commands */
	cwd?: string
	/** Timeout per gate in ms */
	gateTimeoutMs: number
	/** Whether verification is mandatory (blocks completion) */
	mandatory: boolean
	/**
	 * Strictness level for gate validation.
	 * - "lenient": exit code only (current behavior)
	 * - "moderate": exit code + stderr parsed for warnings (log but don't fail)
	 * - "strict": exit code + fail if stderr has error content + warn on warnings
	 * - "enterprise": exit code + zero warnings + content validation + coverage check
	 * @default "moderate"
	 */
	strictness: "lenient" | "moderate" | "strict" | "enterprise"
	/** Max allowed warnings before gate fails (0-100, only relevant for strict/enterprise). 0 = unlimited. */
	maxWarnings?: number
	/** Minimum test coverage percentage (0-100, only relevant for enterprise). 0 = no check. */
	testCoverageThreshold?: number
}

const DEFAULT_CONFIG: VerificationConfig = {
	checkBuild: false,
	checkLint: true,
	checkTypes: true,
	checkTests: false,
	gateTimeoutMs: 60_000,
	mandatory: true,
	strictness: "moderate",
	maxWarnings: 0,
	testCoverageThreshold: 0,
}

/**
 * Map of well-known project files to their language profile.
 * Uses a scoring system to pick the best match in multi-language projects.
 * More specific markers (Cargo.toml, go.mod, build.gradle.kts) are preferred
 * over generic ones (package.json) to avoid false JS/TS detection.
 */
const LANG_SIGNATURES: Array<{
	files: string[]
	fn: (cwd: string) => Promise<ProjectProfile | null>
}> = [
	// --- Rust ---
	{
		files: ["Cargo.toml"],
		fn: async () => ({
			language: "Rust",
			buildCommand: "cargo build",
			lintCommand: "cargo clippy",
			typeCheckCommand: "cargo check",
			testCommand: "cargo test",
			commandSources: {
				buildCommand: "cargo",
				lintCommand: "cargo",
				typeCheckCommand: "cargo",
				testCommand: "cargo",
			},
			detectedFrom: "Cargo.toml",
		}),
	},
	// --- Python ---
	{
		files: ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt"],
		fn: async (cwd) => {
			const hasPyProject = await fileExists(cwd, "pyproject.toml")
			const hasBlack = (await fileExists(cwd, ".flake8")) || (await fileExists(cwd, "pyproject.toml"))
			const hasMypy =
				(await fileExists(cwd, "mypy.ini")) ||
				(await fileExists(cwd, ".mypy.ini")) ||
				(await fileExists(cwd, "pyproject.toml")) // mypy can be in pyproject
			const hasPytest =
				(await fileExists(cwd, "pytest.ini")) ||
				(await fileExists(cwd, "pyproject.toml")) ||
				(await fileExists(cwd, "setup.cfg"))
			const isPdm = await fileExists(cwd, "pyproject.toml")
			const hasBuildScript = isPdm ? await hasScriptPython(cwd, "build") : false
			return {
				language: "Python",
				buildCommand: isPdm && hasBuildScript ? "pdm build" : undefined,
				lintCommand: hasBlack ? "flake8 ." : undefined,
				typeCheckCommand: hasMypy ? "mypy ." : undefined,
				testCommand: hasPytest ? "pytest" : "python -m unittest",
				commandSources: {
					buildCommand: isPdm && hasBuildScript ? "pyproject" : null,
					lintCommand: hasBlack ? "pyproject" : null,
					typeCheckCommand: hasMypy ? "pyproject" : null,
					testCommand: hasPytest ? "pyproject" : null,
				},
				detectedFrom: "pyproject.toml",
			}
		},
	},
	// --- Go ---
	{
		files: ["go.mod"],
		fn: async () => ({
			language: "Go",
			buildCommand: "go build ./...",
			lintCommand: "go vet ./...",
			typeCheckCommand: undefined,
			testCommand: "go test ./...",
			commandSources: {
				buildCommand: "go-mod",
				lintCommand: "go-mod",
				typeCheckCommand: null,
				testCommand: "go-mod",
			},
			detectedFrom: "go.mod",
		}),
	},
	// --- Java / Gradle ---
	{
		files: ["build.gradle", "build.gradle.kts", "gradlew", "pom.xml"],
		fn: async (cwd) => {
			const isGradle = (await fileExists(cwd, "gradlew")) || (await fileExists(cwd, "build.gradle"))
			const isMaven = await fileExists(cwd, "pom.xml")
			if (isGradle) {
				return {
					language: "Java (Gradle)",
					buildCommand: "./gradlew build",
					lintCommand: "./gradlew check",
					typeCheckCommand: undefined,
					testCommand: "./gradlew test",
					commandSources: {
						buildCommand: "gradle",
						lintCommand: "gradle",
						typeCheckCommand: null,
						testCommand: "gradle",
					},
					detectedFrom: "build.gradle",
				}
			}
			if (isMaven) {
				return {
					language: "Java (Maven)",
					buildCommand: "mvn compile",
					lintCommand: "mvn checkstyle:check",
					typeCheckCommand: undefined,
					testCommand: "mvn test",
					commandSources: {
						buildCommand: "maven",
						lintCommand: "maven",
						typeCheckCommand: null,
						testCommand: "maven",
					},
					detectedFrom: "pom.xml",
				}
			}
			return null
		},
	},
	// --- Kotlin ---
	{
		files: ["build.gradle.kts"],
		fn: async (cwd) => {
			const hasKtlint = (await fileExists(cwd, ".ktlint")) || (await hasScript(cwd, "ktlint"))
			const hasGradlew = await fileExists(cwd, "gradlew")
			const gradleCmd = hasGradlew ? "./gradlew" : "gradle"
			return {
				language: "Kotlin",
				buildCommand: `${gradleCmd} build`,
				lintCommand: hasKtlint ? "ktlint ." : `${gradleCmd} ktlintCheck`,
				typeCheckCommand: undefined,
				testCommand: `${gradleCmd} test`,
				commandSources: {
					buildCommand: "gradle-kotlin",
					lintCommand: hasKtlint ? "ktlint" : "gradle-kotlin",
					typeCheckCommand: null,
					testCommand: "gradle-kotlin",
				},
				detectedFrom: "build.gradle.kts",
			}
		},
	},
	// --- Ruby ---
	{
		files: ["Gemfile"],
		fn: async (cwd) => {
			const hasRubocop = await fileExists(cwd, ".rubocop.yml")
			return {
				language: "Ruby",
				buildCommand: "bundle exec rake",
				lintCommand: hasRubocop ? "bundle exec rubocop" : undefined,
				typeCheckCommand: (await fileExists(cwd, "rbs")) ? "bundle exec rbs validate" : undefined,
				testCommand: "bundle exec rspec",
				commandSources: {
					buildCommand: "gemfile",
					lintCommand: hasRubocop ? "gemfile" : null,
					typeCheckCommand: (await fileExists(cwd, "rbs")) ? "gemfile" : null,
					testCommand: "gemfile",
				},
				detectedFrom: "Gemfile",
			}
		},
	},
	// --- Elixir ---
	{
		files: ["mix.exs"],
		fn: async () => ({
			language: "Elixir",
			buildCommand: "mix compile",
			lintCommand: "mix credo",
			typeCheckCommand: undefined,
			testCommand: "mix test",
			commandSources: {
				buildCommand: "mix",
				lintCommand: "mix",
				typeCheckCommand: null,
				testCommand: "mix",
			},
			detectedFrom: "mix.exs",
		}),
	},
	// --- Deno ---
	{
		files: ["deno.json", "deno.jsonc"],
		fn: async () => ({
			language: "Deno",
			buildCommand: "deno check",
			lintCommand: "deno lint",
			typeCheckCommand: "deno check",
			testCommand: "deno test",
			commandSources: {
				buildCommand: "deno",
				lintCommand: "deno",
				typeCheckCommand: "deno",
				testCommand: "deno",
			},
			detectedFrom: "deno.json",
		}),
	},
	// --- .NET / C# ---
	{
		files: ["*.csproj"],
		fn: async () => ({
			language: "C#",
			buildCommand: "dotnet build",
			lintCommand: "dotnet format --verify-no-changes",
			typeCheckCommand: undefined,
			testCommand: "dotnet test",
			commandSources: {
				buildCommand: "dotnet",
				lintCommand: "dotnet",
				typeCheckCommand: null,
				testCommand: "dotnet",
			},
			detectedFrom: "*.csproj",
		}),
	},
	// --- Zig ---
	{
		files: ["build.zig"],
		fn: async () => ({
			language: "Zig",
			buildCommand: "zig build",
			lintCommand: "zig fmt --check",
			typeCheckCommand: "zig build",
			testCommand: "zig test",
			commandSources: {
				buildCommand: "zig",
				lintCommand: "zig",
				typeCheckCommand: "zig",
				testCommand: "zig",
			},
			detectedFrom: "build.zig",
		}),
	},
	// --- Node / JS/TS ---
	{
		files: ["package.json", "tsconfig.json", "next.config.js", "nuxt.config.ts", "svelte.config.js"],
		fn: async (cwd) => {
			const hasPackage = await fileExists(cwd, "package.json")
			if (!hasPackage) return null
			const hasTS = await fileExists(cwd, "tsconfig.json")
			const hasBuildScript = await hasScript(cwd, "build")
			const hasLintScript = await hasScript(cwd, "lint")
			const hasTypeCheckScript =
				(await hasScript(cwd, "typecheck")) ||
				(await hasScript(cwd, "type-check")) ||
				(await hasScript(cwd, "types"))
			const hasTestScript = await hasScript(cwd, "test")
			return {
				language: hasTS ? "TypeScript" : "JavaScript",
				buildCommand: hasBuildScript ? "npm run build" : undefined,
				lintCommand: hasLintScript ? "npm run lint" : undefined,
				typeCheckCommand: hasTypeCheckScript
					? (await hasScript(cwd, "typecheck"))
						? "npm run typecheck"
						: (await hasScript(cwd, "type-check"))
							? "npm run type-check"
							: "npm run types"
					: hasTS
						? "npx tsc --noEmit"
						: undefined,
				testCommand: hasTestScript ? "npm test" : undefined,
				commandSources: {
					buildCommand: hasBuildScript ? "package.json" : null,
					lintCommand: hasLintScript ? "package.json" : null,
					typeCheckCommand: hasTypeCheckScript || hasTS ? "package.json" : null,
					testCommand: hasTestScript ? "package.json" : null,
				},
				detectedFrom: "package.json",
			}
		},
	},
]

async function fileExists(dir: string, name: string): Promise<boolean> {
	try {
		await fs.access(path.join(dir, name))
		return true
	} catch {
		return false
	}
}

/** Check if package.json has a specific script defined */
async function hasScript(cwd: string, scriptName: string): Promise<boolean> {
	try {
		const content = await fs.readFile(path.join(cwd, "package.json"), "utf-8")
		const pkg = JSON.parse(content)
		return !!(pkg.scripts && pkg.scripts[scriptName])
	} catch {
		return false
	}
}

/** Check if pyproject.toml has a tool.*.scripts entry */
async function hasScriptPython(cwd: string, _scriptName: string): Promise<boolean> {
	try {
		const content = await fs.readFile(path.join(cwd, "pyproject.toml"), "utf-8")
		return content.includes("[project.scripts]") || content.includes("build-backend")
	} catch {
		return false
	}
}

/**
 * Check if a directory is markdown-only (contains only .md files and/or
 * standard docs subdirectories like locales/, docs/).
 */
async function isMarkdownOnly(dir: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(dir)
		if (entries.length === 0) return true
		let hasNonMdFile = false
		for (const entry of entries) {
			if (entry.startsWith(".")) continue // skip hidden files
			if (entry.endsWith(".md")) continue
			try {
				const stat = await fs.stat(path.join(dir, entry))
				if (stat.isDirectory()) {
					// Docs subdirectories don't count as code
					const dirName = entry.toLowerCase()
					if (dirName === "locales" || dirName === "docs" || dirName === "documentation") continue
				}
			} catch {
				// If we can't stat, treat it as non-md (likely a code artifact)
			}
			hasNonMdFile = true
			break
		}
		return !hasNonMdFile
	} catch {
		return false // can't read dir → assume not markdown-only
	}
}

export class VerificationEngine {
	private config: VerificationConfig
	private lastVerifyAt?: number
	private lastResult?: VerificationResult
	private enabled: boolean
	private autoProfiled: ProjectProfile | null = null

	/**
	 * In-memory cache for isProjectWithTooling results per directory.
	 * Prevents repeated fs reads for the same cwd within a session.
	 * Cleared on process restart (not persisted).
	 */
	private static toolingCache = new Map<string, boolean | null>()

	/**
	 * Lightweight check: does the directory have project tooling?
	 * Looks for a manifest with actual build/lint/test scripts/commands.
	 * Results are cached per cwd to avoid repeated fs checks.
	 * Returns: true = has tooling, false = definitively no tooling, null = cannot determine
	 */
	static async isProjectWithTooling(dir: string): Promise<boolean | null> {
		// Check cache first
		const cached = VerificationEngine.toolingCache.get(dir)
		if (cached !== undefined) return cached

		const result = await VerificationEngine.uncachedIsProjectWithTooling(dir)
		VerificationEngine.toolingCache.set(dir, result)
		return result
	}

	/**
	 * Clear the tooling cache entirely (useful in tests).
	 */
	static clearToolingCache(): void {
		VerificationEngine.toolingCache.clear()
	}

	/**
	 * Uncached implementation of isProjectWithTooling.
	 */
	private static async uncachedIsProjectWithTooling(dir: string): Promise<boolean | null> {
		try {
			// First verify the directory actually exists and is accessible
			try {
				await fs.access(dir)
			} catch {
				return null // dir doesn't exist or can't be accessed → unknown
			}

			let entries: string[]
			try {
				entries = await fs.readdir(dir)
			} catch {
				return null // can't read dir → unknown
			}

			// Empty directory → no tooling
			if (entries.length === 0) return false

			// Check package.json for scripts
			if (entries.includes("package.json")) {
				try {
					const content = await fs.readFile(path.join(dir, "package.json"), "utf-8")
					const pkg = JSON.parse(content)
					const scripts = pkg.scripts || {}
					if (scripts.build || scripts.lint || scripts.test || scripts.typecheck) {
						return true
					}
					// package.json exists but has no relevant scripts → no tooling
				} catch {
					// invalid JSON → treat as no tooling
				}
			}

			// Check other manifest files known to have tooling
			const toolingManifests = [
				"Cargo.toml",
				"go.mod",
				"build.gradle",
				"build.gradle.kts",
				"pyproject.toml",
				"Gemfile",
				"mix.exs",
				"deno.json",
				"deno.jsonc",
				"build.zig",
				"Makefile",
			] as const

			for (const manifest of toolingManifests) {
				if (entries.includes(manifest)) {
					return true // manifest exists → project has tooling
				}
			}

			// Check for source code files that indicate a real project
			const codeExtensions = [
				".ts",
				".tsx",
				".js",
				".jsx",
				".rs",
				".py",
				".go",
				".java",
				".kt",
				".kts",
				".rb",
				".cs",
				".zig",
				".ex",
				".exs",
			]
			for (const entry of entries) {
				if (entry.startsWith(".")) continue
				const ext = path.extname(entry)
				if (codeExtensions.includes(ext)) {
					return true
				}
			}

			// Directory contents found but none indicate tooling
			return false
		} catch {
			return null // unexpected error → unknown
		}
	}

	constructor(
		private readonly logger?: Logger,
		config?: Partial<VerificationConfig>,
		enabled: boolean = true,
		private readonly apiConfiguration?: ProviderSettings,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.enabled = enabled
	}

	/**
	 * Auto-detect the project language profile from the working directory.
	 * Tries LLM-based detection first (if API is configured), falls back to
	 * signature-based detection for known project markers.
	 * Returns null if no project can be detected.
	 */
	async autoDetectProject(cwd?: string): Promise<ProjectProfile | null> {
		const dir = cwd || this.config.cwd
		if (!dir) return null

		// Try LLM-based detection first (if API is configured)
		if (this.apiConfiguration?.apiProvider) {
			try {
				this.logger?.appendLine("[VerificationEngine] Attempting LLM-based project detection...")
				const llmProfile = await this.autoDetectWithLLM(dir)
				if (llmProfile) {
					this.logger?.appendLine(
						`[VerificationEngine] LLM auto-detected project: ${llmProfile.language} (from ${llmProfile.detectedFrom})`,
					)
					this.autoProfiled = llmProfile
					return llmProfile
				}
			} catch (err) {
				this.logger?.appendLine(
					`[VerificationEngine] LLM detection failed: ${err instanceof Error ? err.message : String(err)}. Falling back to signature detection.`,
				)
			}
		}

		// Fall back to signature-based detection
		return this.autoDetectWithSignatures(dir)
	}

	/**
	 * Signature-based project detection using known file markers and a scoring system.
	 * More specific markers (Cargo.toml, go.mod, build.gradle.kts) score higher
	 * than generic ones (package.json) to avoid false JS/TS detection.
	 */
	private async autoDetectWithSignatures(dir: string): Promise<ProjectProfile | null> {
		let bestProfile: { profile: ProjectProfile; score: number } | null = null

		for (const sig of LANG_SIGNATURES) {
			for (const filePattern of sig.files) {
				let matchFound = false
				if (filePattern.includes("*")) {
					// Glob-like — check if any file matches
					try {
						const entries = await fs.readdir(dir)
						matchFound = entries.some((e) => e.endsWith(filePattern.slice(1)))
					} catch {
						continue
					}
				} else {
					matchFound = await fileExists(dir, filePattern)
				}

				if (matchFound) {
					const profile = await sig.fn(dir)
					if (profile) {
						// Score: JS/TS gets penalty to prevent false matches in multi-lang repos
						let score = 10
						if (profile.language === "TypeScript" || profile.language === "JavaScript") {
							score = 5
						}
						// Bonus for more specific language markers
						if (filePattern === "Cargo.toml") score += 10
						if (filePattern === "go.mod") score += 10
						if (filePattern === "build.gradle.kts") {
							score += 10
							// Kotlin gets additional specificity over Java/Gradle for .kts
							if (profile.language === "Kotlin") score += 3
						}
						if (filePattern === "gradlew") score += 8
						if (filePattern === "pyproject.toml") score += 8
						if (filePattern === "build.zig") score += 10
						if (filePattern === "mix.exs") score += 8
						if (filePattern === "Gemfile") score += 6
						if (filePattern === "deno.json" || filePattern === "deno.jsonc") score += 8
						if (filePattern === "*.csproj") score += 8

						if (!bestProfile || score > bestProfile.score) {
							bestProfile = { profile, score }
						}
					}
				}
			}
		}

		if (bestProfile) {
			this.autoProfiled = bestProfile.profile
			this.logger?.appendLine(
				`[VerificationEngine] Auto-detected project: ${bestProfile.profile.language} (score: ${bestProfile.score})`,
			)
			return bestProfile.profile
		}

		this.logger?.appendLine("[VerificationEngine] No recognizable project files detected")
		return null
	}

	/**
	 * LLM-based project detection. Reads project files and config contents,
	 * sends them to the LLM for structured analysis, and parses the JSON response.
	 */
	private async autoDetectWithLLM(cwd: string): Promise<ProjectProfile | null> {
		const entries = await fs.readdir(cwd)
		const files: string[] = []
		const dirs: string[] = []

		for (const entry of entries) {
			try {
				const stat = await fs.stat(path.join(cwd, entry))
				if (stat.isDirectory()) {
					dirs.push(entry)
				} else {
					files.push(entry)
				}
			} catch {
				files.push(entry)
			}
		}

		// Read commonly-useful config files to give LLM more context
		const configContents: Record<string, string> = {}
		const configFiles = [
			"package.json",
			"build.gradle.kts",
			"Cargo.toml",
			"go.mod",
			"pyproject.toml",
			"Gemfile",
			"Makefile",
			"CMakeLists.txt",
			"build.zig",
			"mix.exs",
			"composer.json",
		]
		for (const cf of configFiles) {
			if (files.includes(cf)) {
				try {
					const content = await fs.readFile(path.join(cwd, cf), "utf-8")
					configContents[cf] = content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content
				} catch {}
			}
		}

		const prompt = `You are analyzing a software project to identify its language and toolchain.

Project directory: ${cwd}

Files found:
${files.map((f) => `  ${f}`).join("\n")}

Subdirectories:
${dirs.map((d) => `  ${d}/`).join("\n")}

${
	Object.keys(configContents).length > 0
		? `Config file contents:\n${Object.entries(configContents)
				.map(([name, content]) => `--- ${name} ---\n${content}\n`)
				.join("\n")}`
		: ""
}

Based on the project files above, identify:
1. The primary programming language
2. The build command (if applicable)
3. The lint command (if applicable)
4. The type check command (if applicable, for typed languages)
5. The test command (if applicable)

Consider ALL files, including subdirectory names that might indicate the project structure. If no build/lint/type check/test commands are applicable, set them to null.

Respond ONLY with a valid JSON object (no markdown, no code fences):
{
	 "language": "detected language name",
	 "buildCommand": "command or null",
	 "lintCommand": "command or null",
	 "typeCheckCommand": "command or null",
	 "testCommand": "command or null",
	 "commandSources": {
	   "buildCommand": "short source identifier (tool or manifest name)",
	   "lintCommand": "source or null",
	   "typeCheckCommand": "source or null",
	   "testCommand": "source or null"
	 },
	 "detectedFrom": "the primary file that identified this project type"
}`

		const raw = await singleCompletionHandler(this.apiConfiguration!, prompt)

		// Parse JSON from response (handle potential markdown fences)
		let jsonStr = raw.trim()
		if (jsonStr.startsWith("```")) {
			jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
		}

		const parsed = JSON.parse(jsonStr)

		return {
			language: parsed.language || "Unknown",
			buildCommand: parsed.buildCommand || undefined,
			lintCommand: parsed.lintCommand || undefined,
			typeCheckCommand: parsed.typeCheckCommand || undefined,
			testCommand: parsed.testCommand || undefined,
			commandSources: {
				buildCommand: parsed.commandSources?.buildCommand || null,
				lintCommand: parsed.commandSources?.lintCommand || null,
				typeCheckCommand: parsed.commandSources?.typeCheckCommand || null,
				testCommand: parsed.commandSources?.testCommand || null,
			},
			detectedFrom: parsed.detectedFrom || null,
		}
	}

	/**
	 * Fill gaps in the current config from the auto-detected profile.
	 * Explicitly-set config values take precedence (not overwritten).
	 */
	async applyAutoProfile(cwd?: string): Promise<void> {
		const profile = await this.autoDetectProject(cwd)
		if (!profile) return

		if (!this.config.buildCommand && profile.buildCommand) {
			this.config.buildCommand = profile.buildCommand
			this.config.checkBuild = true
		}
		if (!this.config.lintCommand && profile.lintCommand) {
			this.config.lintCommand = profile.lintCommand
			this.config.checkLint = true
		}
		if (!this.config.typeCheckCommand && profile.typeCheckCommand) {
			this.config.typeCheckCommand = profile.typeCheckCommand
			this.config.checkTypes = true
		}
		if (!this.config.testCommand && profile.testCommand) {
			this.config.testCommand = profile.testCommand
			this.config.checkTests = true
		}

		this.logger?.appendLine(
			`[VerificationEngine] Auto-config applied: build=${
				this.config.checkBuild ? this.config.buildCommand : "off"
			}, lint=${this.config.checkLint ? this.config.lintCommand : "off"}, types=${
				this.config.checkTypes ? this.config.typeCheckCommand : "off"
			}, tests=${this.config.checkTests ? this.config.testCommand : "off"}`,
		)
	}

	/**
	 * Return the auto-detected profile as a serializable DTO for the webview.
	 */
	getAutoProfile(): AutoDetectedProfile {
		if (!this.autoProfiled) {
			// No auto-detection has been run yet; return a "detecting" state
			return {
				language: null,
				build: { command: null, source: null },
				lint: { command: null, source: null },
				typeCheck: { command: null, source: null },
				test: { command: null, source: null },
			}
		}
		return {
			language: this.autoProfiled.language,
			build: {
				command: this.autoProfiled.buildCommand ?? null,
				source: this.autoProfiled.commandSources.buildCommand as CommandSource["source"],
			},
			lint: {
				command: this.autoProfiled.lintCommand ?? null,
				source: this.autoProfiled.commandSources.lintCommand as CommandSource["source"],
			},
			typeCheck: {
				command: this.autoProfiled.typeCheckCommand ?? null,
				source: this.autoProfiled.commandSources.typeCheckCommand as CommandSource["source"],
			},
			test: {
				command: this.autoProfiled.testCommand ?? null,
				source: this.autoProfiled.commandSources.testCommand as CommandSource["source"],
			},
		}
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled
		this.logger?.appendLine(`[VerificationEngine] ${enabled ? "Enabled" : "Disabled"}`)
	}

	updateConfig(config: Partial<VerificationConfig>): void {
		this.config = { ...this.config, ...config }
		this.logger?.appendLine(`[VerificationEngine] Config updated: ${JSON.stringify(config)}`)
	}

	getConfig(): VerificationConfig {
		return { ...this.config }
	}

	getStatus(): Record<string, unknown> {
		if (!this.enabled) {
			return { enabled: false, gates: [] }
		}
		return {
			enabled: true,
			lastVerifyAt: this.lastVerifyAt,
			lastResult: this.lastResult,
			autoProfiled: this.autoProfiled,
		}
	}

	async verify(): Promise<VerificationResult> {
		const cwd = this.config.cwd || (await this.findProjectRoot()) || process.cwd()
		const gates: GateResult[] = []
		let strictness = this.config.strictness

		// Check if the working directory has actual project tooling.
		// Only consider the result authoritative when we can read the directory.
		// null = unknown (dir unreadable) — proceed with gates
		// false = definitively no tooling — skip gates
		// true = has tooling — run gates normally
		let hasTooling: boolean | null = null
		if (this.config.cwd) {
			hasTooling = await VerificationEngine.isProjectWithTooling(cwd)
		}

		// Check for markdown-only directories when tooling is absent
		const isMarkdown = hasTooling === false ? await isMarkdownOnly(cwd) : false

		// For markdown-only directories, auto-downgrade to lenient
		if (isMarkdown) {
			strictness = "lenient"
			this.logger?.appendLine(
				`[VerificationEngine] Markdown-only directory detected. Auto-downgrading to lenient strictness.`,
			)
		}

		// Only skip gates when we're CERTAIN there's no tooling (hasTooling === false).
		// When hasTooling is null (unknown/unreadable dir) or true, run gates normally.
		// This prevents false-positive skips when the check can't determine tooling.
		if (hasTooling === false) {
			const reason = isMarkdown
				? "markdown-only directory — no project tooling detected"
				: "no project tooling detected"
			this.logger?.appendLine(`[VerificationEngine] ${reason}. All gates skipped.`)

			const skippedGates: GateResult[] = []

			if (this.config.checkBuild) {
				skippedGates.push(this.makeSkippedGate("build", reason, strictness))
			}
			if (this.config.checkLint) {
				skippedGates.push(this.makeSkippedGate("lint", reason, strictness))
			}
			if (this.config.checkTypes) {
				skippedGates.push(this.makeSkippedGate("type-check", reason, strictness))
			}
			if (this.config.checkTests) {
				skippedGates.push(this.makeSkippedGate("tests", reason, strictness))
			}

			const allSkipped = true
			const summary = `All verification gates skipped [${strictness}]: ${reason}`
			this.logger?.appendLine(`[VerificationEngine] ${summary}`)
			this.lastVerifyAt = Date.now()
			this.lastResult = { passed: true, gates: skippedGates, summary, strictness, allSkipped }
			return { passed: true, gates: skippedGates, summary, strictness, allSkipped }
		}

		// Strip bare "cd" commands — spawnSync/execSync can't execute shell built-ins
		const stripCd = (cmd: string | undefined): string | undefined => {
			if (!cmd) return cmd
			const trimmed = cmd.trim()
			if (trimmed === "cd") return undefined
			return cmd
		}

		if (this.config.checkBuild && this.config.buildCommand) {
			const cmd = stripCd(this.config.buildCommand)
			if (cmd) gates.push(await this.runGate("build", cmd, strictness))
		}

		if (this.config.checkLint && this.config.lintCommand) {
			const cmd = stripCd(this.config.lintCommand)
			if (cmd) gates.push(await this.runGate("lint", cmd, strictness))
		}

		if (this.config.checkTypes && this.config.typeCheckCommand) {
			const cmd = stripCd(this.config.typeCheckCommand)
			if (cmd) gates.push(await this.runGate("type-check", cmd, strictness))
		}

		if (this.config.checkTests && this.config.testCommand) {
			const cmd = stripCd(this.config.testCommand)
			if (cmd) gates.push(await this.runGate("tests", cmd, strictness))
		}

		const passed = gates.every((g) => g.passed || g.skipped)
		const failedGates = gates.filter((g) => !g.passed && !g.skipped)
		const skippedGates = gates.filter((g) => g.skipped)
		const allSkipped = gates.length > 0 && gates.every((g) => g.skipped)
		const totalWarnings = gates.reduce((sum, g) => sum + g.warnings, 0)
		const totalErrors = gates.reduce((sum, g) => sum + g.errors, 0)

		let summary: string
		if (gates.length === 0) {
			summary = `No verification gates configured [${strictness}]`
		} else if (allSkipped) {
			summary = `All ${gates.length} verification gates skipped [${strictness}]: no tooling detected`
		} else if (passed) {
			const skippedNote = skippedGates.length > 0 ? ` (${skippedGates.length} skipped)` : ""
			const warningSuffix =
				totalWarnings > 0 ? ` (${totalWarnings} warning${totalWarnings !== 1 ? "s" : ""})` : ""
			const errorSuffix = totalErrors > 0 ? ` (${totalErrors} error${totalErrors !== 1 ? "s" : ""} detected)` : ""
			summary = `All ${gates.length} verification gates passed [${strictness}]${skippedNote}${warningSuffix}${errorSuffix}`
		} else {
			const summaryParts = failedGates.map((g) => {
				const extra =
					g.warnings > 0 ? ` (${g.warnings} warnings${g.errors > 0 ? `, ${g.errors} errors` : ""})` : ""
				return `${g.name}${extra}`
			})
			summary = `${failedGates.length}/${gates.length} gates failed [${strictness}]: ${summaryParts.join(", ")}`
		}

		this.logger?.appendLine(`[VerificationEngine] ${summary}`)

		this.lastVerifyAt = Date.now()
		this.lastResult = { passed, gates, summary, strictness, allSkipped }

		return { passed, gates, summary, strictness, allSkipped }
	}

	/**
	 * Create a skipped gate result.
	 */
	private makeSkippedGate(name: string, reason: string, strictness: GateResult["strictness"]): GateResult {
		return {
			name,
			passed: true,
			durationMs: 0,
			warnings: 0,
			errors: 0,
			strictness,
			skipped: true,
			skipReason: reason,
		}
	}

	/**
	 * Check whether a valid package.json exists in the configured cwd.
	 * Falls back to process.cwd() if config.cwd is not set.
	 */
	private async isCwdValid(): Promise<boolean> {
		try {
			const cwd = this.config.cwd || (await this.findProjectRoot()) || process.cwd()
			const packageJsonPath = path.join(cwd, "package.json")
			await fs.access(packageJsonPath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Walk up from the configured cwd (or process.cwd()) looking for
	 * any recognized project root marker (Cargo.toml, pyproject.toml, go.mod, etc.).
	 * Falls back to first directory containing package.json.
	 */
	private async findProjectRoot(): Promise<string | undefined> {
		const cwd = this.config.cwd
		if (!cwd) return undefined // No cwd configured
		let current = path.resolve(cwd)
		const root = path.parse(current).root

		while (current !== root) {
			try {
				const entries = await fs.readdir(current)
				const markers = [
					"package.json",
					"Cargo.toml",
					"pyproject.toml",
					"go.mod",
					"Gemfile",
					"mix.exs",
					"deno.json",
					"deno.jsonc",
					"build.zig",
					"build.gradle",
					"pom.xml",
				]
				for (const marker of markers) {
					if (entries.includes(marker)) {
						return current
					}
				}
			} catch {
				// directory inaccessible, keep walking up
			}
			current = path.dirname(current)
		}
		// Check root too
		try {
			const entries = await fs.readdir(root)
			for (const marker of ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]) {
				if (entries.includes(marker)) {
					return root
				}
			}
		} catch {
			// ignore
		}
		return undefined
	}

	private async runGate(
		name: string,
		command: string,
		effectiveStrictness?: "lenient" | "moderate" | "strict" | "enterprise",
	): Promise<GateResult> {
		const start = Date.now()
		const strictness = effectiveStrictness ?? this.config.strictness

		// Handle empty command gracefully
		if (!command || command.trim().length === 0) {
			const durationMs = Date.now() - start
			this.logger?.appendLine(
				`[VerificationEngine] Gate "${name}" skipped: empty command in this project context`,
			)
			return {
				name,
				passed: true,
				durationMs,
				warnings: 0,
				errors: 0,
				strictness,
				skipped: true,
				skipReason: "empty command in this project context",
			}
		}

		try {
			const cwd = this.config.cwd || (await this.findProjectRoot()) || process.cwd()
			const resolvedCwd = cwd

			const { spawnSync } = await import("child_process")
			const cmdParts = command.split(/\s+/)
			const execName = cmdParts[0]
			const execArgs = cmdParts.slice(1)

			// `cd` is a shell built-in — not a binary. spawnSync already uses
			// the resolved cwd, so a bare `cd` command is redundant and would
			// fail with spawnSync ENOENT. Skip the gate gracefully.
			if (execName === "cd") {
				const durationMs = Date.now() - start
				this.logger?.appendLine(
					`[VerificationEngine] Gate "${name}" skipped: "cd" is a shell built-in; spawnSync already uses resolved cwd`,
				)
				return {
					name,
					passed: true,
					durationMs,
					warnings: 0,
					errors: 0,
					strictness,
					skipped: true,
					skipReason: `"cd" is a shell built-in; spawnSync already handles cwd`,
				}
			}

			const result = spawnSync(execName, execArgs, {
				cwd: resolvedCwd,
				timeout: this.config.gateTimeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			})

			if (result.error) {
				// ENOENT or similar — command not found, treat as SKIP not FAIL
				const nodeErr = result.error as NodeJS.ErrnoException
				if (nodeErr.code === "ENOENT" || result.status === 127) {
					const durationMs = Date.now() - start
					this.logger?.appendLine(
						`[VerificationEngine] Gate "${name}" skipped: command not found in this project context`,
					)
					return {
						name,
						passed: true,
						durationMs,
						warnings: 0,
						errors: 0,
						strictness,
						skipped: true,
						skipReason: `command not found: ${execName}`,
					}
				}
				throw result.error
			}

			// Content analysis: parse stderr for warnings/errors even on exit code 0
			const cmdStderr = result.stderr || ""
			const { warnings, errors, stderrSummary } = parseStderr(cmdStderr)
			const output = result.stdout || ""
			const durationMs = Date.now() - start

			// --- Strictness enforcement ---
			if (strictness === "enterprise") {
				const maxWarnings = this.config.maxWarnings ?? 0
				if (warnings > maxWarnings || errors > 0) {
					const reason =
						errors > 0
							? `${errors} error${errors !== 1 ? "s" : ""} detected`
							: `${warnings} warning${warnings !== 1 ? "s" : ""} exceeds max allowed (${maxWarnings})`
					this.logger?.appendLine(
						`[VerificationEngine] Gate "${name}" FAILED [enterprise] (${durationMs}ms): ${reason}`,
					)
					return {
						name,
						passed: false,
						error: `[enterprise] ${reason}:\n${stderrSummary.slice(0, 500)}`,
						output: output.slice(0, 1000),
						durationMs,
						warnings,
						errors,
						stderrSummary,
						strictness,
					}
				}
			}

			if (strictness === "strict") {
				if (errors > 0 || result.status !== 0) {
					const reason =
						errors > 0 ? `${errors} error${errors !== 1 ? "s" : ""} detected` : `Exit code ${result.status}`
					this.logger?.appendLine(
						`[VerificationEngine] Gate "${name}" FAILED [strict] (${durationMs}ms): ${reason}`,
					)
					return {
						name,
						passed: false,
						error: `[strict] ${reason}:\n${stderrSummary.slice(0, 500)}`,
						output: output.slice(0, 1000),
						durationMs,
						warnings,
						errors,
						stderrSummary,
						strictness,
					}
				}
			}

			if (result.status !== 0) {
				const err = new Error(result.stderr || `Exit code ${result.status}`)
				;(err as any).stderr = result.stderr
				;(err as any).stdout = result.stdout
				throw err
			}

			const warningNote = warnings > 0 ? ` (${warnings} warning${warnings !== 1 ? "s" : ""})` : ""
			const errorNote = errors > 0 ? ` (${errors} error${errors !== 1 ? "s" : ""})` : ""
			this.logger?.appendLine(
				`[VerificationEngine] Gate "${name}" PASSED [${strictness}] (${durationMs}ms)${warningNote}${errorNote}`,
			)
			return {
				name,
				passed: true,
				output: output.slice(0, 1000),
				durationMs,
				warnings,
				errors,
				stderrSummary,
				strictness,
			}
		} catch (error: any) {
			const durationMs = Date.now() - start
			const errStderr = error?.stderr || ""
			const { warnings, errors, stderrSummary } = parseStderr(errStderr)
			const errorMsg = error?.stderr || error?.stdout || error?.message || String(error)

			// Check for ENOENT or status 127 in catch block too (for non-spawnSync errors)
			if (
				error?.code === "ENOENT" ||
				error?.status === 127 ||
				(errorMsg &&
					(errorMsg.includes("ENOENT") ||
						errorMsg.includes("Exit code 127") ||
						errorMsg.includes("command not found")))
			) {
				this.logger?.appendLine(
					`[VerificationEngine] Gate "${name}" skipped: command not found in this project context`,
				)
				return {
					name,
					passed: true,
					durationMs,
					warnings: 0,
					errors: 0,
					strictness,
					skipped: true,
					skipReason: "command not found in this project context",
				}
			}

			this.logger?.appendLine(
				`[VerificationEngine] Gate "${name}" FAILED [${strictness}] (${durationMs}ms): ${errorMsg.slice(0, 200)}`,
			)
			return {
				name,
				passed: false,
				error: errorMsg.slice(0, 1000),
				durationMs,
				warnings,
				errors,
				stderrSummary,
				strictness,
			}
		}
	}
}

/**
 * Parse stderr for warning and error patterns (case-insensitive).
 * Detects lines containing: error, ERROR, Error, warning, WARNING, Warning
 * Returns counts and a truncated summary.
 */
export function parseStderr(stderr: string): { warnings: number; errors: number; stderrSummary: string } {
	if (!stderr || stderr.trim().length === 0) {
		return { warnings: 0, errors: 0, stderrSummary: "" }
	}

	const lines = stderr.split("\n")
	let warnings = 0
	let errors = 0
	const summaryLines: string[] = []

	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) continue

		if (
			/\berror\b/i.test(trimmed) ||
			/^\[error\]/i.test(trimmed) ||
			/^ERROR/i.test(trimmed) ||
			/^Error\b/.test(trimmed)
		) {
			errors++
			if (summaryLines.length < 10) {
				summaryLines.push(`ERR: ${trimmed.slice(0, 120)}`)
			}
			continue
		}

		if (
			/\bwarning\b/i.test(trimmed) ||
			/^\[warning\]/i.test(trimmed) ||
			/^WARNING/i.test(trimmed) ||
			/^Warning\b/.test(trimmed)
		) {
			warnings++
			if (summaryLines.length < 10) {
				summaryLines.push(`WRN: ${trimmed.slice(0, 120)}`)
			}
		}
	}

	const remaining = lines.length - summaryLines.length
	let stderrSummary = summaryLines.join("\n")
	if (remaining > 0) {
		stderrSummary += `\n... and ${remaining - summaryLines.length} more line${remaining - summaryLines.length !== 1 ? "s" : ""}`
	}

	return { warnings, errors, stderrSummary: stderrSummary.slice(0, 2000) }
}
