import type OpenAI from "openai"

const CODE_EXECUTION_DESCRIPTION = `Execute Python code in a sandboxed environment. The code runs in an isolated process with no network access and limited filesystem access. Use this for data processing, analysis, or quick computations that don't need shell access.

The sandbox provides:
- Python standard library (json, re, math, csv, datetime, collections, etc.)
- No network access
- No access to sensitive files outside the workspace
- 5-minute timeout
- 50KB stdout cap

Parameters:
- code: (required) Python code to execute
- timeout: (optional) Timeout in seconds (default 30, max 300)`

const codeExecutionTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "code_execution",
		description: CODE_EXECUTION_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				code: {
					type: "string",
					description: "Python code to execute in the sandbox",
				},
				timeout: {
					type: "number",
					description: "Timeout in seconds (default 30, max 300)",
				},
			},
			required: ["code"],
			additionalProperties: false,
		},
	},
}

export default codeExecutionTool
