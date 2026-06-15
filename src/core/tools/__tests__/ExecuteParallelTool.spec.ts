import { describe, it, expect, vi, beforeEach } from "vitest"

import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import type { ExecuteParallelParams, AggregatedResult, GroupResult, CommandResult } from "@roo-code/types"

import { ExecuteParallelTool } from "../ExecuteParallelTool"
import { experimentConfigsMap } from "../../../shared/experiments"

// ============================================================================
// Mock ParallelExecutor to avoid real subprocess execution
// ============================================================================
vi.mock("../../orchestration/ParallelExecutor", () => {
	const MockSemaphore = vi.fn(() => ({
		acquire: vi.fn(),
		release: vi.fn(),
		run: vi.fn((fn: () => Promise<unknown>) => fn()),
		setConcurrency: vi.fn(),
	}))

	const MockParallelExecutor = vi.fn().mockImplementation(() => ({
		semaphore: new MockSemaphore(),
		executeGroups: vi.fn(),
	}))

	return { Semaphore: MockSemaphore, ParallelExecutor: MockParallelExecutor }
})

// ============================================================================
// Test suite
// ============================================================================
describe("ExecuteParallelTool", () => {
	let tool: ExecuteParallelTool
	let mockTask: Task
	let mockCallbacks: ToolCallbacks

	// ------------------------------------------------------------------
	// Helpers: build valid params
	// ------------------------------------------------------------------
	function validParams(overrides: Partial<ExecuteParallelParams> = {}): ExecuteParallelParams {
		return {
			groups: [
				{
					id: "frontend",
					sequential: false,
					commands: [{ command: "npm run build" }],
					wait_for: [],
					continue_on_error: false,
				},
			],
			max_parallel: null,
			...overrides,
		}
	}

	function makeGroupResult(overrides: Partial<GroupResult> = {}): GroupResult {
		return {
			id: "frontend",
			sequential: false,
			commands: [
				{
					command: "npm run build",
					cwd: "/test/project",
					exitCode: 0,
					duration: 1200,
					stdout: "Build successful",
					stderr: "",
					parsed: {
						exitCode: 0,
						duration: 1200,
						stdout: "Build successful",
						stderr: "",
						errors: [],
						warnings: [],
						genericMessages: [],
						summary: "OK",
						rawOutput: "Build successful",
						truncated: false,
					},
					rawOutput: "Build successful",
					truncated: false,
				},
			],
			successCount: 1,
			failedCount: 0,
			skippedCount: 0,
			totalDuration: 1200,
			...overrides,
		}
	}

	function makeAggregatedResult(overrides: Partial<AggregatedResult> = {}): AggregatedResult {
		return {
			groups: [makeGroupResult()],
			totalDuration: 1200,
			successCount: 1,
			failedCount: 0,
			skippedCount: 0,
			...overrides,
		}
	}

	// ------------------------------------------------------------------
	// Setup
	// ------------------------------------------------------------------
	beforeEach(() => {
		vi.clearAllMocks()

		// Ensure feature flag is enabled by default for most tests
		experimentConfigsMap.PARALLEL_EXECUTION.enabled = true

		tool = new ExecuteParallelTool()

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			rooIgnoreController: {
				validateCommand: vi.fn().mockReturnValue(undefined),
			},
		} as unknown as Task

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	// ==================================================================
	// Tool name
	// ==================================================================
	describe("name", () => {
		it("should return execute_parallel", () => {
			expect(tool.name).toBe("execute_parallel")
		})
	})

	// ==================================================================
	// Feature flag disabled
	// ==================================================================
	describe("feature flag disabled", () => {
		it("should return fallback message without executing when PARALLEL_EXECUTION is disabled", async () => {
			experimentConfigsMap.PARALLEL_EXECUTION.enabled = false

			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				"Parallel execution is disabled via experiment config. Use execute_command sequentially.",
			)
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})
	})

	// ==================================================================
	// Not initialized
	// ==================================================================
	describe("not initialized", () => {
		it("should return init error message when executor is not initialized", async () => {
			// tool is not initialized — executor is undefined
			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				"Parallel executor is not initialized. Ensure initialize() is called during extension activation.",
			)
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})
	})

	// ==================================================================
	// Validation
	// ==================================================================
	describe("validation", () => {
		beforeEach(() => {
			// Initialize so we get past the init check
			tool.initialize({} as any)
		})

		it("should return validation error when groups param is empty", async () => {
			await tool.execute(validParams({ groups: [] }), mockTask, mockCallbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("execute_parallel")
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})

		it("should return validation error when groups param is undefined", async () => {
			await tool.execute(validParams({ groups: undefined as any }), mockTask, mockCallbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("execute_parallel")
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})

		it("should return validation error when group is missing an id", async () => {
			await tool.execute(
				validParams({
					groups: [
						{
							id: "",
							sequential: false,
							commands: [{ command: "echo test" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Group at index 0 is missing an 'id'"),
			)
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})

		it("should return validation error when group has no commands", async () => {
			await tool.execute(
				validParams({
					groups: [
						{
							id: "test-group",
							sequential: false,
							commands: [],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining('Group "test-group" has no commands'),
			)
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})

		it("should return validation error when command string is empty", async () => {
			await tool.execute(
				validParams({
					groups: [
						{
							id: "test-group",
							sequential: false,
							commands: [{ command: "" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining('Group "test-group", command 1: command string is empty'),
			)
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})

		it("should return validation error when command string is whitespace only", async () => {
			await tool.execute(
				validParams({
					groups: [
						{
							id: "test-group",
							sequential: false,
							commands: [{ command: "   " }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining('Group "test-group", command 1: command string is empty'),
			)
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})

		it("should return validation error when command is blocked by .rooignore", async () => {
			const mockRooIgnore = {
				validateCommand: vi.fn().mockReturnValue("/blocked/path"),
			}
			;(mockTask as any).rooIgnoreController = mockRooIgnore

			await tool.execute(
				validParams({
					groups: [
						{
							id: "test-group",
							sequential: false,
							commands: [{ command: "cat /blocked/path" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining(
					'Group "test-group", command 1: access to "/blocked/path" is blocked by .rooignore',
				),
			)
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})

		it("should collect multiple validation errors across groups", async () => {
			await tool.execute(
				validParams({
					groups: [
						{
							id: "",
							sequential: false,
							commands: [{ command: "echo a" }],
							wait_for: [],
							continue_on_error: false,
						},
						{
							id: "group2",
							sequential: false,
							commands: [],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			const result = (mockCallbacks.pushToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(result).toContain("Group at index 0 is missing an 'id'")
			expect(result).toContain('Group "group2" has no commands')
			expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		})
	})

	// ==================================================================
	// Approval flow
	// ==================================================================
	describe("approval flow", () => {
		beforeEach(() => {
			tool.initialize({} as any)
		})

		it("should proceed to execute when user approves", async () => {
			const aggregated = makeAggregatedResult()
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(aggregated)

			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.askApproval).toHaveBeenCalled()
			expect(executor.executeGroups).toHaveBeenCalled()
			expect(mockCallbacks.pushToolResult).toHaveBeenCalled()
		})

		it("should return without executing when user denies approval", async () => {
			mockCallbacks.askApproval = vi.fn().mockResolvedValue(false)

			const executor = (tool as any).executor
			executor.executeGroups = vi.fn()

			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.askApproval).toHaveBeenCalled()
			expect(executor.executeGroups).not.toHaveBeenCalled()
			expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
		})
	})

	// ==================================================================
	// Successful execution
	// ==================================================================
	describe("successful execution", () => {
		beforeEach(() => {
			tool.initialize({} as any)
		})

		it("should format result with group headers and command details", async () => {
			const aggregated = makeAggregatedResult({
				groups: [
					makeGroupResult({
						id: "frontend",
						commands: [
							{
								command: "npm run build",
								cwd: "/test/project",
								exitCode: 0,
								duration: 1200,
								stdout: "Build successful",
								stderr: "",
								parsed: {
									exitCode: 0,
									duration: 1200,
									stdout: "Build successful",
									stderr: "",
									errors: [],
									warnings: [],
									genericMessages: [],
									summary: "OK",
									rawOutput: "Build successful",
									truncated: false,
								},
								rawOutput: "Build successful",
								truncated: false,
							},
						],
						successCount: 1,
						failedCount: 0,
						skippedCount: 0,
						totalDuration: 1200,
					}),
				],
				totalDuration: 1200,
				successCount: 1,
				failedCount: 0,
				skippedCount: 0,
			})
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(aggregated)

			await tool.execute(validParams(), mockTask, mockCallbacks)

			const result = (mockCallbacks.pushToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(result).toContain("## Parallel Execution Results")
			expect(result).toContain("1 group")
			expect(result).toContain("1 succeeded")
			expect(result).toContain("Total duration: 1.2s")
			expect(result).toContain("### Group: frontend")
			expect(result).toContain("npm run build")
			expect(result).toContain("exit code 0")
		})

		it("should show errors in result format when present", async () => {
			const aggregated = makeAggregatedResult({
				groups: [
					makeGroupResult({
						id: "backend",
						commands: [
							{
								command: "cargo build",
								cwd: "/test/project",
								exitCode: 1,
								duration: 500,
								stdout: "",
								stderr: "error[E0308]: mismatched types",
								parsed: {
									exitCode: 1,
									duration: 500,
									stdout: "",
									stderr: "error[E0308]: mismatched types",
									errors: [
										{
											file: "src/main.rs",
											line: 42,
											column: 8,
											severity: "error",
											message: "mismatched types",
											code: "E0308",
											raw: "error[E0308]: mismatched types",
										},
									],
									warnings: [],
									genericMessages: [],
									summary: "Build failed",
									rawOutput: "error[E0308]: mismatched types",
									truncated: false,
								},
								rawOutput: "error[E0308]: mismatched types",
								truncated: false,
								error: "Command failed with exit code 1",
							},
						],
						successCount: 0,
						failedCount: 1,
						skippedCount: 0,
						totalDuration: 500,
					}),
				],
				totalDuration: 500,
				successCount: 0,
				failedCount: 1,
				skippedCount: 0,
			})
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(aggregated)

			await tool.execute(
				validParams({
					groups: [
						{
							id: "backend",
							sequential: false,
							commands: [{ command: "cargo build" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			const result = (mockCallbacks.pushToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(result).toContain("1 failed")
			expect(result).toContain("### Group: backend ✗")
			expect(result).toContain("exit code 1")
			expect(result).toContain("Error: Command failed with exit code 1")
			expect(result).toContain("1 parsed error")
			expect(result).toContain("src/main.rs:42:8 [E0308]")
		})

		it("should include skipped count when present", async () => {
			const aggregated = makeAggregatedResult({
				groups: [
					makeGroupResult({
						id: "frontend",
						commands: [
							{
								command: "npm run build",
								cwd: "/test/project",
								exitCode: 0,
								duration: 1000,
								stdout: "OK",
								stderr: "",
								parsed: {
									exitCode: 0,
									duration: 1000,
									stdout: "OK",
									stderr: "",
									errors: [],
									warnings: [],
									genericMessages: [],
									summary: "OK",
									rawOutput: "OK",
									truncated: false,
								},
								rawOutput: "OK",
								truncated: false,
							},
							{
								command: "npm run test",
								cwd: "/test/project",
								exitCode: undefined,
								duration: 0,
								stdout: "",
								stderr: "",
								parsed: {
									exitCode: undefined,
									duration: 0,
									stdout: "",
									stderr: "",
									errors: [],
									warnings: [],
									genericMessages: [],
									summary: "Skipped",
									rawOutput: "",
									truncated: false,
								},
								rawOutput: "",
								truncated: false,
								error: "Skipped: previous command failed",
							},
						],
						successCount: 1,
						failedCount: 0,
						skippedCount: 1,
						totalDuration: 1000,
					}),
				],
				totalDuration: 1000,
				successCount: 1,
				failedCount: 0,
				skippedCount: 1,
			})
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(aggregated)

			await tool.execute(validParams(), mockTask, mockCallbacks)

			const result = (mockCallbacks.pushToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(result).toContain("1 skipped")
			expect(result).toContain("⏭")
		})
	})

	// ==================================================================
	// Error handling
	// ==================================================================
	describe("error handling", () => {
		beforeEach(() => {
			tool.initialize({} as any)
		})

		it("should call handleError when executor crashes", async () => {
			const executor = (tool as any).executor
			const crashError = new Error("Executor crashed")
			executor.executeGroups.mockRejectedValue(crashError)

			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.handleError).toHaveBeenCalledWith("executing parallel command", crashError)
		})

		it("should call handleError when askApproval throws", async () => {
			mockCallbacks.askApproval = vi.fn().mockRejectedValue(new Error("Approval failed"))

			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.handleError).toHaveBeenCalledWith(
				"executing parallel command",
				expect.objectContaining({ message: "Approval failed" }),
			)
		})
	})

	// ==================================================================
	// Approval message format
	// ==================================================================
	describe("approval message format", () => {
		beforeEach(() => {
			tool.initialize({} as any)
		})

		it("should include max_parallel in approval message when provided", async () => {
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(validParams({ max_parallel: 2 }), mockTask, mockCallbacks)

			expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
				"command",
				expect.stringContaining("Max parallel groups: 2"),
			)
		})

		it("should show sequential mode in approval message", async () => {
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(
				validParams({
					groups: [
						{
							id: "backend",
							sequential: true,
							commands: [{ command: "cargo build" }, { command: "cargo test" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
				"command",
				expect.stringContaining("[backend] sequential"),
			)
		})

		it("should show wait_for dependencies in approval message", async () => {
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(
				validParams({
					groups: [
						{
							id: "frontend",
							sequential: false,
							commands: [{ command: "npm run build" }],
							wait_for: ["backend"],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
				"command",
				expect.stringContaining("(after: backend)"),
			)
		})

		it("should show cwd and timeout in approval message when provided", async () => {
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(
				validParams({
					groups: [
						{
							id: "frontend",
							sequential: false,
							commands: [{ command: "npm run build", cwd: "/app/frontend", timeout: 60 }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
				"command",
				expect.stringContaining("(cwd: /app/frontend)"),
			)
			expect(mockCallbacks.askApproval).toHaveBeenCalledWith("command", expect.stringContaining("[timeout: 60s]"))
		})

		it("should show 'Stop on first failure' when continue_on_error is false", async () => {
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(
				validParams({
					groups: [
						{
							id: "frontend",
							sequential: false,
							commands: [{ command: "npm run build" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
				"command",
				expect.stringContaining("→ Stop on first failure"),
			)
		})

		it("should use singular 'group' in approval message for single group", async () => {
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
				"command",
				expect.stringContaining("Execute the following command group:"),
			)
		})

		it("should use plural 'groups' in approval message for multiple groups", async () => {
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(
				validParams({
					groups: [
						{
							id: "frontend",
							sequential: false,
							commands: [{ command: "npm run build" }],
							wait_for: [],
							continue_on_error: false,
						},
						{
							id: "backend",
							sequential: false,
							commands: [{ command: "cargo build" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
				"command",
				expect.stringContaining("Execute 2 command groups:"),
			)
		})
	})

	// ==================================================================
	// Result format edge cases
	// ==================================================================
	describe("result format edge cases", () => {
		beforeEach(() => {
			tool.initialize({} as any)
		})

		it("should handle empty stdout gracefully", async () => {
			const aggregated = makeAggregatedResult({
				groups: [
					makeGroupResult({
						commands: [
							{
								command: "echo silent",
								cwd: "/test",
								exitCode: 0,
								duration: 100,
								stdout: "",
								stderr: "",
								parsed: {
									exitCode: 0,
									duration: 100,
									stdout: "",
									stderr: "",
									errors: [],
									warnings: [],
									genericMessages: [],
									summary: "OK",
									rawOutput: "",
									truncated: false,
								},
								rawOutput: "",
								truncated: false,
							},
						],
					}),
				],
			})
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(aggregated)

			await tool.execute(validParams(), mockTask, mockCallbacks)

			const result = (mockCallbacks.pushToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(result).toContain("exit code 0")
			// Should not have empty code blocks
			expect(result).not.toContain("```\n\n```")
		})

		it("should handle multiple groups in result", async () => {
			const aggregated = makeAggregatedResult({
				groups: [
					makeGroupResult({
						id: "frontend",
						commands: [
							{
								command: "npm run build",
								cwd: "/test",
								exitCode: 0,
								duration: 1000,
								stdout: "OK",
								stderr: "",
								parsed: {
									exitCode: 0,
									duration: 1000,
									stdout: "OK",
									stderr: "",
									errors: [],
									warnings: [],
									genericMessages: [],
									summary: "OK",
									rawOutput: "OK",
									truncated: false,
								},
								rawOutput: "OK",
								truncated: false,
							},
						],
						successCount: 1,
						failedCount: 0,
						skippedCount: 0,
						totalDuration: 1000,
					}),
					makeGroupResult({
						id: "backend",
						commands: [
							{
								command: "cargo build",
								cwd: "/test",
								exitCode: 0,
								duration: 2000,
								stdout: "Compiled",
								stderr: "",
								parsed: {
									exitCode: 0,
									duration: 2000,
									stdout: "Compiled",
									stderr: "",
									errors: [],
									warnings: [],
									genericMessages: [],
									summary: "OK",
									rawOutput: "Compiled",
									truncated: false,
								},
								rawOutput: "Compiled",
								truncated: false,
							},
						],
						successCount: 1,
						failedCount: 0,
						skippedCount: 0,
						totalDuration: 2000,
					}),
				],
				totalDuration: 2000,
				successCount: 2,
				failedCount: 0,
				skippedCount: 0,
			})
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(aggregated)

			await tool.execute(
				validParams({
					groups: [
						{
							id: "frontend",
							sequential: false,
							commands: [{ command: "npm run build" }],
							wait_for: [],
							continue_on_error: false,
						},
						{
							id: "backend",
							sequential: false,
							commands: [{ command: "cargo build" }],
							wait_for: [],
							continue_on_error: false,
						},
					],
				}),
				mockTask,
				mockCallbacks,
			)

			const result = (mockCallbacks.pushToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(result).toContain("### Group: frontend")
			expect(result).toContain("### Group: backend")
			expect(result).toContain("2 groups")
			expect(result).toContain("2 succeeded")
		})
	})

	// ==================================================================
	// Integration: initialize + execute
	// ==================================================================
	describe("initialize", () => {
		it("should create executor when initialize is called", () => {
			tool.initialize({} as any)
			expect((tool as any).executor).toBeDefined()
		})

		it("should allow execution after initialization", async () => {
			tool.initialize({} as any)
			const executor = (tool as any).executor
			executor.executeGroups.mockResolvedValue(makeAggregatedResult())

			await tool.execute(validParams(), mockTask, mockCallbacks)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalled()
			expect(mockCallbacks.pushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("not initialized"))
		})
	})
})
