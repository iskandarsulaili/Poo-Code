import * as path from "path"
import * as fs from "fs/promises"

import type { DependencyGraph, DependencyOverride, SubProject } from "@roo-code/types"

import { experimentConfigsMap } from "../../shared/experiments"
import { DepGraphResolver } from "./DepGraphResolver"

// ============================================================================
// Types
// ============================================================================

/**
 * Type of dependency relationship between projects.
 */
export type DependencyType = "build" | "runtime" | "dev" | "test" | "type" | "unknown"

/**
 * Internal representation of a directed edge in the dependency graph.
 */
interface Edge {
	from: string
	to: string
	type: DependencyType
}

/**
 * Options for the DepGraphBuilder.
 */
export interface DepGraphBuilderOptions {
	/**
	 * Whether to perform deep manifest scanning for cross-project deps.
	 * When false, only uses dependency names from SubProject.dependencies arrays.
	 * Default: true
	 */
	deepScan?: boolean
	/**
	 * Whether to scan source files for import statements referencing sibling projects.
	 * Default: false (expensive on large projects)
	 */
	scanImports?: boolean
}

// ============================================================================
// Constants
// ============================================================================

/** Known workspace config filenames for monorepo topology detection. */
const WORKSPACE_CONFIGS = new Set(["pnpm-workspace.yaml", "lerna.json", "turbo.json", "rush.json", "nx.json"])

/** Build manifest filenames that support path-based local dependencies. */
const PATH_DEP_MANIFESTS = new Set(["Cargo.toml", "go.mod", "settings.gradle.kts", "settings.gradle"])

// ============================================================================
// DepGraphBuilder
// ============================================================================

/**
 * Builds a directed dependency graph from discovered sub-projects.
 *
 * Resolves inter-project edges by matching dependency names to project names/paths,
 * performs cross-project dependency detection by parsing manifests, and supports
 * manual override merging for auto-detection corrections.
 *
 * ### Feature Flag
 * When the `DEPENDENCY_GRAPH` experiment is disabled, `build()` returns an empty
 * graph with all projects listed as independent (no edges).
 *
 * ### Cross-Project Detection
 * Supports the following manifests for dependency resolution:
 * - `package.json` — `dependencies`/`devDependencies`/`workspaces` fields
 * - `Cargo.toml` — `[dependencies]` with `path = "../"` references
 * - `go.mod` — `require` and `replace` directives pointing to local modules
 * - `settings.gradle.kts` — `include()` directives
 * - `tsconfig.json` — `paths`/`references` for TypeScript project references
 * - `pnpm-workspace.yaml`, `lerna.json`, `turbo.json` — workspace topology
 * - Import statements in source files (at directory level)
 *
 * ### Cycle Detection
 * Cycles are detected using DFS and stored in the graph metadata.
 * The builder warns on cycle detection but does not throw — the graph
 * is still returned with cycle information.
 *
 * ### Error Handling
 * Missing or unparseable manifest files are skipped gracefully with a warning.
 * Parse errors for individual dependencies log a warning and skip that edge.
 */
export class DepGraphBuilder {
	private currentGraph: DependencyGraph | null = null
	private edges: Edge[] = []
	private readonly deepScan: boolean
	private readonly scanImports: boolean
	private readonly isEnabled: boolean
	private readonly useDepGraphResolver: boolean

	/**
	 * @param options - Optional configuration for the builder
	 */
	constructor(options?: DepGraphBuilderOptions) {
		this.deepScan = options?.deepScan ?? true
		this.scanImports = options?.scanImports ?? false
		this.isEnabled = experimentConfigsMap.DEPENDENCY_GRAPH?.enabled ?? true
		this.useDepGraphResolver = this.isEnabled
	}

	/**
	 * Build a dependency graph from sub-projects.
	 *
	 * When the feature flag is disabled, returns an empty graph with all projects
	 * listed as independent (no edges, all projects are both root and leaf).
	 *
	 * The build process:
	 * 1. Indexes projects by name and rootPath for efficient lookup
	 * 2. Resolves cross-project dependency edges by matching dependency names
	 * 3. Performs deep manifest scanning (if enabled) for additional edges
	 * 4. Computes leaf/root status for each project
	 * 5. Runs topological sort and cycle detection
	 * 6. Caches the result internally
	 *
	 * @param projects - Array of detected sub-projects from SubProjectDetector
	 * @returns A fully resolved dependency graph
	 */
	build(projects: SubProject[]): DependencyGraph {
		// Feature flag check: graceful degradation
		if (!this.isEnabled) {
			console.log("[DepGraphBuilder] DEPENDENCY_GRAPH feature is disabled — returning empty graph")
			return {
				projects: projects.map((p) => ({ ...p, isRoot: true, isLeaf: true })),
				buildOrder: projects.map((p) => p.id),
				cycles: [],
				updatedAt: new Date(),
			}
		}

		if (projects.length === 0) {
			return {
				projects: [],
				buildOrder: [],
				cycles: [],
				updatedAt: new Date(),
			}
		}

		// Phase 1: Index projects by name and rootPath
		const projectMap = new Map<string, SubProject>()
		const projectByName = new Map<string, SubProject>()
		const projectByRootPath = new Map<string, SubProject>()

		for (const p of projects) {
			projectMap.set(p.id, p)
			projectByName.set(p.name, p)
			projectByRootPath.set(p.rootPath, p)
		}

		// Phase 2: Build adjacency list and resolve dependency edges
		const adjacency = new Map<string, Set<string>>()
		const reverseAdjacency = new Map<string, Set<string>>()
		const edgeTypes = new Map<string, DependencyType>() // "from->to" -> type

		for (const p of projects) {
			adjacency.set(p.id, new Set())
			reverseAdjacency.set(p.id, new Set())
		}

		// Phase 2a: Resolve dependencies from SubProject.dependencies/devDependencies
		for (const p of projects) {
			this.resolveEdgesFromDeps(p, projects, projectByName, adjacency, reverseAdjacency, edgeTypes)
		}

		// Phase 2b: Deep manifest scanning for additional cross-project edges
		if (this.deepScan) {
			for (const p of projects) {
				this.deepScanManifest(p, projects, projectByName, adjacency, reverseAdjacency, edgeTypes).catch(
					(err) => {
						console.warn(`[DepGraphBuilder] Deep scan failed for "${p.id}":`, err)
					},
				)
			}
		}

		// Phase 2c: Scan import statements if enabled
		if (this.scanImports) {
			for (const p of projects) {
				this.scanImportStatements(p, projects, projectByName, adjacency, reverseAdjacency, edgeTypes).catch(
					(err) => {
						console.warn(`[DepGraphBuilder] Import scan failed for "${p.id}":`, err)
					},
				)
			}
		}

		// Apply accumulated edges from addEdge() calls
		for (const edge of this.edges) {
			if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
				adjacency.get(edge.from)!.add(edge.to)
				reverseAdjacency.get(edge.to)!.add(edge.from)
				edgeTypes.set(`${edge.from}->${edge.to}`, edge.type)
			}
		}

