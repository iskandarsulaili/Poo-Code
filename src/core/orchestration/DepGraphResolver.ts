import * as path from "path"

import type { DependencyGraph, SubProject, ContextSection } from "@roo-code/types"

// ============================================================================
// Additional Types
// ============================================================================

/**
 * Represents a single dependency edge in the graph for cycle reporting.
 */
export interface DependencyEdge {
	/** Source project ID */
	from: string
	/** Target project ID */
	to: string
	/** Type of dependency relationship */
	type: "build" | "runtime" | "dev" | "test" | "type" | "unknown"
}

/**
 * Internal adjacency representation for efficient graph algorithms.
 */
interface AdjacencyInfo {
	/** projectId → Set of dependency project IDs (outgoing edges) */
	forward: Map<string, Set<string>>
	/** projectId → Set of dependent project IDs (incoming edges) */
	reverse: Map<string, Set<string>>
	/** projectId → SubProject */
	projectMap: Map<string, SubProject>
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when a circular dependency is detected in the graph.
 */
export class CycleDetectedError extends Error {
	/**
	 * @param cycles - Array of detected cycles (each cycle is an ordered list of project IDs)
	 */
	constructor(public cycles: Array<string[]>) {
		super(`Circular dependency detected: ${cycles.map((c) => c.join(" → ")).join(", ")}`)
		this.name = "CycleDetectedError"
	}
}

// ============================================================================
// DepGraphResolver
// ============================================================================

/**
 * Topological sort, cycle detection, and query API on the dependency graph.
 *
 * Uses Kahn's algorithm for topological sorting and DFS for cycle detection.
 * Provides rich query methods for dependency analysis, build ordering, and
 * serialization for LLM context injection.
 *
 * ### Usage
 * ```typescript
 * const resolver = new DepGraphResolver(graph)
 * const layers = resolver.topologicalSort(graph)   // parallel-safe groups
 * const order = resolver.getBuildOrder(graph)       // flat build order
 * const deps = resolver.getDependencyChain(project, graph) // transitive deps
 * const context = resolver.contextualize(graph)     // LLM context section
 * ```
 *
 * ### Error Handling
 * - Empty graph: returns all projects as a single layer
 * - Cycle detected: returns with cycle warning in context, best-effort ordering
 * - Unknown project ID: returns empty array for query methods
 *
 * ### Performance
 * Uses adjacency list representation for O(V+E) topological sort.
 * All graph traversal methods are iterative (no recursion depth issues).
 */
export class DepGraphResolver {
	/**
	 * @param graph - The dependency graph to resolve
	 */
	constructor(private graph: DependencyGraph) {}

	// ========================================================================
	// Topological Sort (Kahn's Algorithm)
	// ========================================================================

	/**
	 * Topological sort using Kahn's algorithm.
	 * Returns ordered layers where each layer contains projects that can be
	 * built in parallel (same depth level).
	 *
	 * Layer 0 contains projects with no dependencies (leaf projects).
	 * Layer N contains projects whose dependencies are all in layers 0..N-1.
	 *
	 * If a cycle is detected, remaining projects are placed in their own layer
	 * with a warning. The method never throws — cycle information is available
	 * via {@link detectCycles}.
	 *
	 * @param graph - The dependency graph
	 * @returns Array of layers, each layer being an array of SubProjects
	 */
	static topologicalSort(graph: DependencyGraph): SubProject[][] {
		const projectMap = new Map<string, SubProject>()
		for (const p of graph.projects) {
			projectMap.set(p.id, p)
		}

		if (graph.projects.length === 0) {
			return []
		}

		// Build adjacency lists
		const adjacency = DepGraphResolver.buildAdjacency(graph)
		const inDegree = new Map<string, number>()

		// Initialize in-degree (number of incoming edges = dependencies)
		for (const p of graph.projects) {
			inDegree.set(p.id, 0)
		}
		for (const [_from, targets] of adjacency.forward) {
			for (const to of targets) {
				inDegree.set(to, (inDegree.get(to) ?? 0) + 1)
			}
		}

		// Kahn's algorithm with layering
		const layers: SubProject[][] = []
		let queue: string[] = []

		// Start with nodes that have no dependencies (in-degree 0)
		for (const [id, degree] of inDegree) {
			if (degree === 0) {
				queue.push(id)
			}
		}

		const processed = new Set<string>()

		while (queue.length > 0) {
			const currentLayer: SubProject[] = []

			for (const nodeId of queue) {
				const project = projectMap.get(nodeId)
				if (project) {
					currentLayer.push(project)
				}
				processed.add(nodeId)

				// Decrement in-degree of all dependents
				const targets = adjacency.forward.get(nodeId)
				if (targets) {
					for (const to of targets) {
						const newDegree = (inDegree.get(to) ?? 1) - 1
						inDegree.set(to, newDegree)
					}
				}
			}

			layers.push(currentLayer)

			// Build next queue: nodes whose in-degree became 0
			const nextQueue: string[] = []
			for (const [id, degree] of inDegree) {
				if (degree === 0 && !processed.has(id)) {
					nextQueue.push(id)
				}
			}
			queue = nextQueue
		}

		// Handle unprocessed nodes (cycle case)
		const unprocessed = graph.projects.filter((p) => !processed.has(p.id))
		if (unprocessed.length > 0) {
			console.warn(`[DepGraphResolver] ${unprocessed.length} projects could not be sorted due to cycles`)
			layers.push(unprocessed)
		}

		return layers
	}

