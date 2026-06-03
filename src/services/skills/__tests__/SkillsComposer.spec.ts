import { SkillsComposer, type SkillExecutor } from "../SkillsComposer"
import { SkillsError, type SkillComposition } from "../types"

describe("SkillsComposer", () => {
	const pipelineComposition: SkillComposition = {
		id: "pipe-1",
		name: "Pipeline Test",
		mode: "pipeline",
		skillChain: ["skill-a", "skill-b", "skill-c"],
		stopOnFailure: true,
		createdAt: Date.now(),
	}

	const inheritanceComposition: SkillComposition = {
		id: "inherit-1",
		name: "Inheritance Test",
		mode: "inheritance",
		skillChain: ["parent", "child"],
		stopOnFailure: true,
		createdAt: Date.now(),
	}

	const groupComposition: SkillComposition = {
		id: "group-1",
		name: "Group Test",
		mode: "group",
		skillChain: ["skill-x", "skill-y"],
		stopOnFailure: false,
		createdAt: Date.now(),
	}

	function makeExecutor(): SkillExecutor {
		return vi.fn(async (_name, _ctx) => ({ result: "ok" }))
	}

	describe("register()", () => {
		it("should register a composition", () => {
			const composer = new SkillsComposer(makeExecutor())
			composer.register(pipelineComposition)
			expect(composer.getComposition("pipe-1")).toBe(pipelineComposition)
		})

		it("should throw when registering duplicate id", () => {
			const composer = new SkillsComposer(makeExecutor())
			composer.register(pipelineComposition)
			expect(() => composer.register(pipelineComposition)).toThrow(SkillsError)
		})
	})

	describe("unregister()", () => {
		it("should unregister an existing composition", () => {
			const composer = new SkillsComposer(makeExecutor())
			composer.register(pipelineComposition)
			expect(composer.unregister("pipe-1")).toBe(true)
			expect(composer.getComposition("pipe-1")).toBeUndefined()
		})

		it("should return false for non-existent composition", () => {
			const composer = new SkillsComposer(makeExecutor())
			expect(composer.unregister("ghost")).toBe(false)
		})
	})

	describe("getComposition()", () => {
		it("should return undefined for unknown composition", () => {
			const composer = new SkillsComposer(makeExecutor())
			expect(composer.getComposition("unknown")).toBeUndefined()
		})
	})

	describe("listCompositions()", () => {
		it("should list all registered compositions", () => {
			const composer = new SkillsComposer(makeExecutor())
			composer.register(pipelineComposition)
			composer.register(inheritanceComposition)
			expect(composer.listCompositions()).toHaveLength(2)
		})
	})

	describe("execute()", () => {
		it("should throw for unknown composition", async () => {
			const composer = new SkillsComposer(makeExecutor())
			await expect(composer.execute("unknown")).rejects.toThrow(SkillsError)
		})

		it("should execute pipeline mode sequentially", async () => {
			const executor = makeExecutor()
			const composer = new SkillsComposer(executor)
			composer.register(pipelineComposition)

			const result = await composer.execute("pipe-1")
			expect(result.success).toBe(true)
			expect(result.compositionId).toBe("pipe-1")
			expect(result.durationMs).toBeGreaterThanOrEqual(0)
			expect(executor).toHaveBeenCalledTimes(3)
		})

		it("should execute inheritance mode", async () => {
			const executor = makeExecutor()
			const composer = new SkillsComposer(executor)
			composer.register(inheritanceComposition)

			const result = await composer.execute("inherit-1")
			expect(result.success).toBe(true)
			expect(executor).toHaveBeenCalledTimes(2)
		})

		it("should execute group mode (parallel)", async () => {
			const executor = makeExecutor()
			const composer = new SkillsComposer(executor)
			composer.register(groupComposition)

			const result = await composer.execute("group-1")
			expect(result.success).toBe(true)
			expect(executor).toHaveBeenCalledTimes(2)
		})

		it("should handle executor failure in pipeline", async () => {
			const failingExecutor: SkillExecutor = vi.fn(async (name, _ctx) => {
				if (name === "skill-b") throw new Error("Skill B failed")
				return { result: "ok" }
			})
			const composer = new SkillsComposer(failingExecutor)
			composer.register({
				...pipelineComposition,
				stopOnFailure: true,
			})

			const result = await composer.execute("pipe-1")
			expect(result.success).toBe(false)
			expect(result.errors).toHaveProperty("skill-b")
		})

		it("should return error result when no executor provided", async () => {
			const composer = new SkillsComposer()
			composer.register(pipelineComposition)

			const result = await composer.execute("pipe-1")
			expect(result.success).toBe(false)
			expect(Object.keys(result.errors).length).toBeGreaterThan(0)
		})
	})

	describe("setExecutor()", () => {
		it("should replace the executor", async () => {
			const old = vi.fn()
			const composer = new SkillsComposer(old)
			composer.register(pipelineComposition)

			const newExec = vi.fn(async () => ({ result: "ok" }))
			composer.setExecutor(newExec)
			await composer.execute("pipe-1")
			expect(newExec).toHaveBeenCalled()
			expect(old).not.toHaveBeenCalled()
		})
	})
})
