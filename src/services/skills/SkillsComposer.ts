/**
 * SkillsComposer — Chains skills together via composition.
 *
 * Supports three composition modes:
 * - **pipeline**: Sequential execution, each skill's output feeds the next via data flow mapping
 * - **inheritance**: Child skill extends parent — parent runs first, child runs with parent context
 * - **group**: Skills run independently in parallel, results merged at the end
 *
 * Each composition references skills by name. Actual skill execution is delegated
 * to a provided executor function.
 */

import {
	type CompositionContext,
	type CompositionMode,
	type CompositionResult,
	type DataFlowMapping,
	type SkillComposition,
	SkillsError,
} from "./types"

/**
 * Type for the skill executor function injected into the composer.
 * Implementers provide the actual skill execution logic.
 */
export type SkillExecutor = (skillName: string, context: CompositionContext) => Promise<Record<string, unknown>>

/**
 * Composes multiple skills into execution chains.
 */
export class SkillsComposer {
	private compositions: Map<string, SkillComposition> = new Map()
	private executor: SkillExecutor

	/**
	 * @param executor - Function that executes a single skill by name.
	 */
	constructor(executor?: SkillExecutor) {
		this.executor = executor ?? this.defaultExecutor
	}

	/**
	 * Set a custom executor (useful for dependency injection in tests).
	 */
	public setExecutor(executor: SkillExecutor): void {
		this.executor = executor
	}

	/**
	 * Default skill executor that throws — must be overridden in production.
	 */
	private async defaultExecutor(skillName: string, _context: CompositionContext): Promise<Record<string, unknown>> {
		throw new SkillsError(`No skill executor provided — cannot execute "${skillName}"`, "CHAIN_EXECUTION_FAILED")
	}

	/**
	 * Register a composition.
	 */
	register(composition: SkillComposition): void {
		if (this.compositions.has(composition.id)) {
			throw new SkillsError(`Composition "${composition.id}" already registered`, "COMPOSITION_NOT_FOUND")
		}
		this.compositions.set(composition.id, composition)
	}

	/**
	 * Unregister a composition by ID.
	 */
	unregister(compositionId: string): boolean {
		return this.compositions.delete(compositionId)
	}

	/**
	 * Get a registered composition by ID.
	 */
	getComposition(compositionId: string): SkillComposition | undefined {
		return this.compositions.get(compositionId)
	}

	/**
	 * List all registered compositions.
	 */
	listCompositions(): SkillComposition[] {
		return Array.from(this.compositions.values())
	}

	/**
	 * Execute a composition by chaining skills according to its mode.
	 *
	 * @param compositionId - ID of the composition to execute.
	 * @param initialInputs - Optional initial inputs passed to the first skill.
	 * @returns CompositionResult with per-skill results and any errors.
	 */
	async execute(compositionId: string, initialInputs?: Record<string, unknown>): Promise<CompositionResult> {
		const composition = this.compositions.get(compositionId)
		if (!composition) {
			throw new SkillsError(`Composition "${compositionId}" not found`, "COMPOSITION_NOT_FOUND")
		}

		const startTime = Date.now()
		const skillResults: Record<string, unknown> = {}
		const errors: Record<string, string> = {}

		try {
			switch (composition.mode) {
				case "pipeline":
					await this.executePipeline(composition, skillResults, errors, initialInputs)
					break
				case "inheritance":
					await this.executeInheritance(composition, skillResults, errors, initialInputs)
					break
				case "group":
					await this.executeGroup(composition, skillResults, errors, initialInputs)
					break
				default:
					throw new SkillsError(`Unknown composition mode: ${composition.mode}`, "CHAIN_EXECUTION_FAILED")
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			// If an unhandled error escapes, record it against the chain
			if (Object.keys(errors).length === 0) {
				errors["_chain"] = message
			}
		}

		const durationMs = Date.now() - startTime
		const success = Object.keys(errors).length === 0

		return {
			compositionId,
			success,
			skillResults,
			errors,
			durationMs,
		}
	}

	/**
	 * Pipeline execution: skills run sequentially, each skill's output is
	 * mapped as input to the next via dataFlow mappings.
	 */
	private async executePipeline(
		composition: SkillComposition,
		skillResults: Record<string, unknown>,
		errors: Record<string, string>,
		initialInputs?: Record<string, unknown>,
	): Promise<void> {
		const maxIndex = composition.skillChain.length - 1

		for (let i = 0; i <= maxIndex; i++) {
			const skillName = composition.skillChain[i]

			try {
				const context: CompositionContext = {
					upstreamOutputs: { ...initialInputs, ...skillResults },
					composition,
					currentIndex: i,
				}

				// Apply data flow mapping for this skill
				this.applyDataFlowIncoming(composition, skillName, context)

				const result = await this.executor(skillName, context)
				skillResults[skillName] = result
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				errors[skillName] = message
				if (composition.stopOnFailure) {
					return // Stop execution
				}
			}
		}
	}

	/**
	 * Inheritance execution: parent skills (earlier in chain) run first,
	 * child skills (later) receive full parent context.
	 * This is like pipeline but with full context inheritance rather than
	 * selective data flow mapping.
	 */
	private async executeInheritance(
		composition: SkillComposition,
		skillResults: Record<string, unknown>,
		errors: Record<string, string>,
		initialInputs?: Record<string, unknown>,
	): Promise<void> {
		const maxIndex = composition.skillChain.length - 1

		for (let i = 0; i <= maxIndex; i++) {
			const skillName = composition.skillChain[i]

			try {
				const context: CompositionContext = {
					// Inheritance: ALL upstream results are passed, not just mapped ones
					upstreamOutputs: { ...initialInputs, ...skillResults },
					composition,
					currentIndex: i,
				}

				const result = await this.executor(skillName, context)
				skillResults[skillName] = result
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				errors[skillName] = message
				if (composition.stopOnFailure) {
					return
				}
			}
		}
	}

	/**
	 * Group execution: all skills run independently in parallel.
	 * Results are merged at the end.
	 */
	private async executeGroup(
		composition: SkillComposition,
		skillResults: Record<string, unknown>,
		errors: Record<string, string>,
		initialInputs?: Record<string, unknown>,
	): Promise<void> {
		const tasks = composition.skillChain.map(async (skillName) => {
			try {
				const context: CompositionContext = {
					upstreamOutputs: initialInputs ?? {},
					composition,
					currentIndex: composition.skillChain.indexOf(skillName),
				}
				const result = await this.executor(skillName, context)
				skillResults[skillName] = result
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				errors[skillName] = message
			}
		})

		await Promise.all(tasks)
	}

	/**
	 * Apply incoming data flow mappings for a skill.
	 * Maps upstream outputs to expected inputs based on the composition's dataFlow.
	 */
	private applyDataFlowIncoming(composition: SkillComposition, skillName: string, context: CompositionContext): void {
		if (!composition.dataFlow) return

		const incomingMappings = composition.dataFlow.filter((df: DataFlowMapping) => df.toSkill === skillName)

		for (const mapping of incomingMappings) {
			const upstreamResult = context.upstreamOutputs[mapping.fromSkill]

			if (upstreamResult === undefined) continue

			// Apply each key mapping
			for (const [outputKey, inputKey] of Object.entries(mapping.mapping)) {
				const upstreamObj = upstreamResult as Record<string, unknown>
				if (upstreamObj && typeof upstreamObj === "object" && outputKey in upstreamObj) {
					context.upstreamOutputs[inputKey] = upstreamObj[outputKey]
				}
			}
		}
	}
}