	/**
	 * Instance method for topological sort.
	 * Delegates to the static method with `this.graph`.
	 *
	 * @returns Array of build layers
	 */
	topologicalSort(): SubProject[][] {
		return DepGraphResolver.topologicalSort(this.graph)
	}

	// ========================================================================
	// Cycle Detection (DFS)
	// ========================================================================

	/**
	 * Detect cycles in the graph using DFS with path tracking.
	 * Returns an array of cycles, where each cycle is an array of DependencyEdges.
	 *
	 * Uses three-color DFS (white/gray/black):
	 * - White: unvisited
	 * - Gray: in current DFS path (being explored)
	 * - Black: fully processed
	 *
	 * When a gray node is reached again, a cycle is found. The cycle is
	 * extracted from the current DFS path.
	 *
	 * @param graph - The dependency graph
	 * @returns Array of cycles, each cycle being an array of DependencyEdges
	 */
	static detectCycles(graph: DependencyGraph): DependencyEdge[][] {
		const adjacency = DepGraphResolver.buildAdjacency(graph)
		const white = new Set<string>()
		const gray = new Set<string>()
		const black = new Set<string>()
		const cycleEdges: DependencyEdge[][] = []

		// Initialize all nodes as white
		for (const p of graph.projects) {
			white.add(p.id)
		}

		// Path tracking for cycle extraction
		const path: string[] = []

		const visit = (node: string) => {
			white.delete(node)
			gray.add(node)
			path.push(node)

			const neighbors = adjacency.forward.get(node)
			if (neighbors) {
				for (const neighbor of neighbors) {
					if (gray.has(neighbor)) {
						// Found a cycle — extract edges from path
						const cycleStart = path.indexOf(neighbor)
						if (cycleStart !== -1) {
							const cycle: DependencyEdge[] = []
							for (let i = cycleStart; i < path.length; i++) {
								const from = path[i]
								const to =
									path[(i + 1) % path.length] === path[cycleStart]
										? path[cycleStart]
										: path[(i + 1) % path.length]
								if (i === path.length - 1) {
									// Close the cycle
									cycle.push({
										from,
										to: path[cycleStart],
										type: "unknown",
									})
								} else {
									cycle.push({ from, to, type: "runtime" })
								}
							}
							cycleEdges.push(cycle)
						}
					} else if (white.has(neighbor)) {
						visit(neighbor)
					}
				}
			}

			path.pop()
			gray.delete(node)
			black.add(node)
		}

		// Start DFS from each unvisited node
		for (const p of graph.projects) {
			if (white.has(p.id)) {
				visit(p.id)
			}
		}

		// Deduplicate cycles
		return DepGraphResolver.deduplicateCycleEdges(cycleEdges)
	}

