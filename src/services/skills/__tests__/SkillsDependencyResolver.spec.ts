import { SkillsDependencyResolver } from "../SkillsDependencyResolver"
import { SkillsError, type SkillDependency } from "../types"

describe("SkillsDependencyResolver", () => {
	describe("register()", () => {
		it("should register a dependency", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({
				dependentSkill: "b",
				requiredSkill: "a",
				optional: false,
				reason: "b needs a",
			})
			expect(resolver.getDependencies("b")).toHaveLength(1)
		})

		it("should silently ignore duplicate registrations", () => {
			const resolver = new SkillsDependencyResolver()
			const dep: SkillDependency = {
				dependentSkill: "b",
				requiredSkill: "a",
				optional: false,
				reason: "b needs a",
			}
			resolver.register(dep)
			resolver.register(dep)
			expect(resolver.getDependencies("b")).toHaveLength(1)
		})
	})

	describe("registerMany()", () => {
		it("should register multiple dependencies", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.registerMany([
				{ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "b needs a" },
				{ dependentSkill: "c", requiredSkill: "b", optional: false, reason: "c needs b" },
			])
			expect(resolver.getDependencies("b")).toHaveLength(1)
			expect(resolver.getDependencies("c")).toHaveLength(1)
		})
	})

	describe("getDependencies()", () => {
		it("should return empty array for unknown skill", () => {
			const resolver = new SkillsDependencyResolver()
			expect(resolver.getDependencies("unknown")).toEqual([])
		})
	})

	describe("getMandatoryDependencies()", () => {
		it("should return only non-optional deps", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "a needed" })
			resolver.register({ dependentSkill: "b", requiredSkill: "c", optional: true, reason: "c optional" })
			const mandatory = resolver.getMandatoryDependencies("b")
			expect(mandatory).toHaveLength(1)
			expect(mandatory[0].requiredSkill).toBe("a")
		})
	})

	describe("resolve()", () => {
		it("should resolve a simple chain", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "b needs a" })
			const chain = resolver.resolve(["b"])
			expect(chain.order).toEqual(["a", "b"])
			expect(chain.cycles).toEqual([])
			expect(chain.unresolved).toEqual([])
		})

		it("should resolve a deep chain", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "" })
			resolver.register({ dependentSkill: "c", requiredSkill: "b", optional: false, reason: "" })
			resolver.register({ dependentSkill: "d", requiredSkill: "c", optional: false, reason: "" })
			const chain = resolver.resolve(["d"])
			expect(chain.order).toEqual(["a", "b", "c", "d"])
		})

		it("should detect cycles", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({ dependentSkill: "a", requiredSkill: "c", optional: false, reason: "" })
			resolver.register({ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "" })
			resolver.register({ dependentSkill: "c", requiredSkill: "b", optional: false, reason: "" })
			const chain = resolver.resolve(["a"])
			expect(chain.cycles.length).toBeGreaterThan(0)
		})

		it("should resolve transitive dependencies even when only referenced", () => {
			const resolver = new SkillsDependencyResolver()
			// "missing" is not registered as a dependent but is referenced as a requiredSkill
			resolver.register({ dependentSkill: "b", requiredSkill: "missing", optional: false, reason: "" })
			const chain = resolver.resolve(["b"])
			// skillExists considers any referenced requiredSkill as existing for traversal
			expect(chain.order).toContain("missing")
			expect(chain.order).toContain("b")
		})

		it("should handle optional missing deps gracefully", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({ dependentSkill: "b", requiredSkill: "missing", optional: true, reason: "" })
			const chain = resolver.resolve(["b"])
			expect(chain.unresolved).not.toContain("missing")
		})
	})

	describe("detectCycles()", () => {
		it("should return empty when no cycles", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "" })
			expect(resolver.detectCycles()).toEqual([])
		})

		it("should detect a cycle in the graph", () => {
			const resolver = new SkillsDependencyResolver()
			resolver.register({ dependentSkill: "a", requiredSkill: "b", optional: false, reason: "" })
			resolver.register({ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "" })
			const cycles = resolver.detectCycles()
			expect(cycles.length).toBeGreaterThan(0)
		})
	})
})
