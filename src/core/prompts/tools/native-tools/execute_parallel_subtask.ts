import type OpenAI from "openai"

const EXECUTE_PARALLEL_SUBTASK_DESCRIPTION = `Execute multiple subtasks in parallel with DAG-based dependency resolution, lock-aware scheduling, and blackboard communication.

This tool enables parallel execution of mode-specific subtasks with:
- **DAG-based dependencies**: Subtasks can depend on other subtasks via 'deps' array. The system builds a directed acyclic graph (DAG) and executes subtasks in waves based on dependency order.
- **Lock-aware scheduling**: Output files are locked during execution to prevent conflicts between concurrent subtasks.
- **Blackboard communication**: Subtasks can publish to and subscribe from topics for data exchange.
- **Per-subtask mode isolation**: Each subtask runs in its own mode (e.g., "code", "architect", "debug").

When to use this tool:
- Breaking a complex task into independent parallel work streams, accelerating overall execution
- When multiple files or modules can be worked on simultaneously
- Running code generation in one subtask while documentation is written in another
- Orchestrating multi-step workflows where some steps can run concurrently

The tool accepts a 'tasks' array where each task specifies:
- id: Unique identifier (referenced by deps in other tasks)
- name: Human-readable name for the task
- mode: The mode slug to execute this subtask in
- prompt: The actual instructions/prompt for the subtask
- inputFiles: Files this subtask reads
- outputFiles: Files this subtask writes (locked for write access)
- deps: IDs of tasks that must complete first
- requiredResources: Required resource identifiers
- subscribedTopics: Blackboard topics to subscribe to
- publishedTopics: Blackboard topics to publish to
- estimatedTokens: Approximate token consumption hint
- timeoutMs: Timeout per subtask in milliseconds (default: 300000)
- isCritical: If true, failure of this subtask fails the entire execution

Parameters:
- tasks: (required) Array of subtask definitions with dependencies
- maxParallel: (optional) Maximum parallel subtasks (default: 4)`

export default {
	type: "function",
	function: {
		name: "execute_parallel_subtask",
		description: EXECUTE_PARALLEL_SUBTASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					description: "Array of subtask definitions with dependencies",
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description: "Unique identifier for this subtask (referenced by deps in other tasks)",
							},
							name: {
								type: "string",
								description: "Human-readable name for the subtask",
							},
							mode: {
								type: "string",
								description: "Mode slug to execute this subtask in (e.g., code, debug, architect)",
							},
							prompt: {
								type: "string",
								description: "The actual instructions/prompt for the subtask",
							},
							inputFiles: {
								type: "array",
								items: { type: "string" },
								description: "Files this subtask reads",
							},
							outputFiles: {
								type: "array",
								items: { type: "string" },
								description: "Files this subtask writes (locked for write access)",
							},
							deps: {
								type: "array",
								items: { type: "string" },
								description: "IDs of tasks that must complete before this one starts",
							},
							requiredResources: {
								type: "array",
								items: { type: "string" },
								description: "Required resource identifiers",
							},
							subscribedTopics: {
								type: "array",
								items: { type: "string" },
								description: "Blackboard topics to subscribe to for data",
							},
							publishedTopics: {
								type: "array",
								items: { type: "string" },
								description: "Blackboard topics to publish data to",
							},
							estimatedTokens: {
								type: "number",
								description: "Approximate token consumption hint",
							},
							timeoutMs: {
								type: "number",
								description: "Timeout per subtask in milliseconds (default: 300000)",
							},
							isCritical: {
								type: "boolean",
								description: "If true, failure of this subtask fails the entire execution",
							},
						},
						required: [
							"id",
							"name",
							"mode",
							"prompt",
							"inputFiles",
							"outputFiles",
							"deps",
							"requiredResources",
							"subscribedTopics",
							"publishedTopics",
							"estimatedTokens",
							"timeoutMs",
							"isCritical",
						],
						additionalProperties: false,
					},
				},
				maxParallel: {
					type: ["number", "null"],
					description: "Maximum parallel subtasks (null for default which is typically 4)",
				},
			},
			required: ["tasks", "maxParallel"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
