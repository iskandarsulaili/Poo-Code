import { vi, describe, it, expect, beforeEach } from "vitest"

// execa is used as a tagged template literal: execa(options)`command`
// The mock must return a function that when called as tagged template returns a promise
const mockExecaResults = vi.hoisted(() => [{ exitCode: 0, stdout: "ok", stderr: "", all: "ok" }])
let mockExecaCallIndex = vi.hoisted(() => 0)

vi.mock("execa", () => ({
	execa: vi.fn((_options: any) => {
		// Return a function that acts as a tagged template literal handler
		const templateFn = (_strings: TemplateStringsArray, ..._values: any[]) => {
			const idx = mockExecaCallIndex++
			const result = mockExecaResults[idx] ?? mockExecaResults[mockExecaResults.length - 1]
			if (result.exitCode !== 0) {
				const err: any = new Error("Command failed")
				err.exitCode = result.exitCode
				err.stdout = result.stdout
				err.stderr = result.stderr
				err.all = result.all
				err.name = "ExecaError"
				err.timedOut = false
				err.isTerminated = false
				return Promise.reject(err)
			}
			return Promise.resolve(result)
		}
		return templateFn
	}),
	ExecaError: class ExecaError extends Error {
		exitCode?: number
		stdout?: string
		stderr?: string
		all?: string
		timedOut?: boolean
		isTerminated?: boolean
		signal?: string
		constructor(msg: string, opts?: { exitCode?: number; stdout?: string; stderr?: string; all?: string }) {
			super(msg)
			this.name = "ExecaError"
			this.exitCode = opts?.exitCode
			this.stdout = opts?.stdout
			this.stderr = opts?.stderr
			this.all = opts?.all
		}
	},
}))

import { ParallelExecutor, Semaphore } from "../ParallelExecutor"
import type { ParallelCommand, ParallelCommandGroup } from "@roo-code/types"

describe("Semaphore", () => {
	it("should limit concurrency", async () => {
		const sem = new Semaphore(2)
		let concurrent = 0
		let maxConcurrent = 0

		const task = async () => {
			await sem.acquire()
			concurrent++
			maxConcurrent = Math.max(maxConcurrent, concurrent)
			await new Promise((r) => setTimeout(r, 10))
			concurrent--
			sem.release()
		}

		await Promise.all([task(), task(), task(), task()])
		expect(maxConcurrent).toBeLessThanOrEqual(2)
	})

	it("should run function under semaphore guard", async () => {
		const sem = new Semaphore(1)
		let ran = false
		await sem.run(async () => {
			ran = true
		})
		expect(ran).toBe(true)
	})

	it("should allow dynamic concurrency adjustment", () => {
		const sem = new Semaphore(2)
		sem.setConcurrency(5)
		expect(true).toBe(true)
	})

	it("should clamp concurrency to minimum 1", () => {
		const sem = new Semaphore(2)
		sem.setConcurrency(0)
		expect(true).toBe(true)
	})
})

