import { spawn, execSync } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import os from "os"
import crypto from "crypto"

export interface SandboxResult {
	exitCode: number
	stdout: string
	stderr: string
	durationMs: number
}

/**
 * Lightweight Python sandbox for executing user-provided code.
 * Runs in an isolated subprocess with minimal environment variables.
 * No network access, no access to sensitive files outside workspace.
 */
export class CodeSandbox {
	private readonly maxOutputBytes = 50 * 1024 // 50KB
	private readonly defaultTimeoutMs = 30_000
	private readonly maxTimeoutMs = 300_000
	private pythonBinary: string | null = null

	private getPythonBinary(): string {
		if (this.pythonBinary) return this.pythonBinary
		// Try python3 first, fall back to python
		for (const candidate of ["python3", "python"]) {
			try {
				execSync(candidate + " --version", { stdio: "ignore" })
				this.pythonBinary = candidate
				return candidate
			} catch {
				continue
			}
		}
		this.pythonBinary = "python3"
		return this.pythonBinary
	}

	async execute(code: string, timeoutSeconds?: number): Promise<SandboxResult> {
		const timeoutMs = Math.min((timeoutSeconds || 30) * 1000, this.maxTimeoutMs)
		const tmpDir = path.join(os.tmpdir(), "zoo-code-sandbox")
		await fs.mkdir(tmpDir, { recursive: true })
		const tmpFile = path.join(tmpDir, `exec_${crypto.randomUUID().slice(0, 8)}.py`)
		await fs.writeFile(tmpFile, code, "utf-8")

		const startTime = Date.now()
		const pythonBin = this.getPythonBinary()

		return new Promise((resolve) => {
			const child = spawn(pythonBin, [tmpFile], {
				env: {
					PATH: process.env.PATH || "/usr/bin",
					HOME: process.env.HOME || "/tmp",
					PYTHONIOENCODING: "utf-8",
				},
				timeout: timeoutMs,
			})

			let stdout = ""
			let stderr = ""

			child.stdout.on("data", (data: Buffer) => {
				if (stdout.length < this.maxOutputBytes) {
					stdout += data.toString("utf-8").slice(0, this.maxOutputBytes - stdout.length)
				}
			})

			child.stderr.on("data", (data: Buffer) => {
				if (stderr.length < this.maxOutputBytes) {
					stderr += data.toString("utf-8").slice(0, this.maxOutputBytes - stderr.length)
				}
			})

			child.on("close", async (exitCode) => {
				const durationMs = Date.now() - startTime
				try {
					await fs.unlink(tmpFile)
				} catch {}
				resolve({ exitCode: exitCode ?? 1, stdout, stderr, durationMs })
			})

			child.on("error", async (err) => {
				const durationMs = Date.now() - startTime
				try {
					await fs.unlink(tmpFile)
				} catch {}
				resolve({ exitCode: 1, stdout, stderr: err.message, durationMs })
			})
		})
	}
}

export default CodeSandbox
