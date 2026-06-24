import type OpenAI from "openai"

const CRONJOB_DESCRIPTION = `Manage scheduled cron jobs. Create, list, update, pause, resume, remove, or trigger jobs.

Actions:
- create: Schedule a new job. Requires schedule + prompt.
- list: Show all jobs.
- update: Change schedule, prompt, or delivery of an existing job.
- pause/resume: Control job state.
- remove: Delete a job.
- run: Trigger a job immediately.

Schedule formats:
- Duration: "30m", "2h", "90s"
- Every phrase: "every 2h", "every monday 9am"
- Cron: "0 9 * * *" (daily at 9am)
- ISO timestamp: "2026-06-01T09:00:00" (one-shot)`

const cronjobTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "cronjob",
		description: CRONJOB_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Action to perform",
					enum: ["create", "list", "update", "pause", "resume", "remove", "run"],
				},
				schedule: {
					type: "string",
					description: "Schedule for create/update: '30m', 'every 2h', '0 9 * * *', or ISO timestamp",
				},
				prompt: {
					type: "string",
					description: "Self-contained prompt for the job (required for create)",
				},
				name: {
					type: "string",
					description: "Human-friendly name for the job",
				},
				job_id: {
					type: "string",
					description: "Job ID for update/pause/resume/remove/run",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
}

export default cronjobTool
