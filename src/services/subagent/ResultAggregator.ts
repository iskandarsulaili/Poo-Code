import type {
	SubagentResult,
	AggregatedResult,
	ConflictReport,
	ConflictResolution,
	ExecutionSummary,
	FileChange,
} from "./types"

/**
 * Aggregates results from multiple subagents into a single coherent output.
 *
 * Handles:
 * - Merging outputs from parallel subagents
 * - Detecting file conflicts (same file edited by multiple subagents)
 * - Resolving conflicts via last-writer-wins or merge-with-markers
 * - Ordering outputs chronologically
 *
 * @example
 * ```ts
 * const aggregated = ResultAggregator.aggregate(results)
 * if (aggregated.conflicts?.length) {
 *   console.warn(`Resolved ${aggregated.conflicts.length} conflicts`)
 * }
 * ```
 */
export class ResultAggregator {
	/**
	 * Merge multiple subagent results into a single AggregatedResult.
	 *
	 * Strategy:
	 * 1. Detect conflicts (same file modified by >1 subagent)
	 * 2. Resolve conflicts deterministically
	 * 3. Merge outputs in execution order
	 * 4. Collect warnings for any issues
	 *
	 * @param results - Array of SubagentResult to aggregate
	 * @returns AggregatedResult with merged output and conflict reports
	 */
	static aggregate(results: SubagentResult[]): AggregatedResult {
		if (results.length === 0) {
			return {
				success: true,
				mergedOutput: "",
				executionSummary: {
					totalSubagents: 0,
					succeeded: 0,
					failed: 0,
					timedOut: 0,
					cancelled: 0,
					totalExecutionTimeMs: 0,
				},
			}
		}

		const conflicts = this.detectConflicts(results)
		const resolvedConflicts = this.resolveConflicts(results, conflicts)
		const mergedOutput = this.mergeOutputs(results)
		const warnings = this.collectWarnings(results, resolvedConflicts)
		const executionSummary = this.buildExecutionSummary(results)

		const allSucceeded = results.every((r) => r.success)

		return {
			success: allSucceeded,
			mergedOutput,
			conflicts: resolvedConflicts,
			warnings: warnings.length > 0 ? warnings : undefined,
			executionSummary,
		}
	}

	/**
	 * Detect conflicts between parallel subagent results.
	 *
	 * Specifically looks for:
	 * - File conflicts: same file modified by multiple subagents
	 * - Dependency conflicts: subagents have incompatible output
	 * - Output ordering: important for chronological correctness
	 *
	 * @param results - Subagent results to scan
	 * @returns Array of detected conflict reports
	 */
	static detectConflicts(results: SubagentResult[]): ConflictReport[] {
		const conflicts: ConflictReport[] = []

		// File conflict detection
		const fileEdits = new Map<string, string[]>()
		for (const result of results) {
			for (const file of result.filesModified) {
				const editors = fileEdits.get(file) ?? []
				editors.push(result.subagentId)
				fileEdits.set(file, editors)
			}
		}

		for (const [filePath, editors] of fileEdits) {
			if (editors.length > 1) {
				conflicts.push({
					type: "file",
					description: `File "${filePath}" was modified by multiple subagents: ${editors.join(", ")}`,
					involvedIds: editors,
					resolution: { strategy: "last_writer_wins", winnerId: editors[editors.length - 1] },
				})
			}
		}

		// Dependency output conflict detection
		const outputOverlap = this.detectOutputOverlap(results)
		conflicts.push(...outputOverlap)

		return conflicts
	}

	/**
	 * Resolve detected conflicts deterministically.
	 *
	 * @param results - The original results (for context)
	 * @param conflicts - Detected conflicts to resolve
	 * @returns Resolved conflict reports with resolution strategies applied
	 */
	static resolveConflicts(results: SubagentResult[], conflicts: ConflictReport[]): ConflictReport[] {
		if (conflicts.length === 0) {
			return []
		}

		const idOrder = results.map((r) => r.subagentId)
		const idIndex = new Map<string, number>()
		idOrder.forEach((id, i) => idIndex.set(id, i))

		return conflicts.map((conflict) => {
			switch (conflict.type) {
				case "file": {
					// Last-writer-wins: pick the subagent that ran last
					const sorted = [...conflict.involvedIds].sort(
						(a, b) => (idIndex.get(b) ?? 0) - (idIndex.get(a) ?? 0),
					)
					return {
						...conflict,
						resolution: {
							strategy: "last_writer_wins" as const,
							winnerId: sorted[0],
						},
					}
				}
				case "dependency": {
					return {
						...conflict,
						resolution: {
							strategy: "manual_review_required" as const,
						},
					}
				}
				default: {
					return {
						...conflict,
						resolution: {
							strategy: "merge_with_markers" as const,
						},
					}
				}
			}
		})
	}