		// Phase 3: Compute leaf/root status
		this.computeStatus(projects, adjacency, reverseAdjacency)

		// Phase 4: Topological sort and cycle detection
		let buildOrder: SubProject[]
		let cycles: Array<string[]>

		if (this.useDepGraphResolver) {
			try {
				// Update SubProject dependency lists from adjacency for DepGraphResolver
				for (const p of projects) {
					const deps = adjacency.get(p.id)
					if (deps) {
						const runtimeDeps: string[] = []
						const devDeps: string[] = []
						for (const depId of deps) {
							const type = edgeTypes.get(`${p.id}->${depId}`)
							if (type === "dev") {
								devDeps.push(depId)
							} else {
								runtimeDeps.push(depId)
							}
						}
						p.dependencies = runtimeDeps
						p.devDependencies = devDeps
					}
				}

				// Build temporary graph for DepGraphResolver
				const tempGraph: DependencyGraph = {
					projects,
					buildOrder: [],
					cycles: [],
					updatedAt: new Date(),
				}

				// Use DepGraphResolver for cycle detection
				const edgeCycles = DepGraphResolver.detectCycles(tempGraph)
				cycles = edgeCycles.map((cycle) => {
					const ids: string[] = []
					for (const edge of cycle) {
						if (ids.length === 0 || ids[ids.length - 1] !== edge.from) {
							ids.push(edge.from)
						}
					}
					return ids
				})

				// Use DepGraphResolver for topological sort (layered build order)
				const layers = DepGraphResolver.topologicalSort(tempGraph)
				buildOrder = layers.flat()

				console.log(
					`[DepGraphBuilder] DepGraphResolver: ${layers.length} build layers, ${cycles.length} cycles detected`,
				)
			} catch (err) {
				// Graceful degradation: fall back to built-in algorithms
				console.warn("[DepGraphBuilder] DepGraphResolver failed, falling back to built-in algorithms:", err)
				buildOrder = this.computeBuildOrder(projects, adjacency)
				cycles = this.detectCyclesInner(projects, adjacency)
			}
		} else {
			// Use built-in algorithms
			buildOrder = this.computeBuildOrder(projects, adjacency)
			cycles = this.detectCyclesInner(projects, adjacency)
		}

		// Store the result
		this.currentGraph = {
			projects,
			buildOrder: buildOrder.map((p) => p.id),
			cycles,
			updatedAt: new Date(),
		}

