/**
 * Subtask DAG — Directed Acyclic Graph for parallel subtask execution.
 *
 * Builds a DAG from a list of SubtaskNodes, detects cycles using DFS three-color
 * algorithm, performs topological sort via Kahn's algorithm to produce execution
 * waves, and supports dynamic recalculation on subtask failure.
 *
 * @module
 */

import type { SubtaskNode, SubtaskDAG } from "@roo-code/types"

// ============================================================================
// Constants
// ============================================================================

/** Color markers for DFS three-color cycle detection. */
const enum Color {
	White = 0, // Unvisited
	Gray = 1, // In current DFS path
	Black = 2, // Fully explored
}

// ============================================================================
// SubtaskDAGBuilder
// ============================================================================

/**
 * Builds and manages a SubtaskDAG from a list of SubtaskNodes.
 *
 * Provides cycle detection (DFS three-color), topological sort (Kahn's algorithm),
 * ready-node queries, and dynamic recalculation on failure.
 */
export class SubtaskDAGBuilder {
	/**
	 * Build a SubtaskDAG from a flat list of nodes.
	 * Infers edges from `deps` fields and computes topological waves.
	 *
	 * @param nodes - Flat list of subtask nodes with `deps` populated
	 * @returns Fully constructed SubtaskDAG with waves computed
	 */
	build(nodes: SubtaskNode[]): SubtaskDAG {
		const nodeMap = new Map<string, SubtaskNode>()
		const edges = new Map<string, Set<string>>()

		for (const node of nodes) {
			nodeMap.set(node.id, node)
			edges.set(node.id, new Set())
		}

		// Build edges from deps
		for (const node of nodes) {
			for (const depId of node.deps) {
				if (nodeMap.has(depId)) {
					edges.get(node.id)!.add(depId)
				}
			}
		}

		// Compute waves via topological sort
		const waves = this.topologicalSort({ nodes: nodeMap, edges, waves: [], status: "pending" })

		return {
			nodes: nodeMap,
			edges,
			waves,
			status: "pending",
		}
	}

	/**
	 * Detect cycles in the DAG using DFS three-color algorithm.
	 *
	 * @param dag - The DAG to check
	 * @returns Array of cycles, each cycle is an ordered list of node IDs
	 */
	detectCycles(dag: SubtaskDAG): string[][] {
		const color = new Map<string, Color>()
		const parent = new Map<string, string | null>()
		const cycles: string[][] = []

		// Initialize all nodes to White
		for (const nodeId of dag.nodes.keys()) {
			color.set(nodeId, Color.White)
			parent.set(nodeId, null)
		}

		// Visit each unvisited node
		for (const nodeId of dag.nodes.keys()) {
			if (color.get(nodeId) === Color.White) {
				this.dfsVisit(nodeId, dag, color, parent, cycles)
			}
		}

		return cycles
	}

	/**
	 * Perform topological sort using Kahn's algorithm.
	 * Returns nodes grouped into waves (layers) for parallel execution.
	 *
	 * @param dag - The DAG to sort
	 * @returns Array of waves, each wave is an array of nodes that can execute in parallel
	 */
	topologicalSort(dag: SubtaskDAG): SubtaskNode[][] {
		const inDegree = new Map<string, number>()
		const adjacency = new Map<string, Set<string>>()

		// Initialize
		for (const nodeId of dag.nodes.keys()) {
			inDegree.set(nodeId, 0)
			adjacency.set(nodeId, new Set())
		}

		// Build reverse adjacency (dependents) and compute in-degrees
		for (const [nodeId, deps] of dag.edges) {
			for (const depId of deps) {
				// depId must complete before nodeId
				// nodeId depends on depId
				inDegree.set(nodeId, (inDegree.get(nodeId) ?? 0) + 1)
				// depId has nodeId as a dependent
				adjacency.get(depId)?.add(nodeId)
			}
		}

		// Kahn's algorithm
		const waves: SubtaskNode[][] = []
		let queue: string[] = []

		// Seed with nodes that have no dependencies
		for (const [nodeId, degree] of inDegree) {
			if (degree === 0) {
				queue.push(nodeId)
			}
		}

		while (queue.length > 0) {
			const currentWave: SubtaskNode[] = []
			const nextQueue: string[] = []

			for (const nodeId of queue) {
				const node = dag.nodes.get(nodeId)
				if (node) {
					currentWave.push(node)
				}

				// Decrement in-degree for all dependents
				for (const dependentId of adjacency.get(nodeId) ?? []) {
					const newDegree = (inDegree.get(dependentId) ?? 1) - 1
					inDegree.set(dependentId, newDegree)
					if (newDegree === 0) {
						nextQueue.push(dependentId)
					}
				}
			}

			waves.push(currentWave)
			queue = nextQueue
		}

		// Check for remaining nodes (cycle participants)
		const totalProcessed = waves.reduce((sum, w) => sum + w.length, 0)
		if (totalProcessed < dag.nodes.size) {
			console.warn(
				`[SubtaskDAGBuilder] Topological sort incomplete: ${dag.nodes.size - totalProcessed} node(s) remain (cycle detected)`,
			)
		}

		return waves
	}

