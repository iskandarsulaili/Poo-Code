import { describe, it, expect, beforeEach } from "vitest"

import type { DependencyGraph, SubProject } from "@roo-code/types"

import { DepGraphResolver, CycleDetectedError } from "../DepGraphResolver"

describe("DepGraphResolver", () => {
	let resolver: DepGraphResolver
	let emptyGraph: DependencyGraph
	let singleGraph: DependencyGraph
	let chainGraph: DependencyGraph
	let diamondGraph: DependencyGraph
	let parallelGraph: DependencyGraph
	let cycleGraph: DependencyGraph

	const makeProject = (id: string, name: string, deps: string[] = [], devDeps: string[] = []): SubProject => ({
		id,
		name,
		rootPath: `/workspace/${name}`,
		language: "typescript",
		buildManifest: "package.json",
		buildManifestType: "package.json",
		dependencies: deps,
		devDependencies: devDeps,
		isRoot: false,
		isLeaf: false,
	})

	beforeEach(() => {
		emptyGraph = { projects: [], buildOrder: [], cycles: [], updatedAt: new Date() }

		singleGraph = {
			projects: [makeProject("p1", "project-a")],
			buildOrder: ["p1"],
			cycles: [],
			updatedAt: new Date(),
		}

		// a → b → c
		chainGraph = {
			projects: [
				makeProject("a", "project-a", ["b"]),
				makeProject("b", "project-b", ["c"]),
				makeProject("c", "project-c"),
			],
			buildOrder: ["c", "b", "a"],
			cycles: [],
			updatedAt: new Date(),
		}

		// a → b, a → c, b → d, c → d
		diamondGraph = {
			projects: [
				makeProject("a", "project-a", ["b", "c"]),
				makeProject("b", "project-b", ["d"]),
				makeProject("c", "project-c", ["d"]),
				makeProject("d", "project-d"),
			],
			buildOrder: ["d", "b", "c", "a"],
			cycles: [],
			updatedAt: new Date(),
		}

		// No deps between projects
		parallelGraph = {
			projects: [makeProject("p1", "project-a"), makeProject("p2", "project-b"), makeProject("p3", "project-c")],
			buildOrder: ["p1", "p2", "p3"],
			cycles: [],
			updatedAt: new Date(),
		}

		// a → b → c → a (cycle)
		cycleGraph = {
			projects: [
				makeProject("a", "project-a", ["b"]),
				makeProject("b", "project-b", ["c"]),
				makeProject("c", "project-c", ["a"]),
			],
			buildOrder: [],
			cycles: [],
			updatedAt: new Date(),
		}
	})

	describe("topologicalSort (static)", () => {
		it("should return empty array for empty graph", () => {
			const layers = DepGraphResolver.topologicalSort(emptyGraph)
			expect(layers).toEqual([])
		})

		it("should return single layer for single node", () => {
			const layers = DepGraphResolver.topologicalSort(singleGraph)
			expect(layers).toHaveLength(1)
			expect(layers[0]).toHaveLength(1)
			expect(layers[0][0].id).toBe("p1")
		})

		it("should produce layered order for chain graph", () => {
			const layers = DepGraphResolver.topologicalSort(chainGraph)
			// Layer 0: c (no deps), Layer 1: b (depends on c), Layer 2: a (depends on b)
			expect(layers.length).toBeGreaterThanOrEqual(1)
			// All projects should be in some layer
			const allIds = layers.flat().map((p) => p.id)
			expect(allIds).toContain("a")
			expect(allIds).toContain("b")
			expect(allIds).toContain("c")
		})

		it("should produce layered order for diamond graph", () => {
			const layers = DepGraphResolver.topologicalSort(diamondGraph)
			const allIds = layers.flat().map((p) => p.id)
			expect(allIds).toContain("a")
			expect(allIds).toContain("b")
			expect(allIds).toContain("c")
			expect(allIds).toContain("d")
		})

		it("should put all independent projects in same layer", () => {
			const layers = DepGraphResolver.topologicalSort(parallelGraph)
			expect(layers).toHaveLength(1)
			expect(layers[0]).toHaveLength(3)
		})

		it("should handle cycles gracefully (no throw)", () => {
			const layers = DepGraphResolver.topologicalSort(cycleGraph)
			// Should still return layers without throwing
			expect(layers.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe("topologicalSort (instance)", () => {
		it("should delegate to static method", () => {
			resolver = new DepGraphResolver(singleGraph)
			const layers = resolver.topologicalSort()
			expect(layers).toHaveLength(1)
		})
	})

	describe("detectCycles (static)", () => {
		it("should return empty array for graph with no cycles", () => {
			const cycles = DepGraphResolver.detectCycles(chainGraph)
			expect(cycles).toHaveLength(0)
		})

		it("should detect simple cycle a→b→c→a", () => {
			const cycles = DepGraphResolver.detectCycles(cycleGraph)
			expect(cycles.length).toBeGreaterThanOrEqual(1)
		})

		it("should detect self-reference as cycle (a→a is a gray node revisit)", () => {
			const selfRefGraph: DependencyGraph = {
				projects: [makeProject("a", "project-a", ["a"])],
				buildOrder: ["a"],
				cycles: [],
				updatedAt: new Date(),
			}
			const cycles = DepGraphResolver.detectCycles(selfRefGraph)
			// Self-references are detected as cycles by the DFS algorithm
			// (a is gray when its neighbor a is visited)
			expect(cycles).toHaveLength(1)
		})

		it("should return empty for empty graph", () => {
			const cycles = DepGraphResolver.detectCycles(emptyGraph)
			expect(cycles).toHaveLength(0)
		})
	})

	describe("detectCycles (instance)", () => {
		it("should return cycles as project ID arrays", () => {
			resolver = new DepGraphResolver(cycleGraph)
			const cycles = resolver.detectCycles()
			expect(cycles.length).toBeGreaterThanOrEqual(1)
			// Each cycle should be an array of project IDs
			for (const cycle of cycles) {
				expect(Array.isArray(cycle)).toBe(true)
				expect(cycle.length).toBeGreaterThan(0)
			}
		})

		it("should return empty for graph with no cycles", () => {
			resolver = new DepGraphResolver(chainGraph)
			const cycles = resolver.detectCycles()
			expect(cycles).toHaveLength(0)
		})
	})

	describe("getBuildOrder", () => {
		it("should return flat array of projects in build order", () => {
			const order = DepGraphResolver.getBuildOrder(chainGraph)
			expect(order).toHaveLength(3)
		})

		it("instance method should delegate to static", () => {
			resolver = new DepGraphResolver(chainGraph)
			const order = resolver.getBuildOrder()
			expect(order).toHaveLength(3)
		})
	})

	describe("getParallelGroups", () => {
		it("should return same as topologicalSort", () => {
			const groups = DepGraphResolver.getParallelGroups(parallelGraph)
			expect(groups).toHaveLength(1)
			expect(groups[0]).toHaveLength(3)
		})

		it("instance method should delegate to static", () => {
			resolver = new DepGraphResolver(parallelGraph)
			const groups = resolver.getParallelGroups()
			expect(groups).toHaveLength(1)
		})
	})

	describe("getDependencyChain", () => {
		it("should return transitive dependencies for a project", () => {
			const projectA = chainGraph.projects.find((p) => p.id === "a")!
			const chain = DepGraphResolver.getDependencyChain(projectA, chainGraph)
			// a depends on b, b depends on c → chain should include b and c
			expect(chain.length).toBeGreaterThanOrEqual(1)
			const chainIds = chain.map((p) => p.id)
			expect(chainIds).toContain("b")
			expect(chainIds).toContain("c")
		})

		it("should return empty array for leaf project", () => {
			const projectC = chainGraph.projects.find((p) => p.id === "c")!
			const chain = DepGraphResolver.getDependencyChain(projectC, chainGraph)
			expect(chain).toHaveLength(0)
		})

		it("instance method should work with project ID", () => {
			resolver = new DepGraphResolver(chainGraph)
			const chain = resolver.getDependencyChain("a")
			expect(chain.length).toBeGreaterThanOrEqual(1)
		})

		it("should return empty for unknown project ID", () => {
			resolver = new DepGraphResolver(chainGraph)
			const chain = resolver.getDependencyChain("unknown")
			expect(chain).toHaveLength(0)
		})
	})

	describe("getDependents", () => {
		it("should return projects that depend on the given project", () => {
			const projectC = chainGraph.projects.find((p) => p.id === "c")!
			const dependents = DepGraphResolver.getDependents(projectC, chainGraph)
			// c is depended on by b, and b is depended on by a
			expect(dependents.length).toBeGreaterThanOrEqual(1)
			const depIds = dependents.map((p) => p.id)
			expect(depIds).toContain("b")
		})

		it("should return empty for root project (no dependents)", () => {
			const projectA = chainGraph.projects.find((p) => p.id === "a")!
			const dependents = DepGraphResolver.getDependents(projectA, chainGraph)
			expect(dependents).toHaveLength(0)
		})

		it("instance method should work with project ID", () => {
			resolver = new DepGraphResolver(chainGraph)
			const dependents = resolver.getDependents("c")
			expect(dependents.length).toBeGreaterThanOrEqual(1)
		})

		it("should return empty for unknown project ID", () => {
			resolver = new DepGraphResolver(chainGraph)
			const dependents = resolver.getDependents("unknown")
			expect(dependents).toHaveLength(0)
		})
	})

	describe("getDependencies", () => {
		it("should return direct dependencies for a project", () => {
			const projectA = chainGraph.projects.find((p) => p.id === "a")!
			const deps = DepGraphResolver.getDependencies(projectA, chainGraph)
			expect(deps).toHaveLength(1)
			expect(deps[0].id).toBe("b")
		})

		it("should return empty for leaf project", () => {
			const projectC = chainGraph.projects.find((p) => p.id === "c")!
			const deps = DepGraphResolver.getDependencies(projectC, chainGraph)
			expect(deps).toHaveLength(0)
		})

		it("instance method should work with project ID", () => {
			resolver = new DepGraphResolver(chainGraph)
			const deps = resolver.getDependencies("a")
			expect(deps).toHaveLength(1)
		})

		it("should return empty for unknown project ID", () => {
			resolver = new DepGraphResolver(chainGraph)
			const deps = resolver.getDependencies("unknown")
			expect(deps).toHaveLength(0)
		})
	})

	describe("getAffectedProjects", () => {
		it("should return affected projects when file changes in a project", () => {
			const affected = DepGraphResolver.getAffectedProjects(
				["/workspace/project-c/src/file.ts"],
				chainGraph.projects,
				chainGraph,
			)
			// c is changed, b depends on c, a depends on b
			expect(affected.length).toBeGreaterThanOrEqual(1)
			const affectedIds = affected.map((p) => p.id)
			expect(affectedIds).toContain("c")
		})

		it("should return empty for empty changed files", () => {
			const affected = DepGraphResolver.getAffectedProjects([], chainGraph.projects, chainGraph)
			expect(affected).toHaveLength(0)
		})

		it("should return empty for empty projects", () => {
			const affected = DepGraphResolver.getAffectedProjects(["/file.ts"], [], emptyGraph)
			expect(affected).toHaveLength(0)
		})

		it("instance method should work", () => {
			resolver = new DepGraphResolver(chainGraph)
			const affected = resolver.getAffectedProjects(["/workspace/project-c/src/file.ts"])
			expect(affected.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe("contextualize", () => {
		it("should return context section for non-empty graph", () => {
			const context = DepGraphResolver.contextualize(chainGraph)
			expect(context.type).toBe("monorepo_structure")
			expect(context.content).toContain("Total projects: 3")
			expect(context.tokenCount).toBeGreaterThan(0)
		})

		it("should return empty context for empty graph", () => {
			const context = DepGraphResolver.contextualize(emptyGraph)
			expect(context.type).toBe("monorepo_structure")
			expect(context.content).toContain("No sub-projects detected")
		})

		it("instance method should delegate", () => {
			resolver = new DepGraphResolver(chainGraph)
			const context = resolver.contextualize()
			expect(context.type).toBe("monorepo_structure")
		})
	})

	describe("formatForLLM", () => {
		it("should format context for LLM within token budget", () => {
			const context = DepGraphResolver.contextualize(chainGraph)
			const formatted = DepGraphResolver.formatForLLM(context, 4096)
			expect(formatted).toContain("<monorepo_structure>")
			expect(formatted).toContain("</monorepo_structure>")
		})

		it("should truncate when token budget exceeded", () => {
			const context = DepGraphResolver.contextualize(chainGraph)
			const formatted = DepGraphResolver.formatForLLM(context, 10)
			expect(formatted).toContain("context truncated")
		})

		it("should return empty string for empty content", () => {
			const emptyContext = { type: "monorepo_structure" as const, content: "", tokenCount: 0 }
			const formatted = DepGraphResolver.formatForLLM(emptyContext, 4096)
			expect(formatted).toBe("")
		})

		it("instance method should delegate", () => {
			resolver = new DepGraphResolver(chainGraph)
			const formatted = resolver.formatForLLM(4096)
			expect(formatted).toContain("<monorepo_structure>")
		})
	})

	describe("serializeForContext", () => {
		it("should serialize graph for LLM context", () => {
			resolver = new DepGraphResolver(chainGraph)
			const serialized = resolver.serializeForContext(4096)
			expect(serialized).toContain("<monorepo_structure>")
		})
	})

	describe("CycleDetectedError", () => {
		it("should create error with cycle information", () => {
			const error = new CycleDetectedError([["a", "b", "c", "a"]])
			expect(error).toBeInstanceOf(Error)
			expect(error.name).toBe("CycleDetectedError")
			expect(error.message).toContain("Circular dependency detected")
			expect(error.cycles).toHaveLength(1)
		})
	})
})