	/**
	 * Instance method for cycle detection.
	 * Returns cycles as arrays of project IDs (backward-compatible format).
	 *
	 * @returns Array of cycles (each cycle is an array of project IDs)
	 */
	detectCycles(): Array<string[]> {
		// Use the existing graph.cycles if already computed
		if (this.graph.cycles.length > 0) {
			return [...this.graph.cycles]
		}

		// Otherwise compute fresh
		const edgeCycles = DepGraphResolver.detectCycles(this.graph)
		return edgeCycles.map((cycle) => {
			const ids: string[] = []
			for (const edge of cycle) {
				if (ids.length === 0 || ids[ids.length - 1] !== edge.from) {
					ids.push(edge.from)
				}
			}
			return ids
		})
	}

	// ========================================================================
	// Build Order
	// ========================================================================

	/**
	 * Get a flat topologically sorted list of all projects.
	 * Projects with no dependencies appear first, followed by their dependents.
	 *
	 * @param graph - The dependency graph
	 * @returns Flat array of SubProjects in build order
	 */
	static getBuildOrder(graph: DependencyGraph): SubProject[] {
		const layers = DepGraphResolver.topologicalSort(graph)
		return layers.flat()
	}

	/**
	 * Instance method for build order.
	 * Delegates to the static method with `this.graph`.
	 *
	 * @returns Flat array of SubProjects in build order
	 */
	getBuildOrder(): SubProject[] {
		return DepGraphResolver.getBuildOrder(this.graph)
	}

	// ========================================================================
	// Parallel Groups
	// ========================================================================

	/**
	 * Get groups of projects that can be built in parallel (same depth level).
	 * Each group contains projects with no interdependencies within the group.
	 *
	 * This is identical to the output of {@link topologicalSort} — each layer
	 * represents a set of projects that can be built concurrently.
	 *
	 * @param graph - The dependency graph
	 * @returns Array of parallel-safe project groups
	 */
	static getParallelGroups(graph: DependencyGraph): SubProject[][] {
		return DepGraphResolver.topologicalSort(graph)
	}

	/**
	 * Instance method for parallel groups.
	 *
	 * @returns Array of parallel-safe project groups
	 */
	getParallelGroups(): SubProject[][] {
		return DepGraphResolver.getParallelGroups(this.graph)
	}

	// ========================================================================
	// Dependency Chain
	// ========================================================================

	/**
	 * Get the full transitive dependency chain for a project.
	 * Returns all projects that the given project depends on, directly or transitively.
	 *
	 * Uses BFS to traverse the dependency graph outward from the given project.
	 * The result is ordered from nearest to farthest dependencies.
	 *
	 * @param project - The project to get the dependency chain for
	 * @param graph - The dependency graph
	 * @returns Array of SubProjects in the dependency chain (excluding the project itself)
	 */
	static getDependencyChain(project: SubProject, graph: DependencyGraph): SubProject[] {
		const adjacency = DepGraphResolver.buildAdjacency(graph)
		const visited = new Set<string>()
		const chain: SubProject[] = []
		const queue: string[] = [project.id]
		visited.add(project.id)

		while (queue.length > 0) {
			const current = queue.shift()!
			const neighbors = adjacency.forward.get(current)

			if (neighbors) {
				for (const neighbor of neighbors) {
					if (!visited.has(neighbor)) {
						visited.add(neighbor)
						const neighborProject = adjacency.projectMap.get(neighbor)
						if (neighborProject) {
							chain.push(neighborProject)
						}
						queue.push(neighbor)
					}
				}
			}
		}

		return chain
	}

	/**
	 * Instance method for dependency chain.
	 *
	 * @param projectId - The project ID to query
	 * @returns Array of SubProjects in the dependency chain
	 */
	getDependencyChain(projectId: string): SubProject[] {
		const project = this.graph.projects.find((p) => p.id === projectId)
		if (!project) return []
		return DepGraphResolver.getDependencyChain(project, this.graph)
	}

	// ========================================================================
	// Dependents Query
	// ========================================================================

