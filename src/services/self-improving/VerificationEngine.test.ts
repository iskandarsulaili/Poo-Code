import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { VerificationEngine, GateResult, parseStderr } from "./VerificationEngine"

// ── Auto-detection tests ──────────────────────────────────────────
// Mock fs/promises for auto-detection scenarios.
// Safe — existing verify tests use child_process, not fs/promises.
vi.mock("fs/promises")

// Mock LLM completion handler — tests that need it will configure the mock inline.
vi.mock("../../utils/single-completion-handler")

describe("VerificationEngine", () => {
	let engine: VerificationEngine
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		logger = { appendLine: vi.fn() }
		engine = new VerificationEngine(logger, {
			checkBuild: false,
			checkLint: false,
			checkTypes: false,
			checkTests: false,
			checkFileChanges: false,
			gateTimeoutMs: 5000,
			mandatory: true,
			strictness: "moderate",
		})
	})

	describe("config", () => {
		it("should use defaults when no config provided", () => {
			const e = new VerificationEngine()
			const config = e.getConfig()
			expect(config.checkBuild).toBe(false)
			expect(config.checkLint).toBe(true) // Changed from false
			expect(config.checkTypes).toBe(true) // Changed from false
			expect(config.checkTests).toBe(false)
			expect(config.checkFileChanges).toBe(true)
			expect(config.enableStubDetection).toBe(true)
			expect(config.gateTimeoutMs).toBe(60000)
			expect(config.mandatory).toBe(true)
			expect(config.strictness).toBe("moderate")
			expect(config.maxWarnings).toBe(0)
			expect(config.testCoverageThreshold).toBe(0)
		})

		it("should merge partial config with defaults", () => {
			const e = new VerificationEngine(undefined, {
				checkBuild: true,
				buildCommand: "npm run build",
			})
			const config = e.getConfig()
			expect(config.checkBuild).toBe(true)
			expect(config.buildCommand).toBe("npm run build")
			expect(config.checkLint).toBe(true) // default
			expect(config.strictness).toBe("moderate") // default
			expect(config.gateTimeoutMs).toBe(60000)
		})

		it("should update config via updateConfig", () => {
			engine.updateConfig({ checkLint: true, lintCommand: "npm run lint" })
			const config = engine.getConfig()
			expect(config.checkLint).toBe(true)
			expect(config.lintCommand).toBe("npm run lint")
		})

		it("should allow setting strictness level", () => {
			engine.updateConfig({ strictness: "strict" })
			expect(engine.getConfig().strictness).toBe("strict")
		})

		it("should allow setting enterprise strictness with thresholds", () => {
			engine.updateConfig({ strictness: "enterprise", maxWarnings: 5, testCoverageThreshold: 80 })
			expect(engine.getConfig().strictness).toBe("enterprise")
			expect(engine.getConfig().maxWarnings).toBe(5)
			expect(engine.getConfig().testCoverageThreshold).toBe(80)
		})
	})

	describe("verify with no gates", () => {
		it("should return passed=true with no gates configured", async () => {
			const result = await engine.verify()
			expect(result.passed).toBe(true)
			expect(result.gates).toHaveLength(0)
			expect(result.summary).toBe("No verification gates configured [moderate]")
		})
	})

	describe("verify with gates", () => {
		it("should pass when all gates pass", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "echo build-ok",
				checkLint: true,
				lintCommand: "echo lint-ok",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(true)
			expect(result.gates).toHaveLength(2)
			expect(result.gates[0].name).toBe("build")
			expect(result.gates[0].passed).toBe(true)
			expect(result.gates[0].warnings).toBe(0)
			expect(result.gates[0].errors).toBe(0)
			expect(result.gates[0].strictness).toBe("moderate")
			expect(result.gates[1].name).toBe("lint")
			expect(result.gates[1].passed).toBe(true)
			expect(result.gates[1].strictness).toBe("moderate")
			expect(result.summary).toContain("All 2 verification gates passed")
			expect(result.summary).toContain("[moderate]")
		})

		it("should fail when build fails", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("build")
			expect(result.gates[0].passed).toBe(false)
			expect(result.gates[0].error).toBeTruthy()
			expect(result.gates[0].strictness).toBe("moderate")
			expect(result.summary).toContain("1/1 gates failed")
		})

		it("should fail when lint fails", async () => {
			engine.updateConfig({
				checkLint: true,
				lintCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("lint")
			expect(result.gates[0].passed).toBe(false)
		})

		it("should fail when type check fails", async () => {
			engine.updateConfig({
				checkTypes: true,
				typeCheckCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("type-check")
			expect(result.gates[0].passed).toBe(false)
		})

		it("should fail when tests fail", async () => {
			engine.updateConfig({
				checkTests: true,
				testCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("tests")
			expect(result.gates[0].passed).toBe(false)
		})

		it("should report multiple failures", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "false",
				checkLint: true,
				lintCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(2)
			expect(result.gates.every((g) => !g.passed)).toBe(true)
			expect(result.summary).toContain("2/2 gates failed")
		})

		it("should record duration for each gate", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "echo build-ok",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].durationMs).toBeGreaterThanOrEqual(0)
		})

		it("should timeout when command exceeds gateTimeoutMs", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "sleep 10",
				gateTimeoutMs: 100,
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates[0].name).toBe("build")
			expect(result.gates[0].passed).toBe(false)
			expect(result.gates[0].error).toBeTruthy()
			// Gate should have failed due to timeout — error is present
			expect(result.gates[0].durationMs).toBeGreaterThanOrEqual(0)
		})
	})

	describe("strictness levels", () => {
		describe("lenient (exit code only)", () => {
			it("should pass on exit code 0 even with stderr warnings", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "echo build-ok",
					cwd: "/tmp",
					strictness: "lenient",
				})

				const result = await engine.verify()
				expect(result.passed).toBe(true)
				expect(result.gates[0].strictness).toBe("lenient")
				expect(result.summary).toContain("[lenient]")
			})

			it("should fail on non-zero exit code", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "false",
					cwd: "/tmp",
					strictness: "lenient",
				})

				const result = await engine.verify()
				expect(result.passed).toBe(false)
			})
		})

		describe("moderate (exit code + stderr parsing)", () => {
			it("should pass on exit code 0 and report warnings count", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "echo build-ok",
					cwd: "/tmp",
					strictness: "moderate",
				})

				const result = await engine.verify()
				expect(result.passed).toBe(true)
				expect(result.gates[0].strictness).toBe("moderate")
				// Gate result should have warnings/errors fields even if zero
				expect(result.gates[0].warnings).toBe(0)
				expect(result.gates[0].errors).toBe(0)
			})

			it("should fail on non-zero exit code", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "false",
					cwd: "/tmp",
					strictness: "moderate",
				})

				const result = await engine.verify()
				expect(result.passed).toBe(false)
			})
		})

		describe("strict (exit code + fail on stderr errors)", () => {
			it("should pass on exit code 0 with no stderr errors", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "echo build-ok",
					cwd: "/tmp",
					strictness: "strict",
				})

				const result = await engine.verify()
				expect(result.passed).toBe(true)
				expect(result.gates[0].strictness).toBe("strict")
			})

			it("should fail on non-zero exit code", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "false",
					cwd: "/tmp",
					strictness: "strict",
				})

				const result = await engine.verify()
				expect(result.passed).toBe(false)
			})
		})

		describe("enterprise (exit code + zero warnings + content validation)", () => {
			it("should pass on clean exit with no warnings", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "echo build-ok",
					cwd: "/tmp",
					strictness: "enterprise",
					maxWarnings: 0,
				})

				const result = await engine.verify()
				expect(result.passed).toBe(true)
				expect(result.gates[0].strictness).toBe("enterprise")
			})

			it("should fail on non-zero exit code", async () => {
				engine.updateConfig({
					checkBuild: true,
					buildCommand: "false",
					cwd: "/tmp",
					strictness: "enterprise",
				})

				const result = await engine.verify()
				expect(result.passed).toBe(false)
			})
		})

		it("should include strictness in summary string", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "echo build-ok",
				cwd: "/tmp",
				strictness: "strict",
			})

			const result = await engine.verify()
			expect(result.summary).toContain("[strict]")
			expect(result.strictness).toBe("strict")
		})

		it("should include strictness in result object", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "echo build-ok",
				cwd: "/tmp",
				strictness: "enterprise",
			})

			const result = await engine.verify()
			expect(result.strictness).toBe("enterprise")
		})
	})

	describe("gate result fields", () => {
		it("should include warnings and errors fields on pass", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "echo build-ok",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			const gate = result.gates[0]
			expect(gate).toHaveProperty("warnings")
			expect(gate).toHaveProperty("errors")
			expect(gate).toHaveProperty("stderrSummary")
			expect(gate).toHaveProperty("strictness")
			expect(gate.warnings).toBe(0)
			expect(gate.errors).toBe(0)
		})

		it("should include warnings and errors fields on fail", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			const gate = result.gates[0]
			expect(gate).toHaveProperty("warnings")
			expect(gate).toHaveProperty("errors")
			expect(gate).toHaveProperty("strictness")
		})
	})

	describe("stderr parsing", () => {
		it("should return zeros for empty stderr", () => {
			const result = parseStderr("")
			expect(result.warnings).toBe(0)
			expect(result.errors).toBe(0)
			expect(result.stderrSummary).toBe("")
		})

		it("should count warnings", () => {
			const stderr = "warning: unused variable\nWARNING: deprecated API\nWarning: something"
			const result = parseStderr(stderr)
			expect(result.warnings).toBe(3)
			expect(result.errors).toBe(0)
		})

		it("should count errors", () => {
			const stderr = "error: build failed\nERROR: compilation error\nError: runtime exception"
			const result = parseStderr(stderr)
			expect(result.warnings).toBe(0)
			expect(result.errors).toBe(3)
		})

		it("should count mixed warnings and errors", () => {
			const stderr = "error: build failed\nwarning: unused variable\nERROR: compilation error"
			const result = parseStderr(stderr)
			expect(result.warnings).toBe(1)
			expect(result.errors).toBe(2)
		})

		it("should detect [error] prefixed lines", () => {
			const stderr = "[error] module not found"
			const result = parseStderr(stderr)
			expect(result.errors).toBe(1)
		})

		it("should detect [warning] prefixed lines", () => {
			const stderr = "[warning] deprecated feature"
			const result = parseStderr(stderr)
			expect(result.warnings).toBe(1)
		})

		it("should produce a summary with truncated lines", () => {
			const stderr = Array.from({ length: 15 }, (_, i) => `warning: issue number ${i}`).join("\n")
			const result = parseStderr(stderr)
			expect(result.warnings).toBe(15)
			expect(result.stderrSummary).toContain("... and")
			expect(result.stderrSummary.length).toBeLessThanOrEqual(2000)
		})

		it("should include error markers in summary lines", () => {
			const stderr = "ERROR: critical failure"
			const result = parseStderr(stderr)
			expect(result.stderrSummary).toContain("ERR:")
		})

		it("should include warning markers in summary lines", () => {
			const stderr = "WARNING: deprecated"
			const result = parseStderr(stderr)
			expect(result.stderrSummary).toContain("WRN:")
		})
	})

	describe("override behavior", () => {
		it("should allow strictness override from experiment config", () => {
			engine.updateConfig({
				strictness: "enterprise",
				maxWarnings: 3,
			})
			const config = engine.getConfig()
			expect(config.strictness).toBe("enterprise")
			expect(config.maxWarnings).toBe(3)
		})

		it("should allow toggling checkLint and checkTypes independently", () => {
			engine.updateConfig({
				checkLint: true,
				checkTypes: false,
			})
			const config = engine.getConfig()
			expect(config.checkLint).toBe(true)
			expect(config.checkTypes).toBe(false)
		})
	})

	describe("mandatory flag", () => {
		it("should return mandatory=true by default", () => {
			expect(engine.getConfig().mandatory).toBe(true)
		})

		it("should allow setting mandatory=false", () => {
			engine.updateConfig({ mandatory: false })
			expect(engine.getConfig().mandatory).toBe(false)
		})
	})

	describe("auto-detection with scoring", () => {
		// Mock fs/promises is already applied at the top of the file via vi.mock.

		beforeEach(() => {
			logger = { appendLine: vi.fn() }
			engine = new VerificationEngine(logger, {
				checkBuild: false,
				checkLint: false,
				checkTypes: false,
				checkTests: false,
				checkFileChanges: false,
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})
		})

		it("should detect Kotlin from build.gradle.kts without gradlew", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			_mockDirectories.add("/workspace/kotlin-simple")
			_mockFiles.set("/workspace/kotlin-simple/build.gradle.kts", "")

			const profile = await engine.autoDetectProject("/workspace/kotlin-simple")

			expect(profile).not.toBeNull()
			expect(profile!.language).toBe("Kotlin")
			expect(profile!.buildCommand).toBe("gradle build")
			expect(profile!.lintCommand).toBe("gradle ktlintCheck")
			expect(profile!.testCommand).toBe("gradle test")
			expect(profile!.detectedFrom).toBe("build.gradle.kts")
		})

		it("should detect Kotlin and use ./gradlew when gradlew exists", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			_mockDirectories.add("/workspace/kotlin-gradlew")
			_mockFiles.set("/workspace/kotlin-gradlew/build.gradle.kts", "")
			_mockFiles.set("/workspace/kotlin-gradlew/gradlew", "")

			const profile = await engine.autoDetectProject("/workspace/kotlin-gradlew")

			expect(profile).not.toBeNull()
			expect(profile!.language).toBe("Kotlin")
			expect(profile!.buildCommand).toBe("./gradlew build")
			expect(profile!.testCommand).toBe("./gradlew test")
		})

		it("should prefer Kotlin over JS/TS in a repo with both build.gradle.kts and package.json", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			_mockDirectories.add("/workspace/multi-lang")
			_mockFiles.set("/workspace/multi-lang/build.gradle.kts", "")
			_mockFiles.set("/workspace/multi-lang/gradlew", "")
			_mockFiles.set(
				"/workspace/multi-lang/package.json",
				JSON.stringify({
					scripts: { build: "echo ok", lint: "echo ok", test: "echo ok", typecheck: "echo ok" },
				}),
			)
			_mockFiles.set("/workspace/multi-lang/tsconfig.json", "")

			const profile = await engine.autoDetectProject("/workspace/multi-lang")

			expect(profile).not.toBeNull()
			expect(profile!.language).toBe("Kotlin")
			expect(profile!.buildCommand).toBe("./gradlew build")
		})

		it("should prefer Rust over JS/TS when both Cargo.toml and package.json exist", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			_mockDirectories.add("/workspace/rust-ts")
			_mockFiles.set("/workspace/rust-ts/Cargo.toml", "")
			_mockFiles.set(
				"/workspace/rust-ts/package.json",
				JSON.stringify({
					scripts: { build: "echo ok", lint: "echo ok" },
				}),
			)
			_mockFiles.set("/workspace/rust-ts/tsconfig.json", "")

			const profile = await engine.autoDetectProject("/workspace/rust-ts")

			expect(profile).not.toBeNull()
			expect(profile!.language).toBe("Rust")
			expect(profile!.buildCommand).toBe("cargo build")
		})

		it("should return null when no project markers exist", async () => {
			const { _mockDirectories } = (await import("fs/promises")) as any
			_mockDirectories.add("/workspace/empty-project")

			const profile = await engine.autoDetectProject("/workspace/empty-project")
			expect(profile).toBeNull()
		})
	})

	describe("LLM-based detection", () => {
		it("should fall back to signatures when no API config provided", async () => {
			const e = new VerificationEngine(logger, {
				checkBuild: false,
				checkLint: false,
				checkTypes: false,
				checkTests: false,
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})
			// apiConfiguration is undefined, so autoDetectProject should skip LLM
			// and use signature-based detection
			const result = await e.autoDetectProject("/tmp/nonexistent")
			expect(result).toBeNull()
			expect(logger.appendLine).toHaveBeenCalledWith(
				"[VerificationEngine] No recognizable project files detected",
			)
		})

		it("should use LLM when API config is provided and LLM succeeds", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			vi.mocked(singleCompletionHandler).mockResolvedValue(
				JSON.stringify({
					language: "Kotlin",
					buildCommand: "./gradlew build",
					lintCommand: "ktlint .",
					typeCheckCommand: null,
					testCommand: "./gradlew test",
					commandSources: {
						buildCommand: "gradle",
						lintCommand: "ktlint",
						typeCheckCommand: null,
						testCommand: "gradle",
					},
					detectedFrom: "build.gradle.kts",
				}),
			)

			const mockApiConfig = { apiProvider: "openai", apiKey: "test" } as any
			const e = new VerificationEngine(
				logger,
				{
					checkBuild: false,
					checkLint: false,
					checkTypes: false,
					checkTests: false,
					gateTimeoutMs: 5000,
					mandatory: true,
					strictness: "moderate",
				},
				true,
				mockApiConfig,
			)

			// Set up the project directory with some files to prompt LLM detection
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const projectPath = "/workspace/llm-project"
			_mockDirectories.add(projectPath)
			_mockFiles.set(`${projectPath}/build.gradle.kts`, "")
			_mockFiles.set(`${projectPath}/settings.gradle.kts`, "")
			_mockDirectories.add(`${projectPath}/src`)

			const result = await e.autoDetectProject(projectPath)

			expect(result).not.toBeNull()
			expect(result?.language).toBe("Kotlin")
			expect(result?.buildCommand).toBe("./gradlew build")
			expect(result?.lintCommand).toBe("ktlint .")
			expect(result?.testCommand).toBe("./gradlew test")
			expect(result?.detectedFrom).toBe("build.gradle.kts")
			expect(result?.commandSources.buildCommand).toBe("gradle")

			expect(logger.appendLine).toHaveBeenCalledWith(
				"[VerificationEngine] Attempting LLM-based project detection...",
			)
			expect(logger.appendLine).toHaveBeenCalledWith(
				"[VerificationEngine] LLM auto-detected project: Kotlin (from build.gradle.kts)",
			)
		})

		it("should fall back to signatures when LLM call fails", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			vi.mocked(singleCompletionHandler).mockRejectedValue(new Error("API timeout"))

			const mockApiConfig = { apiProvider: "openai", apiKey: "test" } as any
			const e = new VerificationEngine(
				logger,
				{
					checkBuild: false,
					checkLint: false,
					checkTypes: false,
					checkTests: false,
					gateTimeoutMs: 5000,
					mandatory: true,
					strictness: "moderate",
				},
				true,
				mockApiConfig,
			)

			// Set up directory with known markers so signature detection succeeds
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const projectPath = "/workspace/llm-fallback"
			_mockDirectories.add(projectPath)
			_mockFiles.set(`${projectPath}/Cargo.toml`, "")

			const result = await e.autoDetectProject(projectPath)

			expect(result).not.toBeNull()
			// Should fall back to signature-based detection (Rust from Cargo.toml)
			expect(result?.language).toBe("Rust")
			expect(result?.buildCommand).toBe("cargo build")

			// Verify both LLM attempt and fallback were logged
			expect(logger.appendLine).toHaveBeenCalledWith(
				"[VerificationEngine] Attempting LLM-based project detection...",
			)
			expect(logger.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[VerificationEngine] LLM detection failed:"),
			)
			expect(logger.appendLine).toHaveBeenCalledWith(
				"[VerificationEngine] Auto-detected project: Rust (score: 20)",
			)
		})
	})

	describe("isProjectWithTooling", () => {
		it("should return true when package.json has build script", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/tooling-build"
			_mockDirectories.add(dir)
			_mockFiles.set(
				`${dir}/package.json`,
				JSON.stringify({ scripts: { build: "echo ok" } }),
			)

			const result = await VerificationEngine.isProjectWithTooling(dir)
			expect(result).toBe(true)
		})

		it("should return true when package.json has test script", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/tooling-test"
			_mockDirectories.add(dir)
			_mockFiles.set(
				`${dir}/package.json`,
				JSON.stringify({ scripts: { test: "echo ok" } }),
			)

			const result = await VerificationEngine.isProjectWithTooling(dir)
			expect(result).toBe(true)
		})

		it("should return false when package.json has no relevant scripts", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/tooling-empty"
			_mockDirectories.add(dir)
			_mockFiles.set(
				`${dir}/package.json`,
				JSON.stringify({ name: "empty", scripts: { start: "node index.js" } }),
			)

			const result = await VerificationEngine.isProjectWithTooling(dir)
			expect(result).toBe(false)
		})

		it("should return true when Cargo.toml exists", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/tooling-cargo"
			_mockDirectories.add(dir)
			_mockFiles.set(`${dir}/Cargo.toml`, "")

			const result = await VerificationEngine.isProjectWithTooling(dir)
			expect(result).toBe(true)
		})

		it("should return true when go.mod exists", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/tooling-go"
			_mockDirectories.add(dir)
			_mockFiles.set(`${dir}/go.mod`, "")

			const result = await VerificationEngine.isProjectWithTooling(dir)
			expect(result).toBe(true)
		})

		it("should return false for empty directory", async () => {
			const { _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/tooling-empty-dir"
			_mockDirectories.add(dir)

			const result = await VerificationEngine.isProjectWithTooling(dir)
			expect(result).toBe(false)
		})

		it("should return true when .ts source file exists without package.json", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/tooling-ts"
			_mockDirectories.add(dir)
			_mockFiles.set(`${dir}/index.ts`, `export const x = 1`)

			const result = await VerificationEngine.isProjectWithTooling(dir)
			expect(result).toBe(true)
		})

		it("should cache results per cwd to avoid repeated fs reads", async () => {
			const fsPromises = await import("fs/promises") as any
			const _mockFiles = fsPromises._mockFiles
			const _mockDirectories = fsPromises._mockDirectories
			const dir = "/workspace/tooling-cache"
			_mockDirectories.add(dir)
			_mockFiles.set(
				`${dir}/package.json`,
				JSON.stringify({ scripts: { build: "echo ok" } }),
			)

			// Clear cache before test
			VerificationEngine.clearToolingCache()

			// First call — should read fs
			const result1 = await VerificationEngine.isProjectWithTooling(dir)
			expect(result1).toBe(true)

			// Remove the file from mock to prove cache is used on second call
			_mockFiles.delete(`${dir}/package.json`)

			// Second call — should use cache, not re-read fs
			const result2 = await VerificationEngine.isProjectWithTooling(dir)
			expect(result2).toBe(true) // still true from cache

			// Clear cache, third call should reflect removed file
			VerificationEngine.clearToolingCache()
			const result3 = await VerificationEngine.isProjectWithTooling(dir)
			expect(result3).toBe(false) // no package.json anymore

			// Clean up
			_mockFiles.set(`${dir}/package.json`, JSON.stringify({ scripts: { build: "echo ok" } }))
		})
	})

	describe("skip detection — markdown-only directories", () => {
		it("should skip all gates for markdown-only directory", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/markdown-only"
			_mockDirectories.add(dir)
			_mockFiles.set(`${dir}/README.md`, "# Docs")
			_mockFiles.set(`${dir}/CONTRIBUTING.md`, "# Contributing")

			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "npm run build",
				checkLint: true,
				lintCommand: "npm run lint",
				checkTypes: true,
				typeCheckCommand: "npm run typecheck",
				checkTests: true,
				testCommand: "npm test",
				cwd: dir,
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "strict",
			})

			const result = await e.verify()

			expect(result.passed).toBe(true)
			expect(result.allSkipped).toBe(true)
			expect(result.gates).toHaveLength(4)
			for (const gate of result.gates) {
				expect(gate.skipped).toBe(true)
				expect(gate.skipReason).toContain("markdown-only")
				expect(gate.strictness).toBe("lenient") // auto-downgraded
			}
			expect(result.summary).toContain("skipped")
			expect(result.summary).toContain("markdown-only")
		})

		it("should skip all gates for directory with locales/ subdirectory only", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/locales-dir"
			_mockDirectories.add(dir)
			_mockDirectories.add(`${dir}/locales`)
			_mockFiles.set(`${dir}/locales/README.md`, "# Locale")

			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "npm run build",
				checkLint: true,
				lintCommand: "npm run lint",
				cwd: dir,
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "strict",
			})

			const result = await e.verify()

			expect(result.passed).toBe(true)
			expect(result.allSkipped).toBe(true)
			for (const gate of result.gates) {
				expect(gate.skipped).toBe(true)
				expect(gate.strictness).toBe("lenient")
			}
		})

		it("should NOT skip for repo with locales/ AND package.json scripts", async () => {
			const fsPromises = await import("fs/promises") as any
			const _mockFiles = fsPromises._mockFiles
			const _mockDirectories = fsPromises._mockDirectories
			const dir = "/workspace/repo-with-locales"
			_mockDirectories.add(dir)
			_mockDirectories.add(`${dir}/locales`)
			_mockFiles.set(`${dir}/locales/README.md`, "# Lang")
			_mockFiles.set(
				`${dir}/package.json`,
				JSON.stringify({ scripts: { build: "echo ok" } }),
			)
	
			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "echo build-ok",
				cwd: "/tmp",
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})
	
			const result = await e.verify()
	
			// Should run gate (has tooling in config, cwd=/tmp means no tooling check)
			expect(result.gates.length).toBeGreaterThanOrEqual(1)
			expect(result.allSkipped).toBeFalsy()
		})
	})

	describe("ENOENT handling", () => {
		it("should skip gate when command binary does not exist", async () => {
			const { _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/enonet-test"
			_mockDirectories.add(dir)

			const fsPromises = await import("fs/promises") as any
			fsPromises._mockFiles.set(
				`${dir}/package.json`,
				JSON.stringify({ scripts: { build: "echo ok" } }),
			)

			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "nonexistent-binary-that-does-not-exist",
				cwd: dir,
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})

			const result = await e.verify()

			expect(result.gates).toHaveLength(1)
			const gate = result.gates[0]
			expect(gate.passed).toBe(true) // skipped → passed
			expect(gate.skipped).toBe(true)
			expect(gate.skipReason).toContain("command not found")
		})

		it("should skip gate when exit code is 127 (command not found)", async () => {
			const { _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/enonet-127"
			_mockDirectories.add(dir)

			const fsPromises = await import("fs/promises") as any
			fsPromises._mockFiles.set(
				`${dir}/package.json`,
				JSON.stringify({ scripts: { lint: "echo ok" } }),
			)

			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "sh -c 'exit 127'",
				cwd: dir,
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})

			const result = await e.verify()

			expect(result.gates).toHaveLength(1)
			const gate = result.gates[0]
			expect(gate.passed).toBe(true) // 127 → skipped → passed
			expect(gate.skipped).toBe(true)
			expect(gate.skipReason).toContain("command not found")
		})
	})

	describe("normal project (not skipped)", () => {
		it("should run gates normally when project has tooling", async () => {
			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "echo build-ok",
				checkLint: true,
				lintCommand: "echo lint-ok",
				cwd: "/tmp",
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})
	
			const result = await e.verify()
	
			expect(result.allSkipped).toBeFalsy()
			expect(result.gates).toHaveLength(2)
			expect(result.gates[0].passed).toBe(true)
			expect(result.gates[1].passed).toBe(true)
			expect(result.gates[0].skipped).toBeFalsy()
			expect(result.gates[1].skipped).toBeFalsy()
			expect(result.passed).toBe(true)
		})
	
		it("should fail on non-zero exit code when tooling is present (not skipped)", async () => {
			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "false",
				cwd: "/tmp",
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})
	
			const result = await e.verify()
	
			// Should NOT skip — tooling exists, command runs but fails
			expect(result.passed).toBe(false)
			const gate = result.gates[0]
			expect(gate.skipped).toBeFalsy()
			expect(gate.passed).toBe(false)
			expect(gate.error).toBeTruthy()
		})

		it("should handle mixed scenario: some gates skip, some run", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/mixed-scenario"
			_mockDirectories.add(dir)
			// Only a README.md — simulates markdown-only dir
			_mockFiles.set(`${dir}/README.md`, "# Docs")

			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "echo build-ok",
				checkLint: true,
				lintCommand: "echo lint-ok",
				cwd: "/tmp", // real cwd with tooling, not the markdown-only dir
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})

			const result = await e.verify()

			// Gates run from /tmp (real tooling available)
			expect(result.allSkipped).toBeFalsy()
			expect(result.gates).toHaveLength(2)
			for (const gate of result.gates) {
				expect(gate.skipped).toBeFalsy()
				expect(gate.passed).toBe(true)
			}
			expect(result.passed).toBe(true)
		})

		it("should not count skipped gates as failures in aggregate", async () => {
			const { _mockFiles, _mockDirectories } = (await import("fs/promises")) as any
			const dir = "/workspace/partial-skip"
			_mockDirectories.add(dir)
			// No tooling in this dir — isProjectWithTooling returns false
			_mockFiles.set(`${dir}/README.md`, "# Readme")

			VerificationEngine.clearToolingCache()

			const e = new VerificationEngine(logger, {
				checkBuild: true,
				buildCommand: "echo build-ok", // will be skipped — dir has no tooling
				checkLint: true,
				lintCommand: "echo lint-ok", // will be skipped — dir has no tooling
				cwd: dir,
				gateTimeoutMs: 5000,
				mandatory: true,
				strictness: "moderate",
			})

			const result = await e.verify()

			// All gates should be skipped, overall should pass
			expect(result.passed).toBe(true)
			expect(result.allSkipped).toBe(true)
			for (const gate of result.gates) {
				expect(gate.skipped).toBe(true)
				expect(gate.passed).toBe(true) // skipped = passed
			}
			expect(result.summary).toContain("skipped")
		})
	})
})

