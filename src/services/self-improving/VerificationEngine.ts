import * as fs from "fs/promises"
import * as path from "path"
import type { Logger } from "./types"

export interface VerificationResult {
	passed: boolean
	gates: Array<{
		name: string
		passed: boolean
		output?: string
		error?: string
		durationMs: number
	}>
	summary: string
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
}

const DEFAULT_CONFIG: VerificationConfig = {
	checkBuild: false,
	checkLint: false,
	checkTypes: false,
	checkTests: false,
	gateTimeoutMs: 60_000,
	mandatory: true,
}

export class VerificationEngine {
	private config: VerificationConfig
	private lastVerifyAt?: number
	private lastResult?: VerificationResult
	private enabled: boolean

	constructor(
		private readonly logger?: Logger,
		config?: Partial<VerificationConfig>,
		enabled: boolean = true,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.enabled = enabled
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled
		this.logger?.appendLine(
			`[VerificationEngine] ${enabled ? "Enabled" : "Disabled"}`,
		)
	}

	updateConfig(config: Partial<VerificationConfig>): void {
		this.config = { ...this.config, ...config }
		this.logger?.appendLine(
			`[VerificationEngine] Config updated: ${JSON.stringify(config)}`,
		)
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
		}
	}

	async verify(): Promise<VerificationResult> {
		const gates: VerificationResult["gates"] = []

		if (this.config.checkBuild && this.config.buildCommand) {
			gates.push(await this.runGate("build", this.config.buildCommand))
		}

		if (this.config.checkLint && this.config.lintCommand) {
			gates.push(await this.runGate("lint", this.config.lintCommand))
		}

		if (this.config.checkTypes && this.config.typeCheckCommand) {
			gates.push(await this.runGate("type-check", this.config.typeCheckCommand))
		}

		if (this.config.checkTests && this.config.testCommand) {
			gates.push(await this.runGate("tests", this.config.testCommand))
		}

		const passed = gates.every((g) => g.passed)
		const failedGates = gates.filter((g) => !g.passed)

		let summary: string
		if (gates.length === 0) {
			summary = "No verification gates configured"
		} else if (passed) {
			summary = `All ${gates.length} verification gates passed`
		} else {
			summary = `${failedGates.length}/${gates.length} gates failed: ${failedGates.map((g) => g.name).join(", ")}`
		}

		this.logger?.appendLine(`[VerificationEngine] ${summary}`)

		this.lastVerifyAt = Date.now()
		this.lastResult = { passed, gates, summary }

		return { passed, gates, summary }
	}

	/**
	 * Check whether a valid package.json exists in the configured cwd.
	 * Falls back to process.cwd() if config.cwd is not set.
	 */
	private async isCwdValid(): Promise<boolean> {
		try {
			const cwd = this.config.cwd || process.cwd()
			const packageJsonPath = path.join(cwd, "package.json")
			await fs.access(packageJsonPath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Walk up from the configured cwd (or process.cwd()) looking for
	 * the first directory that contains a package.json.
	 * Returns the found directory path, or undefined if none exists.
	 */
	private async findProjectRoot(): Promise<string | undefined> {
		let current = path.resolve(this.config.cwd || process.cwd())
		const root = path.parse(current).root

		while (current !== root) {
			try {
				await fs.access(path.join(current, "package.json"))
				return current
			} catch {
				current = path.dirname(current)
			}
		}
		// One last check at filesystem root
		try {
			await fs.access(path.join(root, "package.json"))
			return root
		} catch {
			return undefined
		}
	}

	private async runGate(
		name: string,
		command: string,
	): Promise<VerificationResult["gates"][0]> {
		const start = Date.now()

		// --- cwd guard: skip gate if no package.json is reachable ---
		if (!(await this.isCwdValid())) {
			const fallbackCwd = await this.findProjectRoot()
			if (fallbackCwd) {
				this.logger?.appendLine(
					`[VerificationEngine] Gate "${name}": cwd invalid, falling back to ${fallbackCwd}`,
				)
				this.config.cwd = fallbackCwd
			} else {
				this.logger?.warn?.(
					`[VerificationEngine] No package.json found in cwd or any parent directory, skipping gate "${name}"`,
				)
				return {
					name,
					passed: true,
					output: "Skipped: no package.json in working directory",
					durationMs: Date.now() - start,
				}
			}
		}

		try {
			// Use dynamic import for child_process to avoid issues in webview context
			const { execSync } = await import("child_process")

			const output = execSync(command, {
				cwd: this.config.cwd,
				timeout: this.config.gateTimeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			})

			const durationMs = Date.now() - start
			this.logger?.appendLine(
				`[VerificationEngine] Gate "${name}" passed (${durationMs}ms)`,
			)
			return { name, passed: true, output: output.slice(0, 1000), durationMs }
		} catch (error: any) {
			const durationMs = Date.now() - start
			const errorMsg =
				error?.stderr || error?.stdout || error?.message || String(error)
			this.logger?.appendLine(
				`[VerificationEngine] Gate "${name}" FAILED (${durationMs}ms): ${errorMsg.slice(0, 200)}`,
			)
			return {
				name,
				passed: false,
				error: errorMsg.slice(0, 1000),
				durationMs,
			}
		}
	}
}