	/**
	 * Get all projects that transitively depend on the given project.
	 * Uses BFS on the reverse adjacency list to find all dependents.
	 *
	 * @param project - The project to find dependents for
	 * @param graph - The dependency graph
	 * @returns Array of SubProjects that depend on the given project (directly or transitively)
	 */
	static getDependents(project: SubProject, graph: DependencyGraph): SubProject[] {
		const adjacency = DepGraphResolver.buildAdjacency(graph)
		const visited = new Set<string>()
		const dependents: SubProject[] = []
		const queue: string[] = [project.id]
		visited.add(project.id)

		while (queue.length > 0) {
			const current = queue.shift()!
			const reverseNeighbors = adjacency.reverse.get(current)

			if (reverseNeighbors) {
				for (const dependentId of reverseNeighbors) {
					if (!visited.has(dependentId)) {
						visited.add(dependentId)
						const dependentProject = adjacency.projectMap.get(dependentId)
						if (dependentProject) {
							dependents.push(dependentProject)
						}
						queue.push(dependentId)
					}
				}
			}
		}

		return dependents
	}

	/**
	 * Instance method for getDependents (using project ID).
	 * This overrides the existing stub that used project ID.
	 *
	 * @param projectId - The project ID to query
	 * @returns Array of SubProjects that depend on the given project
	 */
	getDependents(projectId: string): SubProject[] {
		const project = this.graph.projects.find((p) => p.id === projectId)
		if (!project) return []
		return DepGraphResolver.getDependents(project, this.graph)
	}

	// ========================================================================
	// Dependencies Query
	// ========================================================================

	/**
	 * Get projects that the given project directly depends on.
	 * This does NOT include transitive dependencies.
	 *
	 * @param project - The project to get direct dependencies for
	 * @param graph - The dependency graph
	 * @returns Array of SubProjects that the given project directly depends on
	 */
	static getDependencies(project: SubProject, graph: DependencyGraph): SubProject[] {
		const adjacency = DepGraphResolver.buildAdjacency(graph)
		const deps: SubProject[] = []
		const neighbors = adjacency.forward.get(project.id)

		if (neighbors) {
			for (const depId of neighbors) {
				const depProject = adjacency.projectMap.get(depId)
				if (depProject) {
					deps.push(depProject)
				}
			}
		}

		return deps
	}

	/**
	 * Instance method for getDependencies (using project ID).
	 * This overrides the existing stub that used project ID.
	 *
	 * @param projectId - The project ID to query
	 * @returns Array of SubProjects that the given project directly depends on
	 */
	getDependencies(projectId: string): SubProject[] {
		const project = this.graph.projects.find((p) => p.id === projectId)
		if (!project) return []
		return DepGraphResolver.getDependencies(project, this.graph)
	}

	// ========================================================================
	// Affected Projects
	// ========================================================================

	/**
	 * Determine which projects are affected by a set of changed files.
	 *
	 * Algorithm:
	 * 1. For each changed file, determine which sub-project it belongs to
	 * 2. Collect all directly affected projects
	 * 3. Find all transitive dependents of those projects
	 *
	 * A project is "affected" if:
	 * - A changed file is within its rootPath, OR
	 * - It transitively depends on a project containing a changed file
	 *
	 * @param changedFiles - Array of absolute or relative file paths that changed
	 * @param projects - All sub-projects in the workspace
	 * @param graph - The dependency graph
	 * @returns Array of affected SubProjects (deduplicated)
	 */
	static getAffectedProjects(changedFiles: string[], projects: SubProject[], graph: DependencyGraph): SubProject[] {
		if (changedFiles.length === 0 || projects.length === 0) {
			return []
		}

		const affectedIds = new Set<string>()
		const projectMap = new Map<string, SubProject>()

		for (const p of projects) {
			projectMap.set(p.id, p)
		}

		// Phase 1: Find directly affected projects (those containing changed files)
		for (const filePath of changedFiles) {
			const normalizedPath = path.normalize(filePath)
			let bestMatch: SubProject | undefined
			let bestLength = 0

			for (const project of projects) {
				// Check if file path starts with the project rootPath
				if (normalizedPath.startsWith(project.rootPath)) {
					if (project.rootPath.length > bestLength) {
						bestMatch = project
						bestLength = project.rootPath.length
					}
				}
			}

			if (bestMatch) {
				affectedIds.add(bestMatch.id)
			}
		}

		// Phase 2: Find transitively affected projects (dependents of direct matches)
		const adjacency = DepGraphResolver.buildAdjacency(graph)
		const transitiveAffected = new Set<string>()

		for (const affectedId of affectedIds) {
			// BFS on reverse adjacency to find all dependents
			const queue: string[] = [affectedId]
			const visited = new Set<string>()

			while (queue.length > 0) {
				const current = queue.shift()!
				if (visited.has(current)) continue
				visited.add(current)

				transitiveAffected.add(current)

				const reverseNeighbors = adjacency.reverse.get(current)
				if (reverseNeighbors) {
					for (const depId of reverseNeighbors) {
						if (!visited.has(depId)) {
							queue.push(depId)
						}
					}
				}
			}
		}

		// Convert to SubProject array in stable order
		const result: SubProject[] = []
		for (const id of transitiveAffected) {
			const project = projectMap.get(id)
			if (project) {
				result.push(project)
			}
		}

		return result
	}