	/**
	 * Merge subagent outputs into a single ordered string.
	 *
	 * Results are concatenated in input order with clear section
	 * headers identifying which subagent produced which output.
	 *
	 * @param results - Results to merge
	 * @returns Merged output string
	 */
	static mergeOutputs(results: SubagentResult[]): string {
		if (results.length === 1 && results[0].success) {
			return results[0].output
		}

		const sections: string[] = []
		for (const result of results) {
			if (!result.output) {
				continue
			}

			if (results.length > 1) {
				sections.push(`--- Subagent: ${result.subagentId} ---`, result.output)
			} else {
				sections.push(result.output)
			}
		}

		return sections.join("\n\n")
	}

	/**
	 * Detect overlapping/wasteful output between subagents.
	 */
	private static detectOutputOverlap(results: SubagentResult[]): ConflictReport[] {
		const conflicts: ConflictReport[] = []

		// Detect output overlap — subagents that produced very similar outputs
		for (let i = 0; i < results.length; i++) {
			for (let j = i + 1; j < results.length; j++) {
				const a = results[i].output.trim()
				const b = results[j].output.trim()

				if (a.length > 50 && b.length > 50) {
					// Check for significant overlap (short-circuit on empty)
					const overlapRatio = this.computeOverlapRatio(a, b)
					if (overlapRatio > 0.7) {
						conflicts.push({
							type: "output",
							description: `Subagents "${results[i].subagentId}" and "${results[j].subagentId}" produced >70% overlapping output`,
							involvedIds: [results[i].subagentId, results[j].subagentId],
							resolution: { strategy: "last_writer_wins", winnerId: results[j].subagentId },
						})
					}
				}
			}
		}

		return conflicts
	}

	/**
	 * Compute a simple overlap ratio between two strings.
	 * Uses set intersection of word tokens divided by set union.
	 */
	private static computeOverlapRatio(a: string, b: string): number {
		const tokenize = (s: string): Set<string> =>
			new Set(
				s
					.toLowerCase()
					.split(/[^a-z0-9]+/)
					.filter((t) => t.length > 2),
			)

		const tokensA = tokenize(a)
		const tokensB = tokenize(b)

		if (tokensA.size === 0 || tokensB.size === 0) {
			return 0
		}

		let intersection = 0
		for (const token of tokensA) {
			if (tokensB.has(token)) {
				intersection++
			}
		}

		const union = new Set([...tokensA, ...tokensB])
		return intersection / union.size
	}

	/**
	 * Collect warnings from results and conflict resolution.
	 */
	private static collectWarnings(results: SubagentResult[], resolvedConflicts: ConflictReport[]): string[] {
		const warnings: string[] = []

		// Warnings from failed subagents
		for (const result of results) {
			if (!result.success) {
				warnings.push(`Subagent ${result.subagentId} failed: ${(result.errors ?? []).join("; ")}`)
			}
		}

		// Warnings from unresolved conflicts
		for (const conflict of resolvedConflicts) {
			if (conflict.resolution.strategy === "manual_review_required") {
				warnings.push(`Manual review required: ${conflict.description}`)
			}
		}

		return warnings
	}

	/**
	 * Build an execution summary from results.
	 */
	private static buildExecutionSummary(results: SubagentResult[]): ExecutionSummary {
		let succeeded = 0
		let failed = 0
		let timedOut = 0
		let cancelled = 0
		let totalTime = 0

		for (const result of results) {
			if (result.success) {
				succeeded++
			} else {
				failed++
			}
			totalTime += result.executionTimeMs
			// Note: timedOut and cancelled aren't directly encoded in SubagentResult
			// success=false; tracked via SubagentManager's entry status
		}

		return {
			totalSubagents: results.length,
			succeeded,
			failed,
			timedOut,
			cancelled,
			totalExecutionTimeMs: totalTime,
		}
	}

	/**
	 * Identify file-level conflicts from a set of file changes.
	 * Used internally to provide detailed conflict context by file.
	 *
	 * @param changesBySubagent - Map of subagentId to its file changes
	 * @returns Detailed conflict reports by file
	 */
	static detectFileConflicts(changesBySubagent: Map<string, FileChange[]>): ConflictReport[] {
		const conflicts: ConflictReport[] = []
		const fileChanges = new Map<string, Array<{ subagentId: string; change: FileChange }>>()

		for (const [subagentId, changes] of changesBySubagent) {
			for (const change of changes) {
				const entries = fileChanges.get(change.filePath) ?? []
				entries.push({ subagentId, change })
				fileChanges.set(change.filePath, entries)
			}
		}

		for (const [filePath, entries] of fileChanges) {
			if (entries.length > 1) {
				const actions = entries.map((e) => `${e.subagentId}:${e.change.action}`)
				conflicts.push({
					type: "file",
					description: `Concurrent edits to "${filePath}": ${actions.join(", ")}`,
					involvedIds: entries.map((e) => e.subagentId),
					resolution: {
						strategy: "last_writer_wins",
						winnerId: entries[entries.length - 1].subagentId,
					},
				})
			}
		}

		return conflicts
	}
}
