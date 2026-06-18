import type OpenAI from "openai"

const EXECUTE_PARALLEL_CHILD_TASK_DESCRIPTION = `Execute multiple child tasks in parallel with DAG-based dependency resolution, lock-aware scheduling, and blackboard communication.

This tool enables parallel execution of mode-specific child tasks with:
- **DAG-based dependencies**: Child tasks can depend on other child tasks via 'deps' array. The system builds a directed acyclic graph (DAG) and executes tasks in waves based on dependency order.
- **Lock-aware scheduling**: Output files are locked during execution to prevent conflicts between concurrent child tasks.
- **Blackboard communication**: Child tasks can subscribe to topics for data exchange.
- **Per-task mode isolation**: Each child task runs in its own mode (e.g., "code", "architect", "debug").

When to use this tool:
- Breaking a complex task into independent parallel work streams, accelerating overall execution
- When multiple files or modules can be worked on simultaneously
- Running code generation in one child task while documentation is written in another
- Orchestrating multi-step workflows where some steps can run concurrently

The tool accepts a 'tasks' array where each task specifies:
- id: Unique identifier (referenced by deps in other tasks)
- mode: The mode slug to execute this child task in
- message: The actual instructions/prompt for the child task
- todos: Optional initial todo list for the child task
- inputFiles: Files this child task reads
- outputFiles: Files this child task writes (locked for write access)
- deps: IDs of tasks that must complete first
- subscribedTopics: Blackboard topics to subscribe to

Parameters:
- tasks: (required) Array of child task definitions with dependencies
- maxParallel: (optional) Maximum parallel child tasks (default: 4)`

export default {
	type: "function",
	function: {
		name: "execute_parallel_child_task",
		description: EXECUTE_PARALLEL_CHILD_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					description: "Array of child task definitions with dependencies",
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description:
									"Unique identifier for this child task (referenced by deps in other tasks)",
							},
							mode: {
								type: "string",
								description: "Mode slug to execute this child task in (e.g., code, debug, architect)",
							},
							message: {
								type: "string",
								description: "The actual instructions/prompt for the child task",
							},
							todos: {
								type: "string",
								description:
									"Optional initial todo list for the child task (markdown checklist format)",
							},
							inputFiles: {
								type: "array",
								items: { type: "string" },
								description: "Files this child task reads",
							},
							outputFiles: {
								type: "array",
								items: { type: "string" },
								description: "Files this child task writes (locked for write access)",
							},
							deps: {
								type: "array",
								items: { type: "string" },
								description: "IDs of tasks that must complete before this one starts",
							},
							subscribedTopics: {
								type: "array",
								items: { type: "string" },
								description: "Blackboard topics to subscribe to for data",
							},
						},
						required: ["id", "mode", "message"],
						additionalProperties: false,
					},
				},
				maxParallel: {
					type: ["number", "null"],
					description: "Maximum parallel child tasks (null for default which is typically 4)",
				},
			},
			required: ["tasks", "maxParallel"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
