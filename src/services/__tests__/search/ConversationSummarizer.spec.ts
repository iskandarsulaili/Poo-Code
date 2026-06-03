import { describe, it, expect } from "vitest"
import { ConversationSummarizer } from "../../search/ConversationSummarizer"
import { Message } from "../../search/types"

describe("ConversationSummarizer", () => {
	const summarizer = new ConversationSummarizer()

	describe("summarizeConversation", () => {
		it("should produce summary with key points from messages", () => {
			const messages: Message[] = [
				{ role: "user", content: "Fix the login bug", timestamp: 1000 },
				{ role: "assistant", content: "I will use input validation", timestamp: 2000 },
				{ role: "tool", content: "Modified login.ts", timestamp: 3000 },
				{ role: "assistant", content: "The bug is now fixed", timestamp: 4000 },
			]
			const summary = summarizer.summarizeConversation(messages)
			expect(summary.keyPoints).toBeDefined()
			expect(summary.decisions).toBeDefined()
			expect(summary.codeChanges).toBeDefined()
			expect(summary.unresolvedItems).toBeDefined()
		})

		it("should handle empty messages", () => {
			const summary = summarizer.summarizeConversation([])
			expect(summary.keyPoints).toEqual([])
			expect(summary.decisions).toEqual([])
			expect(summary.codeChanges).toEqual([])
			expect(summary.unresolvedItems).toEqual([])
		})
	})

	describe("extractKeyDecisions", () => {
		it("should extract decisions from assistant messages", () => {
			const messages: Message[] = [
				{ role: "user", content: "How should we handle errors?", timestamp: 1000 },
				{
					role: "assistant",
					content:
						"I decided to use Result type for error handling. The best approach is to wrap all async calls.",
					timestamp: 2000,
				},
			]
			const decisions = summarizer.extractKeyDecisions(messages)
			expect(decisions.length).toBeGreaterThanOrEqual(1)
			expect(decisions.some((d) => d.description.includes("Result type"))).toBe(true)
		})

		it("should not extract decisions from user messages", () => {
			const messages: Message[] = [{ role: "user", content: "I decided to refactor everything", timestamp: 1000 }]
			const decisions = summarizer.extractKeyDecisions(messages)
			expect(decisions).toEqual([])
		})

		it("should extract rationale alongside decision", () => {
			const messages: Message[] = [
				{
					role: "assistant",
					content: [
						"I decided to use React Query.",
						"This is better than Redux for this use case.",
						"Redux adds too much boilerplate.",
					].join("\n"),
					timestamp: 1000,
				},
			]
			const decisions = summarizer.extractKeyDecisions(messages)
			expect(decisions.length).toBeGreaterThanOrEqual(1)
			expect(decisions[0].rationale).toBeTruthy()
		})
	})

	describe("extractCodeChanges", () => {
		it("should extract file changes from assistant messages", () => {
			const messages: Message[] = [
				{
					role: "assistant",
					content: "Created file `src/auth.ts` and modified `src/config.ts`",
					timestamp: 1000,
				},
			]
			const changes = summarizer.extractCodeChanges(messages)
			expect(changes.length).toBeGreaterThanOrEqual(1)
			expect(changes.some((c) => c.filePath.includes("auth.ts"))).toBe(true)
		})

		it("should deduplicate same file mentioned multiple times", () => {
			const messages: Message[] = [
				{ role: "assistant", content: "Created file `src/app.ts`", timestamp: 1000 },
				{ role: "tool", content: "Modified `src/app.ts`", timestamp: 2000 },
			]
			const changes = summarizer.extractCodeChanges(messages)
			const appChanges = changes.filter((c) => c.filePath.includes("app.ts"))
			expect(appChanges.length).toBe(1)
		})
	})

	describe("extractUnresolvedItems", () => {
		it("should extract TODO items from assistant messages", () => {
			const messages: Message[] = [
				{
					role: "assistant",
					content: "TODO: Add error handling. FIXME: Optimize query. Also need to add tests later.",
					timestamp: 1000,
				},
			]
			const items = summarizer.extractUnresolvedItems(messages)
			expect(items.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe("generateSessionSummary", () => {
		it("should generate a comprehensive session summary", () => {
			const messages: Message[] = [
				{ role: "user", content: "Help me build an API", timestamp: 1000 },
				{ role: "assistant", content: "I decided to use Express.js", timestamp: 2000 },
				{ role: "tool", content: "Created file `src/server.ts`", timestamp: 3000 },
				{ role: "assistant", content: "The API is complete and working", timestamp: 4000 },
			]
			const summary = summarizer.generateSessionSummary("session-1", messages)
			expect(summary.sessionId).toBe("session-1")
			expect(summary.messageCount).toBe(4)
			expect(summary.durationMs).toBeGreaterThan(0)
		})

		it("should handle empty messages list", () => {
			const summary = summarizer.generateSessionSummary("session-empty", [])
			expect(summary.sessionId).toBe("session-empty")
			expect(summary.messageCount).toBe(0)
		})
	})
})