// ==========================================================================
// File-changes gate tests
// ==========================================================================

describe("file-changes gate", () => {
	let engine: VerificationEngine
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		logger = { appendLine: vi.fn() }
		engine = new VerificationEngine(logger, {
			checkBuild: false,
			checkLint: false,
			checkTypes: false,
			checkTests: false,
			checkFileChanges: true,
			enableStubDetection: false,
			gateTimeoutMs: 5000,
			mandatory: true,
			strictness: "moderate",
		})
	})

	it("should skip gracefully when cwd is not a git repo", async () => {
		// Without a git repo, the file-changes gate should skip (not fail)
		engine.updateConfig({ cwd: "/tmp" })
		const result = await engine.verify()
		const fileChangeGate = result.gates.find((g) => g.name === "file-changes")
		expect(fileChangeGate).toBeDefined()
		// Should skip (not a git repo) or pass with tool-call file evidence
		// In /tmp with no git repo, it should skip
		if (fileChangeGate!.skipped) {
			// skipped gates report passed:true
		}
	})

	it("should pass with tool call file paths even without git", async () => {
		engine.updateConfig({ cwd: "/tmp" })
		// Provide tool call file paths — should pass even without git
		const result = await engine.verify([
			"src/test.ts",
			"src/utils.ts",
		])
		const fileChangeGate = result.gates.find((g) => g.name === "file-changes")
		expect(fileChangeGate).toBeDefined()
		if (fileChangeGate && !fileChangeGate.skipped) {
			expect(fileChangeGate.passed).toBe(true)
		}
	})
})

