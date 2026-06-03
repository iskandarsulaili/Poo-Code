// Run: cd Zoo-Code/src && pnpm vitest run services/__tests__/subagent/ResultAggregator.spec.ts

import { ResultAggregator } from "../../subagent/ResultAggregator"
import type { SubagentResult } from "../../subagent/types"

describe("ResultAggregator", () => {
	describe("aggregate", () => {
		it("should return empty result for zero results", () => {
			const result = ResultAggregator.aggregate([])
			expect(result.success).toBe(true)
			expect(result.mergedOutput).toBe("")
			expect(result.executionSummary.totalSubagents).toBe(0)
		})

		it("should merge outputs from all successful results", () => {
			const results: SubagentResult[] = [
				{
					subagentId: "sa-1",
					success: true,
					output: "Output from agent 1",
					filesModified: [],
					fileChanges: [],
					executionTimeMs: 100,
				},
				{
					subagentId: "sa-2",
					success: true,
					output: "Output from agent 2",
					filesModified: [],
					fileChanges: [],
					executionTimeMs: 150,
				},
			]

			const result = ResultAggregator.aggregate(results)
			expect(result.success).toBe(true)
			expect(result.mergedOutput).toContain("Output from agent 1")
			expect(result.mergedOutput).toContain("Output from agent 2")
			expect(result.executionSummary.succeeded).toBe(2)
		})

		it("should include failed results in summary", () => {
			const results: SubagentResult[] = [
				{
					subagentId: "sa-1",
					success: true,
					output: "Success",
					filesModified: [],
					fileChanges: [],
					executionTimeMs: 100,
				},
				{
					subagentId: "sa-2",
					success: false,
					output: "",
					filesModified: [],
					fileChanges: [],
					errors: ["Something went wrong"],
					executionTimeMs: 10,
				},
			]

			const result = ResultAggregator.aggregate(results)
			expect(result.executionSummary.totalSubagents).toBe(2)
			expect(result.executionSummary.succeeded).toBe(1)
			expect(result.executionSummary.failed).toBe(1)
		})

		it("should detect same-file conflict in description", () => {
			const results: SubagentResult[] = [
				{
					subagentId: "sa-1",
					success: true,
					output: "Agent 1 work",
					filesModified: ["src/shared.ts"],
					fileChanges: [],
					executionTimeMs: 100,
				},
				{
					subagentId: "sa-2",
					success: true,
					output: "Agent 2 work",
					filesModified: ["src/shared.ts"],
					fileChanges: [],
					executionTimeMs: 150,
				},
			]

			const result = ResultAggregator.aggregate(results)
			expect(result.conflicts).toBeDefined()
			if (result.conflicts && result.conflicts.length > 0) {
				const fileConflict = result.conflicts.find((c) => c.description.includes("src/shared.ts"))
				if (fileConflict) {
					expect(fileConflict.type).toBe("file")
					expect(fileConflict.resolution.strategy).toBe("last_writer_wins")
				}
			}
		})
	})

	describe("mergeOutputs", () => {
		it("should return single result output directly when one success", () => {
			const results: SubagentResult[] = [
				{
					subagentId: "sa-1",
					success: true,
					output: "Hello world",
					filesModified: [],
					fileChanges: [],
					executionTimeMs: 50,
				},
			]

			const output = ResultAggregator.mergeOutputs(results)
			expect(output).toBe("Hello world")
		})
	})
})
