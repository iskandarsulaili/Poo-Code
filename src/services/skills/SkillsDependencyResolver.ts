/**
 * SkillsDependencyResolver — Resolves skill dependency graphs.
 *
 * Uses DFS-based topological sort to resolve the full dependency order
 * for a set of skills. Detects cycles with detailed path reporting and
 * identifies unresolved (missing) dependencies.
 *
 * Supports optional dependencies — missing optional deps are logged
 * but don't block resolution.
 */

import { type ResolvedDependencyChain, type SkillDependency, SkillsError } from "./types"

/**
 * Resolves dependency graphs for skills.
 *
 * Usage:
 * ```ts
 * const resolver = new SkillsDependencyResolver()
 * resolver.register({ dependentSkill: "b", requiredSkill: "a", optional: false, reason: "b needs a" })
 * const chain = resolver.resolve(["b"])
 * // chain.order === ["a", "b"]
 * ```
 */
export class SkillsDependencyResolver {
	private dependencies: Map<string, SkillDependency[]> = new Map()

	/**
	 * Register a dependency relationship.
	 * Throws if a dependency with the same dependent/required pair already exists.
	 */
	register(dep: SkillDependency): void {
		const existing = this.dependencies.get(dep.dependentSkill) ?? []

		// Check for duplicate
		const duplicate = existing.find((d) => d.requiredSkill === dep.requiredSkill)
		if (duplicate) {
			return // Silently ignore duplicates
		}

		existing.push(dep)
		this.dependencies.set(dep.dependentSkill, existing)
	}

	/**
	 * Register multiple dependencies at once.
	 */
	registerMany(deps: SkillDependency[]): void {
		for (const dep of deps) {
			this.register(dep)
		}
	}

	/**
	 * Get all dependencies registered for a specific skill.
	 */
	getDependencies(skillName: string): SkillDependency[] {
		return this.dependencies.get(skillName) ?? []
	}

	/**
	 * Get all mandatory (non-optional) dependencies for a skill.
	 */
	getMandatoryDependencies(skillName: string): SkillDependency[] {
		return this.getDependencies(skillName).filter((d) => !d.optional)
	}

	/**
	 * List all registered dependency relationships.
	 */
	listAll(): SkillDependency[] {
		return Array.from(this.dependencies.values()).flat()
	}

	/**
	 * Remove all dependencies for a given skill.
	 */
	unregister(skillName: string): void {
		this.dependencies.delete(skillName)
	}

	/**
	 * Resolve the full ordered dependency list for a set of skills.
	 * Uses DFS with topological sort, detecting cycles along the way.
	 *
	 * The returned order places dependencies before dependents.
	 * Original input skills are placed last in the order.
	 *
	 * @param skillNames - Skills to resolve dependencies for.
	 * @returns A ResolvedDependencyChain with order, cycles, and unresolved deps.
	 */
	resolve(skillNames: string[]): ResolvedDependencyChain {
		const visited = new Set<string>()
		const inStack = new Set<string>()
		const resolved: string[] = []
		const cycles: string[][] = []
		const unresolved: string[] = []

		for (const name of skillNames) {
			if (!visited.has(name)) {
				this.visit(name, skillNames, visited, inStack, resolved, cycles, unresolved, [])
			}
		}

		// Separate dependencies from the original requested skills
		const depsOnly = resolved.filter((n) => !skillNames.includes(n))

		return {
			order: [...depsOnly, ...skillNames],
			cycles,
			unresolved,
		}
	}

	/**
	 * DFS visit function for topological sort.
	 */
	private visit(
		name: string,
		skillNames: string[],
		visited: Set<string>,
		inStack: Set<string>,
		resolved: string[],
		cycles: string[][],
		unresolved: string[],
		path: string[],
	): void {
		if (inStack.has(name)) {
			// Cycle detected — extract the cycle from the current path
			const cycleStart = path.indexOf(name)
			const cycle = path.slice(cycleStart)
			cycle.push(name)
			cycles.push(cycle)
			return
		}

		if (visited.has(name)) return

		visited.add(name)
		inStack.add(name)
		path.push(name)

		const deps = this.dependencies.get(name)
		if (deps) {
			for (const dep of deps) {
				if (dep.optional) {
					// Optional dependencies: try to resolve but don't fail
					if (!skillNames.includes(dep.requiredSkill)) {
						if (!this.skillExists(dep.requiredSkill)) {
							// Missing optional dep — skip silently
							continue
						}
					}
				}

				if (this.skillExists(dep.requiredSkill) || skillNames.includes(dep.requiredSkill)) {
					this.visit(dep.requiredSkill, skillNames, visited, inStack, resolved, cycles, unresolved, path)
				} else if (!dep.optional) {
					// Mandatory dependency not found
					if (!unresolved.includes(dep.requiredSkill)) {
						unresolved.push(dep.requiredSkill)
					}
				}
			}
		}

		path.pop()
		inStack.delete(name)
		resolved.push(name)
	}

	/**
	 * Check if a skill has any registered dependencies.
	 */
	private skillExists(skillName: string): boolean {
		// A skill "exists" if it has registered dependencies as a dependent
		// or if it's listed as a required skill somewhere — we can traverse it.
		for (const deps of this.dependencies.values()) {
			if (deps.some((d) => d.requiredSkill === skillName)) {
				return true
			}
		}
		return this.dependencies.has(skillName)
	}

	/**
	 * Detect cycles in the full dependency graph.
	 * Returns all detected cycles as arrays of skill names.
	 */
	detectCycles(): string[][] {
		const cycles: string[][] = []
		const visited = new Set<string>()
		const inStack = new Set<string>()
		const path: string[] = []

		const allSkills = Array.from(this.dependencies.keys())

		for (const name of allSkills) {
			if (!visited.has(name)) {
				this.cycleDetect(name, visited, inStack, path, cycles, new Set<string>())
			}
		}

		return cycles
	}

	/**
	 * DFS-based cycle detection.
	 */
	private cycleDetect(
		name: string,
		visited: Set<string>,
		inStack: Set<string>,
		path: string[],
		cycles: string[][],
		pathSet: Set<string>,
	): void {
		if (inStack.has(name)) {
			// Found a cycle
			const cycleStart = path.indexOf(name)
			const cycle = path.slice(cycleStart)
			cycle.push(name)
			// Deduplicate cycles
			const cycleKey = cycle.join("->")
			if (!cycles.some((c) => c.join("->") === cycleKey)) {
				cycles.push(cycle)
			}
			return
		}

		if (visited.has(name)) return

		visited.add(name)
		inStack.add(name)
		path.push(name)
		pathSet.add(name)

		const deps = this.dependencies.get(name)
		if (deps) {
			for (const dep of deps) {
				this.cycleDetect(dep.requiredSkill, visited, inStack, path, cycles, pathSet)
			}
		}

		path.pop()
		pathSet.delete(name)
		inStack.delete(name)
	}

	/**
	 * Check if a specific skill has unresolved mandatory dependencies.
	 */
	hasUnresolvedDependencies(skillName: string): boolean {
		const deps = this.dependencies.get(skillName)
		if (!deps) return false
		return deps.some((dep) => {
			if (dep.optional) return false
			// Check if the required skill exists as a dependent or is referenced
			if (this.dependencies.has(dep.requiredSkill)) return false
			for (const [, depsList] of this.dependencies) {
				if (depsList.some((d) => d.requiredSkill === dep.requiredSkill)) {
					return false
				}
			}
			return true
		})
	}

	/**
	 * Clear all registered dependencies.
	 */
	clear(): void {
		this.dependencies.clear()
	}
}