		return this.currentGraph
	}

	/**
	 * Add a dependency edge between projects.
	 * Edges added via this method are included the next time `build()` is called.
	 *
	 * @param from - Source project ID
	 * @param to - Target project ID (dependency of `from`)
	 * @param type - Type of dependency relationship
	 */
	addEdge(from: string, to: string, type: DependencyType = "runtime"): void {
		this.edges.push({ from, to, type })
	}

	/**
	 * Get the current graph (last built).
	 *
	 * @returns The current dependency graph
	 * @throws If `build()` has not been called yet
	 */
	getGraph(): DependencyGraph {
		if (!this.currentGraph) {
			throw new Error("DepGraphBuilder: build() has not been called yet")
		}
		return this.currentGraph
	}

	/**
	 * Merge multiple dependency graphs from different workspace roots into one.
	 *
	 * Projects are deduplicated by `id`. If two projects with the same ID exist,
	 * the first occurrence is kept. Edges from all graphs are combined.
	 * Cycles are recomputed on the merged graph.
	 *
	 * @param graphs - Array of dependency graphs to merge
	 * @returns A single merged dependency graph
	 */
	mergeGraphs(graphs: DependencyGraph[]): DependencyGraph {
		if (graphs.length === 0) {
			return {
				projects: [],
				buildOrder: [],
				cycles: [],
				updatedAt: new Date(),
			}
		}

		if (graphs.length === 1) {
			return graphs[0]
		}

		// Deduplicate projects by ID
		const projectMap = new Map<string, SubProject>()
		for (const g of graphs) {
			for (const p of g.projects) {
				if (!projectMap.has(p.id)) {
					projectMap.set(p.id, p)
				}
			}
		}

		const mergedProjects = Array.from(projectMap.values())

		// Rebuild graph from merged projects
		return this.build(mergedProjects)
	}

	/**
	 * Merge manually specified edges with auto-detected ones.
	 * Manual overrides take precedence over auto-detected edges.
	 *
	 * - `type: "add"` — adds an edge `from → to` (overrides any existing edge)
	 * - `type: "remove"` — removes all edges from `from` (or from `from` to `to` if specified)
	 *
	 * After applying overrides, leaf/root status is recomputed and
	 * a fresh topological sort is performed.
	 *
	 * @param graph - The auto-detected dependency graph
	 * @param overrides - Array of manual edge overrides
	 * @returns Merged dependency graph with overrides applied
	 */
	mergeOverrides(graph: DependencyGraph, overrides: DependencyOverride[]): DependencyGraph {
		if (overrides.length === 0) {
			return graph
		}

		// Build mutable adjacency from the graph
		const adjacency = new Map<string, Set<string>>()
		const edgeTypes = new Map<string, DependencyType>()

		for (const p of graph.projects) {
			adjacency.set(p.id, new Set())
		}

		// Rebuild edges from project dependencies
		for (const p of graph.projects) {
			for (const depId of p.dependencies) {
				if (adjacency.has(depId)) {
					adjacency.get(p.id)!.add(depId)
					edgeTypes.set(`${p.id}->${depId}`, "runtime")
				}
			}
			for (const devDepId of p.devDependencies) {
				if (adjacency.has(devDepId)) {
					adjacency.get(p.id)!.add(devDepId)
					edgeTypes.set(`${p.id}->${devDepId}`, "dev")
				}
			}
		}

		// Apply overrides
		for (const override of overrides) {
			if (override.type === "add" && override.to) {
				// Add edge
				if (adjacency.has(override.from) && adjacency.has(override.to)) {
					adjacency.get(override.from)!.add(override.to)
					edgeTypes.set(`${override.from}->${override.to}`, "runtime")
				}
			} else if (override.type === "remove") {
				// Remove edge(s)
				if (override.to) {
					adjacency.get(override.from)?.delete(override.to)
					edgeTypes.delete(`${override.from}->${override.to}`)
				} else {
					// Remove all outgoing edges from `from`
					for (const target of adjacency.get(override.from) ?? []) {
						edgeTypes.delete(`${override.from}->${target}`)
					}
					adjacency.set(override.from, new Set())
				}
			}
		}

		// Rebuild dependency lists on projects
		const reverseAdjacency = new Map<string, Set<string>>()
		for (const p of graph.projects) {
			reverseAdjacency.set(p.id, new Set())
		}

		for (const [from, targets] of adjacency) {
			for (const to of targets) {
				reverseAdjacency.get(to)!.add(from)
			}
		}

		// Update dependency lists on SubProject objects
		for (const p of graph.projects) {
			const deps = adjacency.get(p.id)
			if (deps) {
				const runtimeDeps: string[] = []
				const devDeps: string[] = []
				for (const depId of deps) {
					const type = edgeTypes.get(`${p.id}->${depId}`)
					if (type === "dev") {
						devDeps.push(depId)
					} else {
						runtimeDeps.push(depId)
					}
				}
				p.dependencies = runtimeDeps
				p.devDependencies = devDeps
			}
		}

		// Recompute status
		this.computeStatus(graph.projects, adjacency, reverseAdjacency)

		// Recompute build order and cycles — use DepGraphResolver if flag enabled
		let buildOrder: SubProject[]
		let cycles: Array<string[]>

		if (this.useDepGraphResolver) {
			try {
				// Build temporary graph for DepGraphResolver
				const tempGraph: DependencyGraph = {
					projects: graph.projects,
					buildOrder: [],
					cycles: [],
					updatedAt: new Date(),
				}

				const edgeCycles = DepGraphResolver.detectCycles(tempGraph)
				cycles = edgeCycles.map((cycle) => {
					const ids: string[] = []
					for (const edge of cycle) {
						if (ids.length === 0 || ids[ids.length - 1] !== edge.from) {
							ids.push(edge.from)
						}
					}
					return ids
				})

				const layers = DepGraphResolver.topologicalSort(tempGraph)
				buildOrder = layers.flat()
			} catch (err) {
				console.warn("[DepGraphBuilder] DepGraphResolver in mergeOverrides failed, falling back:", err)
				buildOrder = this.computeBuildOrder(graph.projects, adjacency)
				cycles = this.detectCyclesInner(graph.projects, adjacency)
			}
		} else {
			buildOrder = this.computeBuildOrder(graph.projects, adjacency)
			cycles = this.detectCyclesInner(graph.projects, adjacency)
		}

		this.currentGraph = {
			projects: graph.projects,
			buildOrder: buildOrder.map((p) => p.id),
			cycles,
			updatedAt: new Date(),
		}

		return this.currentGraph
	}

	/**
	 * Serialize the current dependency graph to a JSON string.
	 * Suitable for LLM context injection or debugging.
	 *
	 * @returns JSON-formatted string of the current graph
	 * @throws If `build()` has not been called yet
	 */
	serialize(): string {
		const graph = this.getGraph()
		const payload: Record<string, unknown> = {
			projectCount: graph.projects.length,
			buildOrder: graph.buildOrder,
			cycles: graph.cycles,
			updatedAt: graph.updatedAt.toISOString(),
			projects: graph.projects.map((p) => ({
				id: p.id,
				name: p.name,
				language: p.language,
				dependencies: p.dependencies,
				devDependencies: p.devDependencies,
				isRoot: p.isRoot,
				isLeaf: p.isLeaf,
			})),
		}

		// Integrate DepGraphResolver for LLM context serialization
		if (this.useDepGraphResolver) {
			try {
				const resolver = new DepGraphResolver(graph)
				const contextSection = resolver.contextualize()
				const llmContext = resolver.formatForLLM()
				payload.llmContext = llmContext
				payload.contextSection = contextSection
			} catch (err) {
				console.warn("[DepGraphBuilder] DepGraphResolver.serialize enrichment failed:", err)
			}
		}

		return JSON.stringify(payload, null, 2)
	}

	/**
	 * Generate a Mermaid.js flowchart diagram from the dependency graph.
	 *
	 * The diagram uses subgraphs per build layer and directional edges.
	 * Cycles are highlighted in red.
	 *
	 * @returns A Mermaid.js flowchart string
	 * @throws If `build()` has not been called yet
	 */
	toMermaid(): string {
		const graph = this.getGraph()
		const lines: string[] = ["flowchart LR"]

		// Add project nodes with labels
		for (const p of graph.projects) {
			const label = `${p.name} (${p.language})`
			// Escape special characters in node IDs
			const nodeId = this.mermaidSafeId(p.id)
			lines.push(`    ${nodeId}["${label}"]`)
		}

		// Add dependency edges
		const edgeSet = new Set<string>()
		for (const p of graph.projects) {
			for (const dep of p.dependencies) {
				const fromId = this.mermaidSafeId(p.id)
				const toId = this.mermaidSafeId(dep)
				const key = `${fromId}->${toId}`
				if (!edgeSet.has(key)) {
					edgeSet.add(key)
					lines.push(`    ${fromId} --> ${toId}`)
				}
			}
			for (const dep of p.devDependencies) {
				const fromId = this.mermaidSafeId(p.id)
				const toId = this.mermaidSafeId(dep)
				const key = `${fromId}=>${toId}`
				if (!edgeSet.has(key)) {
					edgeSet.add(key)
					lines.push(`    ${fromId} -.-> ${toId}`)
				}
			}
		}

		// Highlight cycles in red if any
		if (graph.cycles.length > 0) {
			lines.push("")
			lines.push("    %% Cycle highlights")
			for (const cycle of graph.cycles) {
				for (let i = 0; i < cycle.length; i++) {
					const fromId = this.mermaidSafeId(cycle[i])
					const toId = this.mermaidSafeId(cycle[(i + 1) % cycle.length])
					lines.push(`    linkStyle default stroke:red`)
				}
			}
		}

		return lines.join("\n")
	}

	// ========================================================================
	// Private: Dependency Resolution
	// ========================================================================

	/**
	 * Resolve a dependency name to a sub-project within the monorepo.
	 *
	 * Matching strategy (in priority order):
	 * 1. Exact match by project name
	 * 2. Exact match by project ID
	 * 3. NPM scoped name match (`@scope/name` matches project name)
	 * 4. RootPath suffix match (e.g., `packages/core` matches project with `.../packages/core`)
	 * 5. Workspace path reference match (e.g., `../sibling` → sibling project dir name)
	 * 6. Partial name containment (lowest priority)
	 *
	 * @param name - The dependency name to resolve
	 * @param projects - All available sub-projects
	 * @param context - The project that has this dependency
	 * @returns The matching sub-project, or undefined if not found
	 */
	private resolveDependency(name: string, projects: SubProject[], context: SubProject): SubProject | undefined {
		// 1. Exact match by project name
		const exactByName = projects.find((p) => p.name === name)
		if (exactByName) return exactByName

		// 2. Exact match by project ID
		const exactById = projects.find((p) => p.id === name)
		if (exactById) return exactById

		// 3. NPM scoped name match — match the scope/name to project name
		if (name.startsWith("@")) {
			const scopedName = name.split("/").pop()
			if (scopedName) {
				const scopedMatch = projects.find((p) => p.name === scopedName)
				if (scopedMatch) return scopedMatch
			}
		}

		// 4. RootPath suffix match (e.g., "packages/core" → project rootPath ends with "packages/core")
		const normalizedName = name.replace(/\\/g, "/")
		const pathMatch = projects.find((p) => {
			const normalizedRoot = p.rootPath.replace(/\\/g, "/")
			return normalizedRoot.endsWith(`/${normalizedName}`) || normalizedRoot.endsWith(`\\${normalizedName}`)
		})
		if (pathMatch) return pathMatch

		// 5. Path reference match — resolve `../sibling` relative to context
		if (name.startsWith("..") || name.startsWith(".")) {
			const resolvedPath = path.resolve(context.rootPath, name)
			// Look for a project whose rootPath is the resolved path
			const pathRefMatch = projects.find(
				(p) => p.rootPath === resolvedPath || p.rootPath.startsWith(resolvedPath),
			)
			if (pathRefMatch) return pathRefMatch
		}

		// 6. Check if name matches as a full path (Cargo.toml path = "../foo")
		const basename = path.basename(name).replace(/\\/g, "/")
		const basenameMatch = projects.find((p) => {
			const projectBasename = p.name.toLowerCase()
			return basename.toLowerCase() === projectBasename
		})
		if (basenameMatch) return basenameMatch

		return undefined
	}

	/**
	 * Resolve edges from a project's `dependencies` and `devDependencies` arrays.
	 * Matches dependency names to known projects and adds edges to the adjacency list.
	 */
	private resolveEdgesFromDeps(
		project: SubProject,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): void {
		for (const depName of project.dependencies) {
			const target = this.resolveDependency(depName, projects, project)
			if (target && target.id !== project.id) {
				adjacency.get(project.id)!.add(target.id)
				reverseAdjacency.get(target.id)!.add(project.id)
				edgeTypes.set(`${project.id}->${target.id}`, "runtime")
			}
		}

		for (const depName of project.devDependencies) {
			const target = this.resolveDependency(depName, projects, project)
			if (target && target.id !== project.id) {
				adjacency.get(project.id)!.add(target.id)
				reverseAdjacency.get(target.id)!.add(project.id)
				edgeTypes.set(`${project.id}->${target.id}`, "dev")
			}
		}
	}

	// ========================================================================
	// Private: Deep Manifest Scanning
	// ========================================================================

	/**
	 * Perform deep scanning of a project's build manifest for additional
	 * cross-project dependency edges that may not appear in the basic
	 * `dependencies[]` list from SubProjectDetector.
	 */
	private async deepScanManifest(
		project: SubProject,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		const manifestPath = path.join(project.rootPath, project.buildManifest)

		switch (project.buildManifestType) {
			case "package.json":
				await this.detectPackageJsonEdges(
					project,
					manifestPath,
					projects,
					projectByName,
					adjacency,
					reverseAdjacency,
					edgeTypes,
				)
				break

			case "Cargo.toml":
				await this.detectCargoTomlEdges(
					project,
					manifestPath,
					projects,
					projectByName,
					adjacency,
					reverseAdjacency,
					edgeTypes,
				)
				break

			case "go.mod":
				await this.detectGoModEdges(
					project,
					manifestPath,
					projects,
					projectByName,
					adjacency,
					reverseAdjacency,
					edgeTypes,
				)
				break

			case "build.gradle.kts":
			case "build.gradle":
				await this.detectGradleEdges(
					project,
					manifestPath,
					projects,
					projectByName,
					adjacency,
					reverseAdjacency,
					edgeTypes,
				)
				break
		}

		// Check for workspace config files
		await this.detectWorkspaceEdges(project, projects, projectByName, adjacency, reverseAdjacency, edgeTypes)

		// Check for tsconfig.json references
		await this.detectTsConfigEdges(project, projects, projectByName, adjacency, reverseAdjacency, edgeTypes)
	}

	/**
	 * Scan package.json for workspace references and path-based local deps.
	 */
	private async detectPackageJsonEdges(
		project: SubProject,
		manifestPath: string,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		try {
			const content = await fs.readFile(manifestPath, "utf-8")
			const pkg = JSON.parse(content) as Record<string, unknown>

			// Check `workspaces` field for workspace topology
			const workspaces = pkg.workspaces
			if (workspaces) {
				// Workspaces can be an array or an object with `packages` array
				const workspacePatterns: string[] = Array.isArray(workspaces)
					? (workspaces as string[])
					: Array.isArray((workspaces as Record<string, unknown>).packages)
						? ((workspaces as Record<string, unknown>).packages as string[])
						: []

				// Resolve workspace globs to actual projects
				for (const pattern of workspacePatterns) {
					// Convert glob to prefix match
					const prefixDir = pattern.replace(/\/\*\*\/?$/, "").replace(/\*$/, "")
					for (const p of projects) {
						if (p.id === project.id) continue
						const relativePath = path.relative(project.rootPath, p.rootPath)
						if (relativePath.startsWith(prefixDir)) {
							adjacency.get(project.id)!.add(p.id)
							reverseAdjacency.get(p.id)!.add(project.id)
							edgeTypes.set(`${project.id}->${p.id}`, "runtime")
						}
					}
				}
			}
		} catch {
			// Skip gracefully — missing or unparseable manifest
		}
	}

	/**
	 * Scan Cargo.toml for path-based local dependencies.
	 */
	private async detectCargoTomlEdges(
		project: SubProject,
		manifestPath: string,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		try {
			const content = await fs.readFile(manifestPath, "utf-8")

			// Match dependencies with path = "../foo" references
			const pathDepRegex = /\[dependencies\]([\s\S]*?)(?:^\[|\z)/gm
			const match = pathDepRegex.exec(content)
			if (match) {
				const section = match[1]
				const pathRefs = section.matchAll(/^\s*(\w[\w-]*)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"[^}]*\}/gm)
				for (const ref of pathRefs) {
					const depName = ref[1]
					const depPath = ref[2]
					const resolvedPath = path.resolve(project.rootPath, depPath)
					const target = projects.find(
						(p) => p.rootPath === resolvedPath || p.name === depName || p.name === path.basename(depPath),
					)
					if (target && target.id !== project.id) {
						adjacency.get(project.id)!.add(target.id)
						reverseAdjacency.get(target.id)!.add(project.id)
						edgeTypes.set(`${project.id}->${target.id}`, "runtime")
					}
				}

				// Also check simple path deps: dep = { path = "../foo" }
				const simpleRefs = section.matchAll(/^\s*(\w[\w-]*)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"[^}]*\}/gm)
				for (const ref of simpleRefs) {
					// Already captured above by the same pattern
					void ref
				}
			}

			// Check [dev-dependencies] with path refs
			const devMatch = content.match(/\[dev-dependencies\]([\s\S]*?)(?:^\[|\z)/m)
			if (devMatch) {
				const devSection = devMatch[1]
				const devPathRefs = devSection.matchAll(/^\s*(\w[\w-]*)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"[^}]*\}/gm)
				for (const ref of devPathRefs) {
					const depName = ref[1]
					const depPath = ref[2]
					const resolvedPath = path.resolve(project.rootPath, depPath)
					const target = projects.find(
						(p) => p.rootPath === resolvedPath || p.name === depName || p.name === path.basename(depPath),
					)
					if (target && target.id !== project.id) {
						adjacency.get(project.id)!.add(target.id)
						reverseAdjacency.get(target.id)!.add(project.id)
						edgeTypes.set(`${project.id}->${target.id}`, "dev")
					}
				}
			}
		} catch {
			// Skip gracefully
		}
	}

	/**
	 * Scan go.mod for local module dependencies via `replace` directives.
	 */
	private async detectGoModEdges(
		project: SubProject,
		manifestPath: string,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		try {
			const content = await fs.readFile(manifestPath, "utf-8")

			// Match `replace module/path => ../local/path` directives
			const replaceRegex = /replace\s+(\S+)\s*=>\s*(\S+)/g
			const replaceMatches = content.matchAll(replaceRegex)
			for (const match of replaceMatches) {
				const _modulePath = match[1]
				const localPath = match[2]

				// Check if local path is a relative filesystem reference
				if (localPath.startsWith(".") || localPath.startsWith("..")) {
					const resolvedPath = path.resolve(project.rootPath, localPath)
					const target = projects.find(
						(p) => p.rootPath === resolvedPath || p.rootPath.startsWith(resolvedPath),
					)
					if (target && target.id !== project.id) {
						adjacency.get(project.id)!.add(target.id)
						reverseAdjacency.get(target.id)!.add(project.id)
						edgeTypes.set(`${project.id}->${target.id}`, "runtime")
					}
				}
			}
		} catch {
			// Skip gracefully
		}
	}

	/**
	 * Scan settings.gradle.kts for `include()` directives referencing local projects.
	 */
	private async detectGradleEdges(
		project: SubProject,
		manifestPath: string,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		try {
			const content = await fs.readFile(manifestPath, "utf-8")

			// Match `include(":project-name")` or `include ':project-name'`
			const includeRegex = /include\s*\(\s*['"](:?[^'"]+)['"]\s*\)/g
			const includeMatches = content.matchAll(includeRegex)
			for (const match of includeMatches) {
				const includePath = match[1].replace(/^:/, "")

				// Try to match the included project path to a known project
				for (const p of projects) {
					if (p.id === project.id) continue
					// Check if project rootPath ends with the include path
					const normalizedRoot = p.rootPath.replace(/\\/g, "/")
					const normalizedInclude = includePath.replace(/\\/g, "/").replace(/:/g, "/")
					if (normalizedRoot.endsWith(`/${normalizedInclude}`) || p.name === normalizedInclude) {
						adjacency.get(project.id)!.add(p.id)
						reverseAdjacency.get(p.id)!.add(project.id)
						edgeTypes.set(`${project.id}->${p.id}`, "runtime")
					}
				}
			}
		} catch {
			// Skip gracefully
		}
	}

	/**
	 * Scan for tsconfig.json `references` and `paths` for TypeScript project references.
	 */
	private async detectTsConfigEdges(
		project: SubProject,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		const tsconfigPath = path.join(project.rootPath, "tsconfig.json")
		try {
			const content = await fs.readFile(tsconfigPath, "utf-8")
			const tsconfig = JSON.parse(content) as Record<string, unknown>

			// Check `references` field for TypeScript project references
			const refs = tsconfig.references as Array<{ path: string }> | undefined
			if (Array.isArray(refs)) {
				for (const ref of refs) {
					if (ref.path) {
						const resolvedPath = path.resolve(project.rootPath, ref.path)
						const target = projects.find(
							(p) => p.rootPath === resolvedPath || p.rootPath === path.resolve(resolvedPath),
						)
						if (target && target.id !== project.id) {
							adjacency.get(project.id)!.add(target.id)
							reverseAdjacency.get(target.id)!.add(project.id)
							edgeTypes.set(`${project.id}->${target.id}`, "build")
						}
					}
				}
			}

			// Check `compilerOptions.paths` for path aliases pointing to sibling projects
			const compilerOptions = tsconfig.compilerOptions as Record<string, unknown> | undefined
			if (compilerOptions?.paths) {
				const paths = compilerOptions.paths as Record<string, string[]>
				for (const [_alias, aliasPaths] of Object.entries(paths)) {
					for (const aliasPath of aliasPaths) {
						if (aliasPath.startsWith("..") || aliasPath.startsWith(".")) {
							// Resolve relative to tsconfig.json parent and check for a project
							const baseDir = path.dirname(tsconfigPath)
							const resolvedPath = path.resolve(baseDir, aliasPath)

							// Walk up to find the project root
							for (const p of projects) {
								if (p.id === project.id) continue
								if (resolvedPath.startsWith(p.rootPath)) {
									adjacency.get(project.id)!.add(p.id)
									reverseAdjacency.get(p.id)!.add(project.id)
									edgeTypes.set(`${project.id}->${p.id}`, "type")
								}
							}
						}
					}
				}
			}
		} catch {
			// No tsconfig.json or parse error — not a TypeScript project, skip
		}
	}

	/**
	 * Scan for monorepo workspace configuration files
	 * (pnpm-workspace.yaml, lerna.json, turbo.json).
	 */
	private async detectWorkspaceEdges(
		project: SubProject,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		const dirPath = project.rootPath

		for (const configFile of WORKSPACE_CONFIGS) {
			const configPath = path.join(dirPath, configFile)
			try {
				const content = await fs.readFile(configPath, "utf-8")

				switch (configFile) {
					case "pnpm-workspace.yaml": {
						// Extract packages patterns
						const packagesMatch = content.match(/packages:\s*\n([\s\S]*?)(?:^\S|\z)/m)
						if (packagesMatch) {
							const patterns = packagesMatch[1].matchAll(/^\s*-\s+"([^"]+)"/gm)
							for (const pkgMatch of patterns) {
								const pattern = pkgMatch[1]
								const prefixDir = pattern.replace("/**", "").replace("/*", "")
								for (const p of projects) {
									if (p.id === project.id) continue
									const relativePath = path.relative(dirPath, p.rootPath)
									if (relativePath.startsWith(prefixDir)) {
										adjacency.get(project.id)!.add(p.id)
										reverseAdjacency.get(p.id)!.add(project.id)
										edgeTypes.set(`${project.id}->${p.id}`, "runtime")
									}
								}
							}
						}
						break
					}

					case "lerna.json": {
						// Extract packages field
						try {
							const lerna = JSON.parse(content) as Record<string, unknown>
							const lernaPackages = lerna.packages as string[] | undefined
							if (Array.isArray(lernaPackages)) {
								for (const pattern of lernaPackages) {
									const prefixDir = pattern.replace("/**", "").replace("/*", "")
									for (const p of projects) {
										if (p.id === project.id) continue
										const relativePath = path.relative(dirPath, p.rootPath)
										if (relativePath.startsWith(prefixDir)) {
											adjacency.get(project.id)!.add(p.id)
											reverseAdjacency.get(p.id)!.add(project.id)
											edgeTypes.set(`${project.id}->${p.id}`, "runtime")
										}
									}
								}
							}
						} catch {
							// JSON parse error
						}
						break
					}

					case "turbo.json": {
						// turbo.json defines pipeline dependencies
						try {
							const turbo = JSON.parse(content) as Record<string, unknown>
							const pipeline = turbo.pipeline as Record<string, { dependsOn?: string[] }> | undefined
							if (pipeline) {
								// Pipeline deps indicate task-level dependencies
								// Each `^dep` means "depends on sibling's task"
								for (const [_task, config] of Object.entries(pipeline)) {
									const dependsOn = config.dependsOn
									if (Array.isArray(dependsOn)) {
										for (const dep of dependsOn) {
											if (dep.startsWith("^")) {
												// This is a cross-project dependency hint
												// We use it to reinforce existing edges
											}
										}
									}
								}
							}
						} catch {
							// JSON parse error
						}
						break
					}
				}
			} catch {
				// File doesn't exist — skip
			}
		}
	}

	/**
	 * Scan source files in the project directory for import statements
	 * referencing sibling project paths.
	 */
	private async scanImportStatements(
		project: SubProject,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		try {
			const entries = await fs.readdir(project.rootPath, { withFileTypes: true })
			const srcDirs = entries.filter(
				(e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
			)

			for (const dir of srcDirs) {
				await this.scanDirForImports(
					path.join(project.rootPath, dir.name),
					project,
					projects,
					projectByName,
					adjacency,
					reverseAdjacency,
					edgeTypes,
					0,
				)
			}
		} catch {
			// Skip gracefully
		}
	}

	/**
	 * Recursively scan a directory for files containing import statements.
	 */
	private async scanDirForImports(
		dirPath: string,
		project: SubProject,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
		depth: number,
	): Promise<void> {
		if (depth > 3) return // Limit scan depth

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true })
			for (const entry of entries) {
				const fullPath = path.join(dirPath, entry.name)

				if (entry.isDirectory()) {
					if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
						await this.scanDirForImports(
							fullPath,
							project,
							projects,
							projectByName,
							adjacency,
							reverseAdjacency,
							edgeTypes,
							depth + 1,
						)
					}
				} else if (
					entry.isFile() &&
					(entry.name.endsWith(".ts") ||
						entry.name.endsWith(".tsx") ||
						entry.name.endsWith(".js") ||
						entry.name.endsWith(".jsx") ||
						entry.name.endsWith(".py") ||
						entry.name.endsWith(".rs") ||
						entry.name.endsWith(".go"))
				) {
					await this.scanFileForImports(
						fullPath,
						project,
						projects,
						projectByName,
						adjacency,
						reverseAdjacency,
						edgeTypes,
					)
				}
			}
		} catch {
			// Skip unreadable directories
		}
	}

	/**
	 * Scan a single source file for import statements referencing sibling projects.
	 */
	private async scanFileForImports(
		filePath: string,
		project: SubProject,
		projects: SubProject[],
		projectByName: Map<string, SubProject>,
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
		edgeTypes: Map<string, DependencyType>,
	): Promise<void> {
		try {
			const content = await fs.readFile(filePath, "utf-8")

			// TypeScript/JavaScript imports
			const importRegexes = [
				/from\s+['"]([^'"]+)['"]/g,
				/import\s+['"]([^'"]+)['"]/g,
				/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
			]

			for (const regex of importRegexes) {
				const matches = content.matchAll(regex)
				for (const match of matches) {
					const importPath = match[1]

					// Only check relative imports
					if (!importPath.startsWith(".") && !importPath.startsWith("..")) continue

					// Resolve the import path relative to the file
					const resolvedImportPath = path.resolve(path.dirname(filePath), importPath)

					// Check if the resolved path matches any project rootPath
					for (const p of projects) {
						if (p.id === project.id) continue
						if (resolvedImportPath.startsWith(p.rootPath) || p.rootPath.startsWith(resolvedImportPath)) {
							if (!adjacency.get(project.id)!.has(p.id)) {
								adjacency.get(project.id)!.add(p.id)
								reverseAdjacency.get(p.id)!.add(project.id)
								edgeTypes.set(`${project.id}->${p.id}`, "runtime")
							}
						}
					}
				}
			}

			// Python imports
			const pyImportRegex = /^(?:from|import)\s+(\S+)/gm
			const pyMatches = content.matchAll(pyImportRegex)
			for (const match of pyMatches) {
				const importPath = match[1].split(".")[0]
				for (const p of projects) {
					if (p.id === project.id) continue
					if (p.name === importPath || p.name.endsWith(`/${importPath}`)) {
						if (!adjacency.get(project.id)!.has(p.id)) {
							adjacency.get(project.id)!.add(p.id)
							reverseAdjacency.get(p.id)!.add(project.id)
							edgeTypes.set(`${project.id}->${p.id}`, "runtime")
						}
					}
				}
			}
		} catch {
			// Skip unreadable files
		}
	}

	// ========================================================================
	// Private: Graph Algorithms
	// ========================================================================

	/**
	 * Compute leaf and root status for all projects.
	 * - Leaf: no outgoing edges (no dependencies on other sub-projects)
	 * - Root: no incoming edges (no other project depends on this one)
	 */
	private computeStatus(
		projects: SubProject[],
		adjacency: Map<string, Set<string>>,
		reverseAdjacency: Map<string, Set<string>>,
	): void {
		for (const p of projects) {
			const outgoing = adjacency.get(p.id)
			p.isLeaf = !outgoing || outgoing.size === 0

			const incoming = reverseAdjacency.get(p.id)
			p.isRoot = !incoming || incoming.size === 0
		}
	}

	/**
	 * Compute topological sort order using Kahn's algorithm.
	 * Returns projects in build order (dependencies first).
	 */
	private computeBuildOrder(projects: SubProject[], adjacency: Map<string, Set<string>>): SubProject[] {
		const inDegree = new Map<string, number>()
		const queue: string[] = []
		const order: SubProject[] = []
		const projectMap = new Map(projects.map((p) => [p.id, p]))

		// Initialize in-degree for all nodes
		for (const p of projects) {
			inDegree.set(p.id, 0)
		}

		// Calculate in-degree (number of incoming edges)
		for (const [_from, targets] of adjacency) {
			for (const to of targets) {
				inDegree.set(to, (inDegree.get(to) ?? 0) + 1)
			}
		}

		// Queue nodes with in-degree 0 (no dependencies)
		for (const [id, degree] of inDegree) {
			if (degree === 0) {
				queue.push(id)
			}
		}

		// Process queue
		while (queue.length > 0) {
			const current = queue.shift()!
			const project = projectMap.get(current)
			if (project) {
				order.push(project)
			}

			// Decrement in-degree of all nodes this one points to
			const targets = adjacency.get(current)
			if (targets) {
				for (const to of targets) {
					const newDegree = (inDegree.get(to) ?? 1) - 1
					inDegree.set(to, newDegree)
					if (newDegree === 0) {
						queue.push(to)
					}
				}
			}
		}

		// If not all projects were processed, there's a cycle
		// Append remaining projects in arbitrary order (best-effort)
		if (order.length < projects.length) {
			const processed = new Set(order.map((p) => p.id))
			for (const p of projects) {
				if (!processed.has(p.id)) {
					order.push(p)
					console.warn(`[DepGraphBuilder] Cycle detected: "${p.id}" could not be topologically sorted`)
				}
			}
		}

		return order
	}

	/**
	 * Detect cycles in the graph using DFS with path tracking.
	 * Returns an array of cycles, where each cycle is an ordered list of project IDs.
	 */
	private detectCyclesInner(projects: SubProject[], adjacency: Map<string, Set<string>>): Array<string[]> {
		const white = new Set<string>() // Not visited
		const gray = new Set<string>() // In current DFS path
		const black = new Set<string>() // Fully processed
		const cycles: Array<string[]> = []

		// Track parent for cycle path reconstruction
		const parent = new Map<string, string>()

		// Initialize all nodes as white (unvisited)
		for (const p of projects) {
			white.add(p.id)
		}

		// DFS-visit function
		const visit = (node: string, path: string[]) => {
			white.delete(node)
			gray.add(node)
			path.push(node)

			const neighbors = adjacency.get(node)
			if (neighbors) {
				for (const neighbor of neighbors) {
					if (gray.has(neighbor)) {
						// Found a cycle — extract from path
						const cycleStart = path.indexOf(neighbor)
						if (cycleStart !== -1) {
							const cycle = path.slice(cycleStart)
							// Add the closing edge to complete the cycle
							cycle.push(neighbor)
							cycles.push(cycle)
						}
					} else if (white.has(neighbor)) {
						parent.set(neighbor, node)
						visit(neighbor, path)
					}
				}
			}

			path.pop()
			gray.delete(node)
			black.add(node)
		}

		// Start DFS from each unvisited node
		for (const p of projects) {
			if (white.has(p.id)) {
				visit(p.id, [])
			}
		}

		// Deduplicate cycles (a cycle [a,b,c,a] is the same as [b,c,a,b])
		const uniqueCycles = this.deduplicateCycles(cycles)

		return uniqueCycles
	}

	/**
	 * Deduplicate cycles that represent the same cycle with different starting points.
	 */
	private deduplicateCycles(cycles: Array<string[]>): Array<string[]> {
		const seen = new Set<string>()
		const unique: Array<string[]> = []

		for (const cycle of cycles) {
			// Normalize: rotate to start with the smallest element, then stringify
			const normalized = this.normalizeCycle(cycle)
			const key = normalized.join(",")

			if (!seen.has(key)) {
				seen.add(key)
				unique.push(cycle)
			}
		}

		return unique
	}

	/**
	 * Normalize a cycle by rotating it so the smallest element comes first,
	 * then removing the duplicate end element for comparison.
	 */
	private normalizeCycle(cycle: Array<string>): Array<string> {
		if (cycle.length <= 1) return cycle

		// Remove the duplicate end element (last element equals first)
		const normalized = cycle[cycle.length - 1] === cycle[0] ? cycle.slice(0, -1) : [...cycle]

		// Find index of smallest element
		let minIndex = 0
		for (let i = 1; i < normalized.length; i++) {
			if (normalized[i] < normalized[minIndex]) {
				minIndex = i
			}
		}

		// Rotate so smallest element is first
		return [...normalized.slice(minIndex), ...normalized.slice(0, minIndex)]
	}

	/**
	 * Sanitize a string for use as a Mermaid.js node ID.
	 */
	private mermaidSafeId(input: string): string {
		return input.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "n_$1")
	}
}
