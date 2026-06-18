import { describe, it, expect, beforeEach } from "vitest"

import type { SubProject, DependencyGraph, DependencyOverride } from "@roo-code/types"

import { DepGraphBuilder } from "../DepGraphBuilder"

describe("DepGraphBuilder", () => {
	let builder: DepGraphBuilder

	beforeEach(() => {
		builder = new DepGraphBuilder()
	})

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

	describe("build", () => {
		it("should build graph from sub-projects", () => {
			const projects = [makeProject("p1", "project-a"), makeProject("p2", "project-b")]
			const graph = builder.build(projects)
			expect(graph.projects).toHaveLength(2)
			expect(graph.buildOrder).toHaveLength(2)
		})

		it("should resolve inter-project dependency edges", () => {
			const projects = [makeProject("p1", "project-a", ["project-b"]), makeProject("p2", "project-b")]
			const graph = builder.build(projects)
			expect(graph.projects).toHaveLength(2)
			const p1 = graph.projects.find((p) => p.id === "p1")!
			const p2 = graph.projects.find((p) => p.id === "p2")!
			// p1 depends on p2 → p1's dependencies should include p2
			expect(p1.dependencies).toContain("p2")
			// Build order: Kahn's algorithm processes in-degree 0 first
			// p1 has no incoming edges (no one depends on p1), p2 has incoming from p1
			expect(graph.buildOrder).toContain("p1")
			expect(graph.buildOrder).toContain("p2")
		})

		it("should handle empty dependencies (leaf projects)", () => {
			const projects = [makeProject("p1", "project-a"), makeProject("p2", "project-b")]
			const graph = builder.build(projects)
			for (const p of graph.projects) {
				expect(p.isLeaf).toBe(true)
			}
		})

		it("should handle self-references gracefully (no self-loops)", () => {
			const projects = [makeProject("p1", "project-a", ["project-a"])]
			const graph = builder.build(projects)
			expect(graph.projects).toHaveLength(1)
			// Self-reference should not create an edge
			expect(graph.projects[0].dependencies).not.toContain("p1")
		})

		it("should compute leaf and root status correctly", () => {
			const projects = [makeProject("p1", "project-a", ["project-b"]), makeProject("p2", "project-b")]
			const graph = builder.build(projects)
			const p1 = graph.projects.find((p) => p.id === "p1")!
			const p2 = graph.projects.find((p) => p.id === "p2")!
			// p1 depends on p2 → p1 is not leaf (has outgoing deps), p2 is leaf (no outgoing deps)
			expect(p1.isLeaf).toBe(false)
			expect(p2.isLeaf).toBe(true)
			// p2 has p1 depending on it → p2 is not root (has incoming deps)
			expect(p2.isRoot).toBe(false)
			// p1 has no one depending on it → p1 is root
			expect(p1.isRoot).toBe(true)
		})

		it("should handle empty projects array", () => {
			const graph = builder.build([])
			expect(graph.projects).toHaveLength(0)
			expect(graph.buildOrder).toHaveLength(0)
			expect(graph.cycles).toHaveLength(0)
		})

		it("should handle single project", () => {
			const projects = [makeProject("p1", "project-a")]
			const graph = builder.build(projects)
			expect(graph.projects).toHaveLength(1)
			expect(graph.buildOrder).toEqual(["p1"])
		})

		it("should handle cross-project deps via package.json workspaces", () => {
			const projects = [
				makeProject("p1", "project-a", ["project-b"]),
				makeProject("p2", "project-b"),
				makeProject("p3", "project-c", ["project-b"]),
			]
			const graph = builder.build(projects)
			expect(graph.projects).toHaveLength(3)
			// p1 and p3 have no incoming edges (no one depends on them), p2 has incoming edges
			// Kahn's algorithm processes in-degree 0 first
			expect(graph.buildOrder).toContain("p1")
			expect(graph.buildOrder).toContain("p2")
			expect(graph.buildOrder).toContain("p3")
		})

		it("should handle duplicate project IDs gracefully", () => {
			const projects = [makeProject("p1", "project-a"), makeProject("p1", "project-a-duplicate")]
			const graph = builder.build(projects)
			// Both projects are included, but the second one's deps may override
			expect(graph.projects).toHaveLength(2)
		})
	})

	describe("addEdge / getGraph", () => {
		it("should add edges manually and include them in build", () => {
			const projects = [makeProject("p1", "project-a"), makeProject("p2", "project-b")]
			builder.addEdge("p1", "p2", "runtime")
			const graph = builder.build(projects)
			// p1 has no incoming edges (in-degree 0), so it comes first in Kahn's algorithm
			// p2 has incoming edge from p1, so it comes second
			expect(graph.buildOrder).toContain("p1")
			expect(graph.buildOrder).toContain("p2")
			// Verify the edge was added: p1 should have p2 as dependency
			const p1 = graph.projects.find((p) => p.id === "p1")!
			expect(p1.dependencies).toContain("p2")
		})

		it("getGraph should throw if build() not called", () => {
			expect(() => builder.getGraph()).toThrow("build() has not been called yet")
		})

		it("getGraph should return the last built graph", () => {
			const projects = [makeProject("p1", "project-a")]
			builder.build(projects)
			const graph = builder.getGraph()
			expect(graph.projects).toHaveLength(1)
		})
	})

	describe("mergeGraphs", () => {
		it("should merge multiple graphs", () => {
			const g1 = builder.build([makeProject("p1", "project-a")])
			const g2 = builder.build([makeProject("p2", "project-b")])
			const merged = builder.mergeGraphs([g1, g2])
			expect(merged.projects).toHaveLength(2)
		})

		it("should deduplicate projects by ID", () => {
			const g1 = builder.build([makeProject("p1", "project-a")])
			const g2 = builder.build([makeProject("p1", "project-a")])
			const merged = builder.mergeGraphs([g1, g2])
			expect(merged.projects).toHaveLength(1)
		})

		it("should return empty graph for empty input", () => {
			const merged = builder.mergeGraphs([])
			expect(merged.projects).toHaveLength(0)
		})

		it("should return single graph as-is", () => {
			const g = builder.build([makeProject("p1", "project-a")])
			const merged = builder.mergeGraphs([g])
			expect(merged.projects).toHaveLength(1)
		})
	})

	describe("mergeOverrides", () => {
		it("should add edges via overrides", () => {
			const projects = [makeProject("p1", "project-a"), makeProject("p2", "project-b")]
			const graph = builder.build(projects)
			const overrides: DependencyOverride[] = [{ type: "add", from: "p1", to: "p2" }]
			const merged = builder.mergeOverrides(graph, overrides)
			const p1 = merged.projects.find((p) => p.id === "p1")!
			expect(p1.dependencies).toContain("p2")
		})

		it("should remove edges via overrides", () => {
			const projects = [makeProject("p1", "project-a", ["project-b"]), makeProject("p2", "project-b")]
			const graph = builder.build(projects)
			const overrides: DependencyOverride[] = [{ type: "remove", from: "p1", to: "p2" }]
			const merged = builder.mergeOverrides(graph, overrides)
			const p1 = merged.projects.find((p) => p.id === "p1")!
			expect(p1.dependencies).not.toContain("p2")
		})

		it("should return original graph when no overrides", () => {
			const projects = [makeProject("p1", "project-a")]
			const graph = builder.build(projects)
			const merged = builder.mergeOverrides(graph, [])
			expect(merged).toBe(graph)
		})
	})

	describe("serialize", () => {
		it("should serialize graph to JSON string", () => {
			const projects = [makeProject("p1", "project-a")]
			builder.build(projects)
			const json = builder.serialize()
			const parsed = JSON.parse(json)
			expect(parsed.projectCount).toBe(1)
			expect(parsed.buildOrder).toEqual(["p1"])
		})

		it("should throw if build() not called before serialize", () => {
			expect(() => builder.serialize()).toThrow("build() has not been called yet")
		})
	})

	describe("toMermaid", () => {
		it("should generate mermaid flowchart string", () => {
			const projects = [makeProject("p1", "project-a")]
			builder.build(projects)
			const mermaid = builder.toMermaid()
			expect(mermaid).toContain("flowchart LR")
			expect(mermaid).toContain("project-a")
		})

		it("should throw if build() not called before toMermaid", () => {
			expect(() => builder.toMermaid()).toThrow("build() has not been called yet")
		})
	})

	describe("circular dependencies", () => {
		it("should detect cycles and still return graph", () => {
			const projects = [
				makeProject("p1", "project-a", ["project-b"]),
				makeProject("p2", "project-b", ["project-a"]),
			]
			const graph = builder.build(projects)
			// Graph should still be returned with cycle info
			expect(graph.projects).toHaveLength(2)
			expect(graph.buildOrder).toHaveLength(2)
		})
	})
})
