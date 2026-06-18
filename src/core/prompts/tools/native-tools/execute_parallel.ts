import type OpenAI from "openai"

const EXECUTE_PARALLEL_DESCRIPTION = `Execute multiple shell commands concurrently across independent sub-projects or tasks. This tool dramatically reduces wall-clock time compared to running commands one at a time with execute_command.

When to use this tool:
- Building, linting, or testing multiple independent projects at the same time
- Running type-check (tsc --noEmit) and linter (eslint) in parallel for the same project
- Deploying to multiple environments (staging, production) simultaneously
- Running unit tests and integration tests concurrently
- Any scenario where commands are independent and can run simultaneously

The tool accepts command groups with configurable concurrency. Each group can:
- Run commands sequentially (one after another) or in parallel
- Wait for other groups to finish before starting (via wait_for)
- Continue executing remaining commands even if one fails (via continue_on_error)

Output from all commands is aggregated into a single structured response with:
- Per-command status (exit code, duration, stdout/stderr preview)
- Per-group summary statistics
- Overall totals across all groups

Parameters:
- groups: (required) Array of command groups. Each group has:
  - id: A unique identifier for the group (descriptive names help with result readability)
  - sequential: Whether commands within this group execute one after another (true) or concurrently (false)
  - commands: Array of commands, each with:
    - command: The shell command to execute
    - cwd: Optional working directory (null for default)
    - timeout: Optional timeout in seconds (null for no timeout)
  - wait_for: Array of group IDs that must complete before this group starts
  - continue_on_error: If true, continue with remaining commands even if one fails
- max_parallel: Maximum number of groups to execute in parallel (null = use CPU count, typically 4-16)

Performance benefit: For N independent commands, parallel execution completes in ~max(command_time) instead of sum(command_time).

Example: Building frontend and backend in parallel while running tests in a third group
{
  "groups": [
    {
      "id": "typecheck-and-lint-frontend",
      "sequential": false,
      "commands": [
        { "command": "cd frontend && npx tsc --noEmit", "cwd": null, "timeout": 60 },
        { "command": "cd frontend && npx eslint src/", "cwd": null, "timeout": 60 }
      ],
      "wait_for": [],
      "continue_on_error": true
    },
    {
      "id": "build-backend",
      "sequential": true,
      "commands": [
        { "command": "cd backend && cargo check", "cwd": null, "timeout": 120 },
        { "command": "cd backend && cargo build", "cwd": null, "timeout": 300 }
      ],
      "wait_for": [],
      "continue_on_error": false
    },
    {
      "id": "run-tests",
      "sequential": true,
      "commands": [
        { "command": "cd backend && cargo test", "cwd": null, "timeout": 120 }
      ],
      "wait_for": ["build-backend"],
      "continue_on_error": false
    }
  ],
  "max_parallel": 2
}`

export default {
	type: "function",
	function: {
		name: "execute_parallel",
		description: EXECUTE_PARALLEL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				groups: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							sequential: { type: "boolean" },
							commands: {
								type: "array",
								items: {
									type: "object",
									properties: {
										command: { type: "string" },
										cwd: { type: ["string", "null"] },
										timeout: { type: ["number", "null"] },
									},
									required: ["command", "cwd", "timeout"],
								},
							},
							wait_for: { type: "array", items: { type: "string" } },
							continue_on_error: { type: "boolean" },
						},
						required: ["id", "sequential", "commands", "wait_for", "continue_on_error"],
					},
				},
				max_parallel: { type: ["number", "null"] },
			},
			required: ["groups", "max_parallel"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
