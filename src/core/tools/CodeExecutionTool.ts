import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "../../shared/tools"
import { CodeSandbox } from "../../services/sandbox/CodeSandbox"

type CodeExecutionParams = NativeToolArgs["code_execution"]

export class CodeExecutionTool extends BaseTool<"code_execution"> {
	readonly name = "code_execution" as const

	async execute(params: CodeExecutionParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		if (!params.code) {
			task.consecutiveMistakeCount++
			task.recordToolError("code_execution")
			pushToolResult("Error: code is required")
			return
		}

		try {
			const sandbox = new CodeSandbox()
			const result = await sandbox.execute(params.code, params.timeout || 30)

			if (result.exitCode !== 0) {
				pushToolResult(`Exit code: ${result.exitCode}\n\n${result.stderr || result.stdout}`)
			} else {
				pushToolResult(result.stdout || "(no output)")
			}
		} catch (error) {
			await handleError("executing code", error as Error)
		}
	}
}

export const codeExecutionTool = new CodeExecutionTool()
