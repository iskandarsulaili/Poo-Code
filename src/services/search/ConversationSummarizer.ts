import { CodeChange, ConversationSummary, Decision, Message, SessionSummary } from "./types"

/**
 * ConversationSummarizer — condenses conversation history into key points.
 *
 * Extracts decisions, code changes, and unresolved items from message streams.
 * Generates full session summaries with goal/resolution bookends.
 */
export class ConversationSummarizer {
	/**
	 * Summarize a conversation into key points.
	 *
	 * @param messages - Ordered array of conversation messages
	 * @returns Condensed conversation summary
	 */
	summarizeConversation(messages: Message[]): ConversationSummary {
		const keyPoints = this.extractKeyPoints(messages)
		const decisions = this.extractKeyDecisions(messages)
		const codeChanges = this.extractCodeChanges(messages)
		const unresolvedItems = this.extractUnresolvedItems(messages)

		return {
			keyPoints,
			decisions,
			codeChanges,
			unresolvedItems,
		}
	}

	/**
	 * Extract key decisions made during the conversation.
	 *
	 * Identifies lines containing decision-related language from assistant messages.
	 */
	extractKeyDecisions(messages: Message[]): Decision[] {
		const decisions: Decision[] = []
		const decisionPatterns = [
			/i (decided|chose|opted|selected|will use|will implement)/i,
			/we should (use|implement|adopt|follow)/i,
			/the best approach is/i,
			/i recommend (using|implementing|adopting)/i,
			/let's (use|go with|implement|try)/i,
		]

		for (const msg of messages) {
			if (msg.role !== "assistant") continue

			const lines = msg.content.split("\n")
			for (const line of lines) {
				const trimmed = line.trim()
				if (trimmed.length < 15) continue

				const matched = decisionPatterns.some((p) => p.test(trimmed))
				if (matched) {
					decisions.push({
						description: trimmed.slice(0, 200),
						rationale: this.extractRationale(lines, lines.indexOf(line)),
						timestamp: msg.timestamp,
					})
				}
			}
		}

		return decisions
	}

	/**
	 * Extract file changes made during the conversation.
	 *
	 * Scans for file operation mentions in assistant and tool messages.
	 */
	extractCodeChanges(messages: Message[]): CodeChange[] {
		const changes: CodeChange[] = []
		const seenFiles = new Set<string>()

		// Patterns: "Created file X", "Modified Y", "Updated Z"
		const changePatterns = [
			{
				pattern: /(?:created|wrote|added)\s+(?:file\s+)?`?([^\s`]+)`?/i,
				type: "added" as const,
			},
			{
				pattern: /(?:modified|updated|changed|edited)\s+(?:file\s+)?`?([^\s`]+)`?/i,
				type: "modified" as const,
			},
			{
				pattern: /(?:deleted|removed)\s+(?:file\s+)?`?([^\s`]+)`?/i,
				type: "deleted" as const,
			},
			{
				pattern: /(?:refactored|reorganized|restructured)\s+(?:file\s+)?`?([^\s`]+)`?/i,
				type: "refactored" as const,
			},
		]

		for (const msg of messages) {
			if (msg.role !== "assistant" && msg.role !== "tool") continue

			for (const { pattern, type } of changePatterns) {
				const match = msg.content.match(pattern)
				if (match) {
					const filePath = match[1].replace(/`/g, "")
					if (!seenFiles.has(filePath)) {
						seenFiles.add(filePath)
						changes.push({
							filePath,
							changeType: type,
							summary: match[0].slice(0, 150),
						})
					}
				}
			}
		}

		return changes
	}

	/**
	 * Generate a full session summary.
	 */
	generateSessionSummary(sessionId: string, messages: Message[]): SessionSummary {
		if (messages.length === 0) {
			return {
				sessionId,
				goal: "",
				resolution: "",
				conversationSummary: {
					keyPoints: [],
					decisions: [],
					codeChanges: [],
					unresolvedItems: [],
				},
				startTime: Date.now(),
				endTime: Date.now(),
				messageCount: 0,
				durationMs: 0,
			}
		}

		const firstUserMsg = messages.find((m) => m.role === "user")
		const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant")
		const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp)

		const goal = firstUserMsg ? firstUserMsg.content.slice(0, 200) : ""
		const resolution = lastAssistantMsg ? lastAssistantMsg.content.slice(0, 200) : ""

		return {
			sessionId,
			goal,
			resolution,
			conversationSummary: this.summarizeConversation(messages),
			startTime: sorted[0].timestamp,
			endTime: sorted[sorted.length - 1].timestamp,
			messageCount: messages.length,
			durationMs: sorted[sorted.length - 1].timestamp - sorted[0].timestamp,
		}
	}

	/**
	 * Extract key points from conversation messages.
	 */
	private extractKeyPoints(messages: Message[]): string[] {
		const keyPoints: string[] = []

		for (const msg of messages) {
			if (msg.role !== "assistant") continue

			// Extract bullet points and numbered lists
			const lines = msg.content.split("\n")
			for (const line of lines) {
				const trimmed = line.trim()

				// Match bullet points, numbered items, and summary statements
				if (/^[-*•]\s+.{10,}/.test(trimmed)) {
					keyPoints.push(trimmed.replace(/^[-*•]\s+/, "").slice(0, 200))
				} else if (/^\d+[.)]\s+.{10,}/.test(trimmed)) {
					keyPoints.push(trimmed.replace(/^\d+[.)]\s+/, "").slice(0, 200))
				} else if (/^(summary|overview|conclusion):/i.test(trimmed)) {
					keyPoints.push(trimmed.slice(0, 200))
				}
			}
		}

		// Deduplicate and limit
		return [...new Set(keyPoints)].slice(0, 20)
	}

	/**
	 * Extract unresolved items or open questions.
	 */
	private extractUnresolvedItems(messages: Message[]): string[] {
		const unresolved: string[] = []
		const patterns = [
			/(?:still\s+)?(?:open|unresolved|remaining|todo|to do|not yet|left to)/i,
			/(?:need|needs|required)\s+to\s+(?:be\s+)?(?:done|addressed|fixed|implemented|resolved)/i,
			/future\s+(?:work|improvement|enhancement|todo)/i,
		]

		for (const msg of messages) {
			if (msg.role !== "assistant") continue

			const lines = msg.content.split("\n")
			for (const line of lines) {
				const trimmed = line.trim()
				if (trimmed.length < 15) continue

				if (patterns.some((p) => p.test(trimmed))) {
					unresolved.push(trimmed.slice(0, 200))
				}
			}
		}

		return [...new Set(unresolved)].slice(0, 10)
	}

	/**
	 * Extract rationale for a decision from surrounding context.
	 */
	private extractRationale(lines: string[], decisionLineIdx: number): string {
		// Look 2-3 lines after the decision for rationale
		const contextLines = lines.slice(decisionLineIdx + 1, decisionLineIdx + 4)
		const rationale = contextLines
			.filter(
				(l) =>
					/(because|since|as|due to|this means|this allows|this ensures|this provides)/i.test(l) ||
					l.trim().length > 20,
			)
			.join(" ")
			.trim()

		return rationale.slice(0, 200) || "No explicit rationale provided"
	}
}