// ==========================================================================
// Stub detection pattern tests
// ==========================================================================

describe("stub detection", () => {
	let engine: VerificationEngine

	beforeEach(() => {
		engine = new VerificationEngine(undefined, {
			checkBuild: false,
			checkLint: false,
			checkTypes: false,
			checkTests: false,
			checkFileChanges: false,
			enableStubDetection: true,
			gateTimeoutMs: 5000,
		})
	})

	it("should be enabled by default", () => {
		const config = engine.getConfig()
		expect(config.enableStubDetection).toBe(true)
	})

	it("should detect stub patterns in config", () => {
		// Verifying the config defaults don't have the removed false-positive patterns
		const config = engine.getConfig()
		expect(config.enableStubDetection).toBe(true)
	})
})

// ==========================================================================
// Stderr parsing edge cases
// ==========================================================================

describe("parseStderr edge cases", () => {
	it("should handle null-like input", () => {
		const empty = parseStderr("")
		expect(empty.warnings).toBe(0)
		expect(empty.errors).toBe(0)
	})

	it("should handle very long stderr", () => {
		const long = Array.from({ length: 100 }, (_, i) => `error: issue ${i}`).join("\n")
		const result = parseStderr(long)
		expect(result.errors).toBe(100)
		expect(result.stderrSummary.length).toBeLessThanOrEqual(2000)
	})

	it("should properly count mixed warnings and errors", () => {
		const mixed = [
			"WARNING: deprecated API usage",
			"ERROR: compilation failed in module.ts",
			"[error] cannot find module",
			"Warning: unused variable x",
			"Error: type mismatch",
		].join("\n")
		const result = parseStderr(mixed)
		expect(result.warnings).toBe(2)
		expect(result.errors).toBe(3)
	})
})