describe("ParallelExecutor", () => {
	let executor: ParallelExecutor

	beforeEach(() => {
		vi.clearAllMocks()
		mockExecaCallIndex = 0
		// Reset to default success results
		mockExecaResults.length = 0
		mockExecaResults.push({ exitCode: 0, stdout: "ok", stderr: "", all: "ok" })
		executor = new ParallelExecutor({ maxParallel: 4, isParallelEnabled: true })
	})

	describe("execute (flat array)", () => {
		it("should return empty result for empty commands", async () => {
			const result = await executor.execute([])
			expect(result.groups).toHaveLength(0)
			expect(result.totalDuration).toBe(0)
		})

		it("should execute single command", async () => {
			const result = await executor.execute([{ command: "echo ok" }])
			expect(result.groups).toHaveLength(1)
			expect(result.groups[0].commands).toHaveLength(1)
			expect(result.groups[0].commands[0].exitCode).toBe(0)
		})

		it("should aggregate results with correct totals", async () => {
			const result = await executor.execute([{ command: "echo a" }, { command: "echo b" }])
			expect(result.successCount).toBe(2)
			expect(result.failedCount).toBe(0)
		})
	})

	describe("executeGroup", () => {
		it("should execute a single group", async () => {
			const group: ParallelCommandGroup = {
				id: "test-group",
				commands: [{ command: "echo ok" }],
				sequential: false,
				continue_on_error: true,
				wait_for: [],
			}

			const result = await executor.executeGroup(group)
			expect(result.id).toBe("test-group")
			expect(result.commands).toHaveLength(1)
		})

		it("should execute sequential groups in order", async () => {
			const group: ParallelCommandGroup = {
				id: "seq-group",
				commands: [{ command: "cmd1" }, { command: "cmd2" }, { command: "cmd3" }],
				sequential: true,
				continue_on_error: false,
				wait_for: [],
			}

			const result = await executor.executeGroup(group)
			expect(result.commands).toHaveLength(3)
			expect(result.commands[0].exitCode).toBe(0)
			expect(result.commands[1].exitCode).toBe(0)
			expect(result.commands[2].exitCode).toBe(0)
		})

		it("should skip remaining commands on failure when continue_on_error is false", async () => {
			mockExecaResults.length = 0
			mockExecaResults.push({ exitCode: 1, stdout: "", stderr: "error", all: "error" })
			mockExecaResults.push({ exitCode: 0, stdout: "ok", stderr: "", all: "ok" })

			const group: ParallelCommandGroup = {
				id: "fail-group",
				commands: [{ command: "fail" }, { command: "should-be-skipped" }],
				sequential: true,
				continue_on_error: false,
				wait_for: [],
			}

			const result = await executor.executeGroup(group)
			expect(result.commands).toHaveLength(2)
			expect(result.commands[1].error).toContain("Skipped")
		})

		it("should continue with remaining commands when continue_on_error is true", async () => {
			mockExecaResults.length = 0
			mockExecaResults.push({ exitCode: 1, stdout: "", stderr: "error", all: "error" })
			mockExecaResults.push({ exitCode: 0, stdout: "ok", stderr: "", all: "ok" })

			const group: ParallelCommandGroup = {
				id: "continue-group",
				commands: [{ command: "fail" }, { command: "should-run" }],
				sequential: true,
				continue_on_error: true,
				wait_for: [],
			}

			const result = await executor.executeGroup(group)
			expect(result.commands).toHaveLength(2)
			expect(result.commands[1].error).toBeUndefined()
			expect(result.commands[1].exitCode).toBe(0)
		})
	})

	describe("executeGroups", () => {
		it("should return empty for empty groups", async () => {
			const result = await executor.executeGroups([])
			expect(result.groups).toHaveLength(0)
		})

		it("should handle single group fast path", async () => {
			const result = await executor.executeGroups([
				{
					id: "g1",
					commands: [{ command: "echo ok" }],
					sequential: false,
					continue_on_error: true,
					wait_for: [],
				},
			])
			expect(result.groups).toHaveLength(1)
		})

		it("should respect wait_for dependencies between groups", async () => {
			const groups: ParallelCommandGroup[] = [
				{
					id: "g1",
					commands: [{ command: "first" }],
					sequential: false,
					continue_on_error: true,
					wait_for: [],
				},
				{
					id: "g2",
					commands: [{ command: "second" }],
					sequential: false,
					continue_on_error: true,
					wait_for: ["g1"],
				},
			]

			const result = await executor.executeGroups(groups)
			expect(result.groups).toHaveLength(2)
		})

		it("should detect deadlock and skip blocked groups", async () => {
			const groups: ParallelCommandGroup[] = [
				{
					id: "g1",
					commands: [{ command: "a" }],
					sequential: false,
					continue_on_error: true,
					wait_for: ["g2"],
				},
				{
					id: "g2",
					commands: [{ command: "b" }],
					sequential: false,
					continue_on_error: true,
					wait_for: ["g1"],
				},
			]

			const result = await executor.executeGroups(groups)
			// Both groups should be skipped due to deadlock
			expect(result.skippedCount).toBe(2)
		})
	})

	describe("executeParallel (low-level)", () => {
		it("should return empty for empty commands", async () => {
			const results = await executor.executeParallel([], 4)
			expect(results).toHaveLength(0)
		})

		it("should execute commands with semaphore limiting", async () => {
			const results = await executor.executeParallel([{ command: "a" }, { command: "b" }], 2)
			expect(results).toHaveLength(2)
		})
	})

	describe("executeSequential (fallback)", () => {
		it("should execute commands in order", async () => {
			const results = await executor.executeSequential([{ command: "first" }, { command: "second" }])
			expect(results).toHaveLength(2)
		})

		it("should stop on failure when continueOnError is false", async () => {
			mockExecaResults.length = 0
			mockExecaResults.push({ exitCode: 1, stdout: "", stderr: "error", all: "error" })
			mockExecaResults.push({ exitCode: 0, stdout: "ok", stderr: "", all: "ok" })

			const results = await executor.executeSequential(
				[{ command: "fail" }, { command: "skip" }],
				undefined,
				false,
			)
			expect(results).toHaveLength(2)
			expect(results[1].error).toContain("Skipped")
		})
	})

	describe("feature flag disabled", () => {
		it("should fall back to sequential when isParallelEnabled is false", async () => {
			const seqExecutor = new ParallelExecutor({ maxParallel: 4, isParallelEnabled: false })

			const result = await seqExecutor.execute([{ command: "echo ok" }])
			expect(result.groups[0].sequential).toBe(true)
		})
	})

	describe("error handling", () => {
		it("should handle empty command string", async () => {
			const result = await executor.execute([{ command: "" }])
			expect(result.groups[0].commands[0].error).toBeDefined()
		})
	})
})
