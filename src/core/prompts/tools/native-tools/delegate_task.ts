import type OpenAI from "openai"

const DELEGATE_TASK_DESCRIPTION = `Delegate a task to a subagent that runs in an isolated context with its own conversation, terminal session, and toolset. The subagent works independently and returns a summary when done.

Use this when:
- A task is self-contained and can run independently (e.g., "research X and write to file Y")
- You need to work in parallel — delegate one task while working on another
- A task would flood your context with intermediate data

Parameters:
- goal: (required) What the subagent should accomplish. Be specific and self-contained.
- context: (optional) Background information, file paths, error messages, constraints
- toolsets: (optional) Toolsets to enable. Default: terminal, file, web`

const delegateTaskTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "delegate_task",
		description: DELEGATE_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				goal: {
					type: "string",
					description: "What the subagent should accomplish. Be specific and self-contained.",
				},
				context: {
					type: "string",
					description: "Background information: file paths, error messages, project structure, constraints",
				},
				toolsets: {
					type: "array",
					description: "Toolsets to enable (default: terminal, file, web)",
					items: { type: "string" },
				},
			},
			required: ["goal"],
			additionalProperties: false,
		},
	},
}

export default delegateTaskTool
