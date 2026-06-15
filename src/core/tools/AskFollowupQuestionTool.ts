import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface Suggestion {
	text: string
	mode?: string
}

interface AskFollowupQuestionParams {
	question: string
	follow_up: Suggestion[]
}

export class AskFollowupQuestionTool extends BaseTool<"ask_followup_question"> {
	readonly name = "ask_followup_question" as const

	async execute(params: AskFollowupQuestionParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { question, follow_up } = params
		const { handleError, pushToolResult } = callbacks

		const recordMissingParamError = async (paramName: string): Promise<void> => {
			task.consecutiveMistakeCount++
			task.recordToolError("ask_followup_question")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("ask_followup_question", paramName))
		}

		try {
			if (!question) {
				await recordMissingParamError("question")
				return
			}

			if (!follow_up || !Array.isArray(follow_up)) {
				await recordMissingParamError("follow_up")
				return
			}

			// Transform follow_up suggestions to the format expected by task.ask
			const follow_up_json = {
				question,
				suggest: follow_up.map((s) => ({ answer: s.text, mode: s.mode })),
			}

			task.consecutiveMistakeCount = 0
			const { text, images } = await task.ask("followup", JSON.stringify(follow_up_json), false)
			// Ensure response text is never empty — use contextual fallback
			const safeText = (text ?? "").trim()
			if (!safeText) {
				// Fallback: first non-empty suggestion
				const validSuggestion = follow_up_json.suggest.find(
					(s: { answer: string; mode?: string }) => s.answer && s.answer.trim().length > 0,
				)
				const fallbackText = validSuggestion?.answer?.trim()
				if (fallbackText) {
					console.warn(
						`[AskFollowupQuestionTool] Empty user response, using first non-empty suggestion: "${fallbackText.substring(0, 60)}..."`,
					)
					await task.say("user_feedback", fallbackText, images)
					pushToolResult(formatResponse.toolResult(`<user_message>\n${fallbackText}\n</user_message>`, images))
					return
				}
				// No suggestion available either — use neutral fallback to avoid empty injection
				const neutralFallback = "I'll proceed without additional input."
				console.warn(
					`[AskFollowupQuestionTool] Empty user response and no valid suggestions, using neutral fallback`,
				)
				await task.say("user_feedback", neutralFallback, images)
				pushToolResult(formatResponse.toolResult(`<user_message>\n${neutralFallback}\n</user_message>`, images))
				return
			}
			await task.say("user_feedback", safeText, images)
			pushToolResult(formatResponse.toolResult(`<user_message>\n${safeText}\n</user_message>`, images))
		} catch (error) {
			await handleError("asking question", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"ask_followup_question">): Promise<void> {
		const question: string | undefined = block.nativeArgs?.question ?? block.params.question

		// During partial streaming, only show the question to avoid displaying raw JSON
		// The full JSON with suggestions will be sent when the tool call is complete (!block.partial)
		await task.ask("followup", question ?? "", block.partial).catch(() => {})
	}
}

export const askFollowupQuestionTool = new AskFollowupQuestionTool()
