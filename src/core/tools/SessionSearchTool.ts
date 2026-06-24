import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "../../shared/tools"
import { SearchIndex } from "../../services/search/SearchIndex"

type SessionSearchParams = NativeToolArgs["session_search"]

export class SessionSearchTool extends BaseTool<"session_search"> {
	readonly name = "session_search" as const

	async execute(params: SessionSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		if (!params.query) {
			task.consecutiveMistakeCount++
			task.recordToolError("session_search")
			pushToolResult("Error: query is required")
			return
		}

		try {
			const searchIndex = new SearchIndex()
			await searchIndex.initialize()

			const results = await searchIndex.search({
				query: params.query,
				mode: params.mode || "fulltext",
				limit: params.limit || 5,
			})

			if (results.length === 0) {
				pushToolResult(
					"No matching sessions found. Sessions are indexed from task history as tasks complete. If you haven't run any tasks yet, the index may be empty.",
				)
				return
			}

			const formatted = results
				.map((r, i) => {
					const ts = new Date(r.timestamp).toISOString().replace("T", " ").substring(0, 16)
					return `${i + 1}. [${ts}] (relevance: ${(r.relevance * 100).toFixed(0)}%)\n   ${r.snippet?.substring(0, 200)}${r.snippet?.length > 200 ? "..." : ""}${r.goal ? "\n   Goal: " + r.goal : ""}${r.resolution ? "\n   Resolution: " + r.resolution : ""}`
				})
				.join("\n\n")

			pushToolResult(`Found ${results.length} session(s):\n\n${formatted}`)
		} catch (error) {
			await handleError("searching sessions", error as Error)
		}
	}
}

export const sessionSearchTool = new SessionSearchTool()