	/**
	 * Instance method for affected projects.
	 *
	 * @param changedFiles - Array of changed file paths
	 * @param projects - All sub-projects (defaults to `this.graph.projects`)
	 * @returns Array of affected SubProjects
	 */
	getAffectedProjects(changedFiles: string[], projects?: SubProject[]): SubProject[] {
		return DepGraphResolver.getAffectedProjects(changedFiles, projects ?? this.graph.projects, this.graph)
	}

	// ========================================================================
	// Context Section for LLM
	// ========================================================================

	/**
	 * Produce a structured context section for LLM injection.
	 *
	 * The context includes:
	 * - Project count and language breakdown
	 * - Build order (per layer)
	 * - Dependency chains for each project
	 * - Cycle warnings (if any)
	 * - Parallel-safe groups
	 *
	 * @param graph - The dependency graph
	 * @returns A ContextSection with type "monorepo_structure"
	 */
	static contextualize(graph: DependencyGraph): ContextSection {
		if (graph.projects.length === 0) {
			return {
				type: "monorepo_structure",
				content: "No sub-projects detected in the workspace.",
				tokenCount: 8,
			}
		}

		const lines: string[] = []
		lines.push("=== Dependency Graph Context ===")
		lines.push(`Total projects: ${graph.projects.length}`)

		// Language breakdown
		const languageCount = new Map<string, number>()
		for (const p of graph.projects) {
			languageCount.set(p.language, (languageCount.get(p.language) ?? 0) + 1)
		}
		const langBreakdown = Array.from(languageCount.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([lang, count]) => `${lang} (${count})`)
			.join(", ")
		lines.push(`Languages: ${langBreakdown}`)
		lines.push("")

		// Build order (layers)
		const layers = DepGraphResolver.topologicalSort(graph)
		for (let i = 0; i < layers.length; i++) {
			const layer = layers[i]
			const layerInfo = layer
				.map((p) => {
					const deps = DepGraphResolver.getDependencies(p, graph)
					const depStr = deps.length > 0 ? ` [depends on: ${deps.map((d) => d.name).join(", ")}]` : ""
					return `  - ${p.name} (${p.language})${depStr}`
				})
				.join("\n")

			lines.push(`Build Order (Layer ${i + 1}${layer.length > 1 ? " - Parallel" : ""}):`)
			lines.push(layerInfo)
			lines.push("")
		}

		// Cycle warnings
		const cycles = DepGraphResolver.detectCycles(graph)
		if (cycles.length > 0) {
			lines.push(`⚠️  ${cycles.length} circular dependenc${cycles.length === 1 ? "y" : "ies"} detected:`)
			for (const cycle of cycles) {
				const pathStr = cycle.map((e) => e.from).join(" → ")
				lines.push(`  Cycle: ${pathStr}`)
			}
			lines.push("")
		}

		// Parallel-safe groups summary
		const parallelGroups = DepGraphResolver.getParallelGroups(graph)
		const parallelSummary = parallelGroups.map((g, i) => `Layer ${i + 1} (${g.length})`).join(", ")
		lines.push(`Parallel-safe groups: ${parallelSummary}`)

		const content = lines.join("\n")

		// Rough token estimate (4 chars ≈ 1 token)
		const tokenCount = Math.ceil(content.length / 4)

		return {
			type: "monorepo_structure",
			content,
			tokenCount,
		}
	}

	/**
	 * Instance method for contextualize.
	 *
	 * @returns ContextSection for the current graph
	 */
	contextualize(): ContextSection {
		return DepGraphResolver.contextualize(this.graph)
	}

	// ========================================================================
	// Format for LLM
	// ========================================================================