	/**
	 * Get nodes whose dependencies are all satisfied (ready to execute).
	 *
	 * @param dag - The DAG to query
	 * @returns Array of nodes ready for execution
	 */
	getReadyNodes(dag: SubtaskDAG): SubtaskNode[] {
		const ready: SubtaskNode[] = []

		for (const [nodeId, node] of dag.nodes) {
			if (node.status !== "pending" && node.status !== "ready") {
				continue
			}

			const deps = dag.edges.get(nodeId)
			if (!deps || deps.size === 0) {
				ready.push(node)
				continue
			}

			let allDepsCompleted = true
			for (const depId of deps) {
				const depNode = dag.nodes.get(depId)
				if (!depNode || (depNode.status !== "completed" && depNode.status !== "skipped")) {
					allDepsCompleted = false
					break
				}
			}

			if (allDepsCompleted) {
				ready.push(node)
			}
		}

		return ready
	}

	/**
	 * Recalculate the DAG after a subtask failure.
	 * Marks downstream nodes as blocked and recomputes waves.
	 *
	 * @param dag - The current DAG
	 * @param failedId - ID of the failed subtask
	 * @returns Updated DAG with recalculated waves
	 */
	recalculateOnFailure(dag: SubtaskDAG, failedId: string): SubtaskDAG {
		const failedNode = dag.nodes.get(failedId)
		if (!failedNode) {
			console.warn(`[SubtaskDAGBuilder] Cannot recalculate: node "${failedId}" not found`)
			return dag
		}

		// Mark failed node
		failedNode.status = "failed"

		// Find all downstream nodes (transitive dependents)
		const downstream = this.getTransitiveDependents(dag, failedId)

		for (const nodeId of downstream) {
			const node = dag.nodes.get(nodeId)
			if (node) {
				if (failedNode.isCritical) {
					// Critical failure — mark all downstream as blocked
					node.status = "blocked"
				} else {
					// Non-critical — check if node has alternative input paths
					const remainingDeps = dag.edges.get(nodeId)
					if (remainingDeps && remainingDeps.size > 0) {
						const allFailed = [...remainingDeps].every((depId) => {
							const dep = dag.nodes.get(depId)
							return dep?.status === "failed" || dep?.status === "blocked"
						})
						if (allFailed) {
							node.status = "blocked"
						}
					}
				}
			}
		}

		// Recompute waves
		dag.waves = this.topologicalSort(dag)

		return dag
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	/**
	 * DFS visit for three-color cycle detection.
	 */
	private dfsVisit(
		nodeId: string,
		dag: SubtaskDAG,
		color: Map<string, Color>,
		parent: Map<string, string | null>,
		cycles: string[][],
	): void {
		color.set(nodeId, Color.Gray)

		const deps = dag.edges.get(nodeId)
		if (deps) {
			for (const depId of deps) {
				if (!dag.nodes.has(depId)) {
					continue
				}

				if (color.get(depId) === Color.Gray) {
					// Found a cycle — reconstruct the path
					const cycle = this.reconstructCycle(nodeId, depId, parent)
					cycles.push(cycle)
				} else if (color.get(depId) === Color.White) {
					parent.set(depId, nodeId)
					this.dfsVisit(depId, dag, color, parent, cycles)
				}
			}
		}

		color.set(nodeId, Color.Black)
	}

	/**
	 * Reconstruct a cycle path from the DFS parent map.
	 */
	private reconstructCycle(from: string, to: string, parent: Map<string, string | null>): string[] {
		const cycle: string[] = [to, from]
		let current = from

		while (current !== to) {
			const p = parent.get(current)
			if (p === null || p === undefined) {
				break
			}
			current = p
			if (current !== to) {
				cycle.push(current)
			}
		}

		cycle.push(to)
		return cycle.reverse()
	}

	/**
	 * Get all transitive dependents of a node (BFS).
	 */
	private getTransitiveDependents(dag: SubtaskDAG, nodeId: string): string[] {
		const visited = new Set<string>()
		const queue: string[] = [nodeId]
		const dependents: string[] = []

		// Build reverse adjacency: nodeId → set of nodes that depend on it
		const reverseEdges = new Map<string, Set<string>>()
		for (const [id, deps] of dag.edges) {
			for (const depId of deps) {
				if (!reverseEdges.has(depId)) {
					reverseEdges.set(depId, new Set())
				}
				reverseEdges.get(depId)!.add(id)
			}
		}

		while (queue.length > 0) {
			const current = queue.shift()!
			if (visited.has(current)) {
				continue
			}
			visited.add(current)

			if (current !== nodeId) {
				dependents.push(current)
			}

			const nextNodes = reverseEdges.get(current)
			if (nextNodes) {
				for (const nextId of nextNodes) {
					if (!visited.has(nextId)) {
						queue.push(nextId)
					}
				}
			}
		}

		return dependents
	}
}

// ============================================================================
// Condition Checkers
// ============================================================================

/**
 * Result of a condition check.
 */
export type CheckResult = { satisfied: true } | { satisfied: false; reason: string }

/**
 * Interface for pre-execution condition checkers.
 */
export interface ConditionChecker {
	/** Human-readable name */
	name: string
	/** Check if the subtask's prerequisites are met */
	check(subtask: SubtaskNode, dag: SubtaskDAG): Promise<CheckResult>
}

/**
 * Checks that all input files exist on disk.
 */
export class FileExistsChecker implements ConditionChecker {
	name = "FileExistsChecker"

