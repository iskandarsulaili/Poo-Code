import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "../../shared/tools"

type DelegateTaskParams = NativeToolArgs["delegate_task"]

export class DelegateTaskTool extends BaseTool<"delegate_task"> {
	readonly name = "delegate_task" as const

	async execute(params: DelegateTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		if (!params.goal) {
			task.consecutiveMistakeCount++
			task.recordToolError("delegate_task")
			pushToolResult("Error: goal is required")
			return
		}

		try {
			// Use the existing parallel subtask infrastructure
			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult("Error: No active provider")
				return
			}

			// Create a new task for the subagent
			const fullPrompt = params.context ? `${params.goal}\n\nContext: ${params.context}` : params.goal
			const newTask = await provider.createTask(fullPrompt)

			pushToolResult(
				`**Delegated task created** (ID: ${newTask.taskId})\n\nGoal: ${params.goal}\n\nThe subagent is working on this independently. Check back for results.`,
			)
		} catch (error) {
			await handleError("delegating task", error as Error)
		}
	}
}

export const delegateTaskTool = new DelegateTaskTool()
