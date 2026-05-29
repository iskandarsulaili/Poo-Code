import type { Requirement, ConflictResolution, ConflictResolver } from "./types"
import type { ProviderSettings } from "@roo-code/types"
import { singleCompletionHandler } from "../../utils/single-completion-handler"

/**
 * LLM-based conflict resolver that uses the configured API provider
 * to determine if a new requirement supersedes existing ones.
 * Falls back to empty resolution on LLM call failure.
 */
export class LLMConflictResolver implements ConflictResolver {
	readonly name = "llm"

	constructor(
		private readonly apiConfiguration: ProviderSettings,
	) {}

	async resolve(
		newRequirement: Requirement,
		existingRequirements: Requirement[],
		newMessageIndex: number,
		allMessages: string[],
	): Promise<ConflictResolution> {
		// If no existing requirements, nothing to supersede
		if (existingRequirements.length === 0) {
			return { supersedes: [], confidence: 1.0, reason: "No existing requirements to compare" }
		}

		// Build context: show the most recent messages for context
		const recentMessages = allMessages
			.slice(Math.max(0, allMessages.length - 5))
			.map((m, i) => `[Message ${i + 1}]: ${m.slice(0, 200)}`)
			.join("\n\n")

		// Build the list of existing requirements for the LLM to compare
		const existingList = existingRequirements
			.map(
				(r, i) =>
					`[${i + 1}] ID: ${r.id}\n    Text: "${r.text}"\n    Category: ${r.category}\n    From message: ${r.messageIndex}`,
			)
			.join("\n\n")

		const prompt = `You are a requirements conflict resolution system. Your job is to determine if a NEW user requirement SUPERSEDES (replaces, overrides, or contradicts) any EXISTING requirements.

RULES:
- A later requirement supersedes an earlier one when they address the same feature, behavior, or constraint
- The most recent message has the HIGHEST priority — later instructions override earlier ones
- If the new requirement is about a completely different topic, it does NOT supersede anything
- If the new requirement explicitly contradicts an existing one (e.g., "don't do X" vs "do X"), it supersedes
- If the new requirement is a refinement or clarification of an existing one, it supersedes
- Return ONLY the IDs of existing requirements that are superseded

CONTEXT (recent user messages):
${recentMessages}

EXISTING REQUIREMENTS:
${existingList}

NEW REQUIREMENT (from message ${newMessageIndex}):
"${newRequirement.text}"
Category: ${newRequirement.category}

Does this new requirement supersede any of the existing requirements? Respond with a JSON object:
{
    "supersedes": ["id1", "id2"],
    "reason": "Brief explanation of the decision"
}

If none are superseded, return: { "supersedes": [], "reason": "No overlap detected" }`

		try {
			const response = await singleCompletionHandler(this.apiConfiguration, prompt)
			const parsed = this.parseResponse(response)
			return {
				supersedes: parsed.supersedes,
				confidence: parsed.supersedes.length > 0 ? 0.85 : 0.95,
				reason: parsed.reason || "LLM-based conflict analysis",
			}
		} catch (error) {
			// Fallback: if LLM call fails, don't supersede anything
			return {
				supersedes: [],
				confidence: 0,
				reason: `LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	private parseResponse(response: string): { supersedes: string[]; reason: string } {
		try {
			// Try to extract JSON from the response
			const jsonMatch = response.match(/\{[\s\S]*\}/)
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0])
				return {
					supersedes: Array.isArray(parsed.supersedes) ? parsed.supersedes : [],
					reason: typeof parsed.reason === "string" ? parsed.reason : "",
				}
			}
		} catch {
			// If parsing fails, return empty
		}
		return { supersedes: [], reason: "Failed to parse LLM response" }
	}
}