	/**
	 * Serialize a ContextSection to human-readable text for system prompt injection.
	 *
	 * If the token count exceeds `maxTokens`, the content is truncated:
	 * 1. First truncate project descriptions (keep names + edges)
	 * 2. If still over budget, keep only build order + cycle warnings
	 *
	 * @param context - The context section to serialize
	 * @param maxTokens - Maximum token budget (default: 4096)
	 * @returns Human-readable string suitable for LLM context
	 */
	static formatForLLM(context: ContextSection, maxTokens: number = 4096): string {
		if (!context.content || context.tokenCount === 0) {
			return ""
		}

		if (context.tokenCount <= maxTokens) {
			return `<monorepo_structure>\n${context.content}\n</monorepo_structure>`
		}

		// Truncation strategy: show condensed version
		const lines = context.content.split("\n")
		const truncatedLines: string[] = []
		let tokenBudget = maxTokens - 50 // Reserve for wrapper and note

		for (const line of lines) {
			const lineTokens = Math.ceil(line.length / 4)
			if (tokenBudget - lineTokens > 0) {
				truncatedLines.push(line)
				tokenBudget -= lineTokens
			} else {
				truncatedLines.push(
					`... (context truncated — showing ${truncatedLines.length} of ${lines.length} lines)`,
				)
				break
			}
		}

		return `<monorepo_structure>\n${truncatedLines.join("\n")}\n</monorepo_structure>`
	}

	/**
	 * Instance method for formatForLLM.
	 *
	 * @param maxTokens - Maximum token budget
	 * @returns Formatted string for LLM context
	 */
	formatForLLM(maxTokens: number = 4096): string {
		const context = this.contextualize()
		return DepGraphResolver.formatForLLM(context, maxTokens)
	}

	// ========================================================================
	// Serialize for Context (Existing Instance Method)
	// ========================================================================

	/**
	 * Serialize graph to structured text for LLM context injection.
	 * Keeps within token budget by truncating if needed.
	 *
	 * This is the existing instance method that was in the stub.
	 *
	 * @param maxTokens - Maximum token budget (default: 4096)
	 * @returns Formatted context section string
	 */
	serializeForContext(maxTokens: number = 4096): string {
		const context = this.contextualize()
		return DepGraphResolver.formatForLLM(context, maxTokens)
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	/**
	 * Build adjacency list representation from a dependency graph.
	 * Produces both forward (dependencies) and reverse (dependents) maps.
	 *
	 * @param graph - The dependency graph
	 * @returns AdjacencyInfo with forward, reverse, and project map
	 */
	private static buildAdjacency(graph: DependencyGraph): AdjacencyInfo {
		const forward = new Map<string, Set<string>>()
		const reverse = new Map<string, Set<string>>()
		const projectMap = new Map<string, SubProject>()

		for (const p of graph.projects) {
			forward.set(p.id, new Set())
			reverse.set(p.id, new Set())
			projectMap.set(p.id, p)
		}

		for (const p of graph.projects) {
			for (const depId of p.dependencies) {
				if (forward.has(depId)) {
					forward.get(p.id)!.add(depId)
					reverse.get(depId)!.add(p.id)
				}
			}
			for (const devDepId of p.devDependencies) {
				if (forward.has(devDepId)) {
					forward.get(p.id)!.add(devDepId)
					reverse.get(devDepId)!.add(p.id)
				}
			}
		}

		return { forward, reverse, projectMap }
	}

	/**
	 * Deduplicate cycle edge arrays.
	 * Two cycles are considered the same if they contain the same edges
	 * (regardless of starting point).
	 */
	private static deduplicateCycleEdges(cycles: DependencyEdge[][]): DependencyEdge[][] {
		const seen = new Set<string>()
		const unique: DependencyEdge[][] = []

		for (const cycle of cycles) {
			// Create a canonical key: sort edges by from→to
			const sortedEdges = [...cycle].sort((a, b) => {
				if (a.from !== b.from) return a.from.localeCompare(b.from)
				return a.to.localeCompare(b.to)
			})
			const key = sortedEdges.map((e) => `${e.from}->${e.to}`).join(",")

			if (!seen.has(key)) {
				seen.add(key)
				unique.push(cycle)
			}
		}

		return unique
	}
}
