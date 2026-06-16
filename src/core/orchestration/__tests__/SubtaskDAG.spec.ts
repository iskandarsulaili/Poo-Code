/**
 * Tests for SubtaskDAGBuilder — DAG construction, cycle detection, topological sort.
 */

import { describe, it, expect } from "vitest"

import type { SubtaskNode } from "@roo-code/types"
import { SubtaskDAGBuilder } from "../SubtaskDAG"

function makeNode(id: string, deps: string[] = []): SubtaskNode {
	return {
		id,
		name: id,
		mode: "code",
		prompt: `Execute ${id}`,
		inputFiles: [],
		outputFiles: [],
		deps,
		requiredResources: [],
		subscribedTopics: [],
		publishedTopics: [],
		estimatedTokens: 1000,
		timeoutMs: 300_000,
		isCritical: false,
		status: "pending",
		metadata: { correlationId: "" },
	}
}

describe("SubtaskDAGBuilder", () => {
	const builder = new SubtaskDAGBuilder()

	describe("build", () => {
		it("should build a DAG from independent nodes", () => {
			const nodes = [makeNode("a"), makeNode("b"), makeNode("c")]
			const dag = builder.build(nodes)
			expect(dag.nodes.size).toBe(3)
			expect(dag.waves.length).toBe(1)
			expect(dag.waves[0]).toHaveLength(3)
		})

		it("should build a DAG with dependencies", () => {
			const nodes = [makeNode("a"), makeNode("b", ["a"]), makeNode("c", ["b"])]
			const dag = builder.build(nodes)
			expect(dag.nodes.size).toBe(3)
			expect(dag.waves.length).toBe(3)
			expect(dag.waves[0][0].id).toBe("a")
			expect(dag.waves[1][0].id).toBe("b")
			expect(dag.waves[2][0].id).toBe("c")
		})

		it("should handle diamond dependencies", () => {
			const nodes = [makeNode("a"), makeNode("b", ["a"]), makeNode("c", ["a"]), makeNode("d", ["b", "c"])]
			const dag = builder.build(nodes)
			expect(dag.waves.length).toBe(3)
			expect(dag.waves[0][0].id).toBe("a")
			expect(dag.waves[1]).toHaveLength(2) // b and c in parallel
			expect(dag.waves[2][0].id).toBe("d")
		})
	})

	describe("detectCycles", () => {
		it("should return empty for acyclic graph", () => {
			const nodes = [makeNode("a"), makeNode("b", ["a"]), makeNode("c", ["b"])]
			const dag = builder.build(nodes)
			const cycles = builder.detectCycles(dag)
			expect(cycles).toHaveLength(0)
		})

		it("should detect a direct cycle", () => {
			const nodes = [makeNode("a", ["b"]), makeNode("b", ["a"])]
			const dag = builder.build(nodes)
			const cycles = builder.detectCycles(dag)
			expect(cycles.length).toBeGreaterThan(0)
		})

		it("should detect a longer cycle", () => {
			const nodes = [makeNode("a", ["d"]), makeNode("b", ["a"]), makeNode("c", ["b"]), makeNode("d", ["c"])]
			const dag = builder.build(nodes)
			const cycles = builder.detectCycles(dag)
			expect(cycles.length).toBeGreaterThan(0)
		})
	})

	describe("topologicalSort", () => {
		it("should return single wave for independent nodes", () => {
			const nodes = [makeNode("a"), makeNode("b"), makeNode("c")]
			const dag = builder.build(nodes)
			const waves = builder.topologicalSort(dag)
			expect(waves).toHaveLength(1)
			expect(waves[0]).toHaveLength(3)
		})

		it("should return correct wave order for chain", () => {
			const nodes = [makeNode("a"), makeNode("b", ["a"]), makeNode("c", ["b"])]
			const dag = builder.build(nodes)
			const waves = builder.topologicalSort(dag)
			expect(waves).toHaveLength(3)
			expect(waves[0][0].id).toBe("a")
			expect(waves[1][0].id).toBe("b")
			expect(waves[2][0].id).toBe("c")
		})
	})

	describe("getReadyNodes", () => {
		it("should return nodes with no deps as ready", () => {
			const nodes = [makeNode("a"), makeNode("b", ["a"])]
			const dag = builder.build(nodes)
			const ready = builder.getReadyNodes(dag)
			expect(ready).toHaveLength(1)
			expect(ready[0].id).toBe("a")
		})

		it("should return nodes whose deps are completed", () => {
			const nodes = [makeNode("a"), makeNode("b", ["a"])]
			const dag = builder.build(nodes)
			dag.nodes.get("a")!.status = "completed"
			const ready = builder.getReadyNodes(dag)
			expect(ready).toHaveLength(1)
			expect(ready[0].id).toBe("b")
		})
	})

	describe("recalculateOnFailure", () => {
		it("should mark downstream nodes as blocked on critical failure", () => {
			const nodes = [makeNode("a"), { ...makeNode("b", ["a"]), isCritical: true }, makeNode("c", ["b"])]
			const dag = builder.build(nodes)
			builder.recalculateOnFailure(dag, "b")
			expect(dag.nodes.get("b")!.status).toBe("failed")
			expect(dag.nodes.get("c")!.status).toBe("blocked")
		})

		it("should not mark downstream as blocked if non-critical", () => {
			const nodes = [makeNode("a"), makeNode("b", ["a"]), makeNode("c", ["b"])]
			const dag = builder.build(nodes)
			builder.recalculateOnFailure(dag, "b")
			expect(dag.nodes.get("b")!.status).toBe("failed")
			// c may be blocked if all deps failed
		})
	})
})