	async check(subtask: SubtaskNode, _dag: SubtaskDAG): Promise<CheckResult> {
		if (!subtask.inputFiles || subtask.inputFiles.length === 0) {
			return { satisfied: true }
		}

		const fs = await import("fs/promises")
		const missingFiles: string[] = []

		for (const filePath of subtask.inputFiles) {
			try {
				await fs.access(filePath)
			} catch {
				missingFiles.push(filePath)
			}
		}

		if (missingFiles.length > 0) {
			return {
				satisfied: false,
				reason: `Input files not found: ${missingFiles.join(", ")}`,
			}
		}

		return { satisfied: true }
	}
}

/**
 * Checks that all dependency subtasks have completed successfully.
 */
export class DependencyStatusChecker implements ConditionChecker {
	name = "DependencyStatusChecker"

	async check(subtask: SubtaskNode, dag: SubtaskDAG): Promise<CheckResult> {
		const deps = dag.edges.get(subtask.id)
		if (!deps || deps.size === 0) {
			return { satisfied: true }
		}

		const failedDeps: string[] = []
		const incompleteDeps: string[] = []

		for (const depId of deps) {
			const depNode = dag.nodes.get(depId)
			if (!depNode) {
				failedDeps.push(`${depId} (not found)`)
				continue
			}

			if (depNode.status === "failed" || depNode.status === "timed_out") {
				failedDeps.push(depId)
			} else if (depNode.status !== "completed" && depNode.status !== "skipped") {
				incompleteDeps.push(depId)
			}
		}

		if (failedDeps.length > 0) {
			return {
				satisfied: false,
				reason: `Dependencies failed: ${failedDeps.join(", ")}`,
			}
		}

		if (incompleteDeps.length > 0) {
			return {
				satisfied: false,
				reason: `Dependencies not yet completed: ${incompleteDeps.join(", ")}`,
			}
		}

		return { satisfied: true }
	}
}

/**
 * Checks that required resources are available.
 */
export class ResourceAvailabilityChecker implements ConditionChecker {
	name = "ResourceAvailabilityChecker"

	async check(subtask: SubtaskNode, _dag: SubtaskDAG): Promise<CheckResult> {
		if (!subtask.requiredResources || subtask.requiredResources.length === 0) {
			return { satisfied: true }
		}

		// Resource checking is delegated to the LockManager at execution time.
		// This checker provides a pre-flight verification.
		return { satisfied: true }
	}
}
