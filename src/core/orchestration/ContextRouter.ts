/**
 * Context Router — per-subtask context assembly and token budget allocation.
 *
 * Builds minimal context for each subtask by including only:
 * - The subtask's own prompt
 * - Input files (from inputFiles)
 * - Subscribed blackboard topics
 * - Mode definition
 *
 * Supports context diffing for incremental updates and multiple token
 * allocation strategies (equal, weighted, dynamic).
 *
 * @module
 */

import * as fs from "fs"

import type { SubtaskNode, SubtaskContext, ContextDiff } from "@roo-code/types"

import { Blackboard } from "./Blackboard"

// ============================================================================
// ContextRouter
// ============================================================================

/**
 * Assembles per-subtask context and manages token budget allocation.
 */
export class ContextRouter {
	private blackboard: Blackboard

	/**
	 * @param blackboard - Blackboard instance for reading subscribed topics
	 */
	constructor(blackboard: Blackboard) {
		this.blackboard = blackboard
	}

	/**
	 * Build a SubtaskContext for a given subtask.
	 *
	 * @param subtask - The subtask to build context for
	 * @returns Assembled SubtaskContext
	 */
	async buildContext(subtask: SubtaskNode): Promise<SubtaskContext> {
		console.log(`[ContextRouter] buildContext: subtask="${subtask.id}"`)

		// Read input files
		const fileContext: SubtaskContext["fileContext"] = []
		for (const filePath of subtask.inputFiles) {
			try {
				const content = await fs.promises.readFile(filePath, "utf-8")
				fileContext.push({
					path: filePath,
					content,
					format: "full",
				})
			} catch (error) {
				console.warn(`[ContextRouter] Could not read input file "${filePath}": ${error}`)
			}
		}

		// Read subscribed blackboard topics
		const blackboardContext: SubtaskContext["blackboardContext"] = []
		for (const topic of subtask.subscribedTopics) {
			try {
				const entry = await this.blackboard.getTopic(topic)
				if (entry) {
					blackboardContext.push({
						topic: entry.topic,
						data: entry.data,
						version: entry.version,
					})
				}
			} catch (error) {
				console.warn(`[ContextRouter] Could not read topic "${topic}": ${error}`)
			}
		}

		return {
			prompt: subtask.prompt,
			modeDefinition: {
				roleDefinition: `You are executing subtask "${subtask.name}" in mode "${subtask.mode}".`,
				customInstructions: subtask.prompt,
				groups: ["read", "write"],
			},
			fileContext,
			blackboardContext,
			globalAlignment: {
				architectureDecisions: [],
				namingConventions: [],
				sharedTypes: [],
			},
			tokenBudget: subtask.estimatedTokens || 8_000,
		}
	}

	/**
	 * Compute a diff between two SubtaskContext instances.
	 *
	 * @param previous - Previous context
	 * @param current - Current context
	 * @returns ContextDiff describing what changed
	 */
	diffContext(previous: SubtaskContext, current: SubtaskContext): ContextDiff {
		const prevFiles = new Set(previous.fileContext.map((f) => f.path))
		const currFiles = new Set(current.fileContext.map((f) => f.path))

		const added = current.fileContext.filter((f) => !prevFiles.has(f.path)).map((f) => f.path)
		const removed = previous.fileContext.filter((f) => !currFiles.has(f.path)).map((f) => f.path)

		const modified: string[] = []
		const unchanged: string[] = []

		for (const currFile of current.fileContext) {
			if (prevFiles.has(currFile.path)) {
				const prevFile = previous.fileContext.find((f) => f.path === currFile.path)
				if (prevFile && prevFile.content !== currFile.content) {
					modified.push(currFile.path)
				} else {
					unchanged.push(currFile.path)
				}
			}
		}

		return { added, removed, modified, unchanged }
	}

	/**
	 * Allocate token budget across subtasks using the specified strategy.
	 *
	 * @param subtasks - Array of subtasks to allocate tokens for
	 * @param totalBudget - Total token budget for all subtasks
	 * @param strategy - Allocation strategy: "equal", "weighted", or "dynamic"
	 * @returns Map of subtask ID → allocated token budget
	 */
	allocateTokenBudget(
		subtasks: SubtaskNode[],
		totalBudget: number,
		strategy: "equal" | "weighted" | "dynamic" = "equal",
	): Map<string, number> {
		const allocation = new Map<string, number>()

		if (subtasks.length === 0) {
			return allocation
		}

		switch (strategy) {
			case "equal": {
				const perSubtask = Math.floor(totalBudget / subtasks.length)
				for (const subtask of subtasks) {
					allocation.set(subtask.id, Math.max(perSubtask, 1_000))
				}
				break
			}

			case "weighted": {
				const totalEstimated = subtasks.reduce((sum, s) => sum + (s.estimatedTokens || 1), 0)
				for (const subtask of subtasks) {
					const weight = (subtask.estimatedTokens || 1) / totalEstimated
					const budget = Math.floor(totalBudget * weight)
					allocation.set(subtask.id, Math.max(budget, 1_000))
				}
				break
			}

			case "dynamic": {
				// Start with equal allocation, reserve 20% for reallocation
				const reserved = Math.floor(totalBudget * 0.2)
				const baseBudget = totalBudget - reserved
				const perSubtask = Math.floor(baseBudget / subtasks.length)

				for (const subtask of subtasks) {
					allocation.set(subtask.id, Math.max(perSubtask, 1_000))
				}

				// The reserved pool can be reallocated dynamically during execution
				// (handled by the orchestrator at runtime)
				break
			}
		}

		return allocation
	}
}
