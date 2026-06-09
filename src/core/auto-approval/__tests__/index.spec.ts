import { describe, it, expect, vi, beforeEach } from "vitest"
import { checkAutoApproval, type CheckAutoApprovalResult } from "../index"
import type { ClineAsk } from "@roo-code/types"

function createFollowupText(data: Record<string, any>): string {
	return JSON.stringify(data)
}

function makeState(overrides: Record<string, any> = {}): any {
	return {
		autoApprovalEnabled: true,
		alwaysAllowFollowupQuestions: true,
		followupAutoApproveTimeoutMs: 5000,
		...overrides,
	}
}

describe("checkAutoApproval — followup empty response guard", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns { decision: 'ask' } when suggestion has no answer field", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [{ mode: "code" }], // no answer field
			}),
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'ask' } when suggestion.answer is empty string", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [{ answer: "", mode: "code" }],
			}),
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'ask' } when suggestion.answer is whitespace-only", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [{ answer: "   " }],
			}),
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'ask' } when suggest array has all empty answers", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [{ answer: "" }, { answer: "   " }, { answer: "" }],
			}),
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'ask' } when suggest array is missing", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				// no suggest array
			}),
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'ask' } when suggest array is empty", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [],
			}),
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'ask' } when text is malformed JSON", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: "not-json-at-all",
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'ask' } when text is undefined", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: undefined,
		})
		expect(result.decision).toBe("ask")
	})

	it("returns { decision: 'timeout' } when suggestion has valid non-empty answer", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [{ answer: "Use the code mode to implement the feature" }],
			}),
		})
		expect(result.decision).toBe("timeout")
		if (result.decision === "timeout") {
			const response = result.fn()
			expect(response.askResponse).toBe("messageResponse")
			expect(response.text).toBe("Use the code mode to implement the feature")
		}
	})

	it("returns { decision: 'timeout' } with first non-empty answer when first suggestion has empty answer", async () => {
		const result = await checkAutoApproval({
			state: makeState(),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [{ answer: "" }, { answer: "  " }, { answer: "Use the code mode to implement the feature" }],
			}),
		})
		expect(result.decision).toBe("timeout")
		if (result.decision === "timeout") {
			const response = result.fn()
			expect(response.text).toBe("Use the code mode to implement the feature")
		}
	})

	it("returns { decision: 'ask' } when alwaysAllowFollowupQuestions is false", async () => {
		const result = await checkAutoApproval({
			state: makeState({ alwaysAllowFollowupQuestions: false }),
			ask: "followup" as ClineAsk,
			text: createFollowupText({
				question: "What should I do?",
				suggest: [{ answer: "Valid answer" }],
			}),
		})
		expect(result.decision).toBe("ask")
	})
})
