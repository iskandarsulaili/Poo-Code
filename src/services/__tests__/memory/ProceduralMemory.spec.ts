import { describe, it, expect, beforeEach } from "vitest"
import { ProceduralMemory } from "../../memory/ProceduralMemory"
import { MemoryStoreError, MemoryTier, Procedure, ProcedureStep } from "../../memory/types"

describe("ProceduralMemory", () => {
	let memory: ProceduralMemory

	beforeEach(async () => {
		memory = new ProceduralMemory()
		await memory.initialize()
	})

	describe("storeProcedure and queryProcedures", () => {
		it("should store and retrieve procedures", async () => {
			const steps: ProcedureStep[] = [
				{ order: 1, action: "Run tests", tool: "vitest", expectedOutcome: "Tests pass" },
				{ order: 2, action: "Build project", tool: "pnpm", expectedOutcome: "Build succeeds" },
			]
			const procedure = await memory.storeProcedure({
				name: "Run CI Pipeline",
				steps,
				preconditions: ["Node installed", "Dependencies installed"],
				postconditions: ["Tests passed", "Build artifacts ready"],
				tags: ["ci", "build"],
			})
			expect(procedure.id).toBeDefined()
			expect(procedure.name).toBe("Run CI Pipeline")
			expect(procedure.usageCount).toBe(0)
			expect(procedure.successRate).toBe(1.0)
		})

		it("should throw if procedure has no name", async () => {
			await expect(
				memory.storeProcedure({
					name: "",
					steps: [{ order: 1, action: "Test", tool: "vitest", expectedOutcome: "Pass" }],
					preconditions: [],
					postconditions: [],
					tags: [],
				}),
			).rejects.toThrow(MemoryStoreError)
		})

		it("should throw if procedure has no steps", async () => {
			await expect(
				memory.storeProcedure({
					name: "Empty Procedure",
					steps: [],
					preconditions: [],
					postconditions: [],
					tags: [],
				}),
			).rejects.toThrow(MemoryStoreError)
		})
	})

	describe("query with preconditions", () => {
		it("should match correctly by name", async () => {
			await memory.storeProcedure({
				name: "Deploy to Production",
				steps: [{ order: 1, action: "Run deploy script", expectedOutcome: "Deployed" }],
				preconditions: ["Build passed"],
				postconditions: ["App running"],
				tags: ["deploy"],
			})
			await memory.storeProcedure({
				name: "Run Tests",
				steps: [{ order: 1, action: "Execute tests", expectedOutcome: "All pass" }],
				preconditions: ["Deps installed"],
				postconditions: ["Test results"],
				tags: ["test"],
			})

			const results = await memory.queryProcedures({ name: "Deploy" })
			expect(results).toHaveLength(1)
			expect(results[0].name).toContain("Deploy")

			const all = await memory.queryProcedures({})
			expect(all).toHaveLength(2)
		})
	})

	describe("recordUsage", () => {
		it("should track success rate after usage", async () => {
			const procedure = await memory.storeProcedure({
				name: "Fix Lint Errors",
				steps: [{ order: 1, action: "Run linter", expectedOutcome: "No errors" }],
				preconditions: ["Linter installed"],
				postconditions: ["Lint passes"],
				tags: ["lint"],
			})

			// First usage: success
			const successResult = await memory.recordUsage(procedure.id, true)
			expect(successResult.usageCount).toBe(1)
			expect(successResult.successRate).toBe(1.0)

			// Second usage: failure
			const failResult = await memory.recordUsage(procedure.id, false)
			expect(failResult.usageCount).toBe(2)
			expect(failResult.successRate).toBe(0.5)

			// Third usage: success
			const finalResult = await memory.recordUsage(procedure.id, true)
			expect(finalResult.usageCount).toBe(3)
			expect(finalResult.successRate).toBeCloseTo(0.667, 2)
		})

		it("should throw for unknown procedure", async () => {
			await expect(memory.recordUsage("nonexistent-id", true)).rejects.toThrow(MemoryStoreError)
		})
	})

	describe("fuzzy name matching", () => {
		it("should find similar procedures by name substring", async () => {
			await memory.storeProcedure({
				name: "Build Docker Image",
				steps: [{ order: 1, action: "Docker build", expectedOutcome: "Image created" }],
				preconditions: ["Dockerfile exists"],
				postconditions: ["Image tagged"],
				tags: ["docker"],
			})
			await memory.storeProcedure({
				name: "Push Docker Image",
				steps: [{ order: 1, action: "Docker push", expectedOutcome: "Image pushed" }],
				preconditions: ["Image built"],
				postconditions: ["Image in registry"],
				tags: ["docker"],
			})

			const dockerBuild = await memory.queryProcedures({ name: "Build Docker" })
			expect(dockerBuild).toHaveLength(1)
			expect(dockerBuild[0].name).toBe("Build Docker Image")

			const allDocker = await memory.queryProcedures({ tags: ["docker"] })
			expect(allDocker).toHaveLength(2)
		})
	})

	describe("tier property", () => {
		it("should return PROCEDURAL tier", () => {
			expect(memory.tier).toBe(MemoryTier.PROCEDURAL)
		})
	})
})
