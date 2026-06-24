import type OpenAI from "openai"

const WEBHOOK_DESCRIPTION = `Manage webhook subscriptions. Subscribe to receive HTTP POST notifications when events occur, list active subscriptions, or remove them.

Actions:
- subscribe: Create a webhook at /webhooks/<name>. Requires url + prompt.
- list: Show all active webhook subscriptions.
- remove: Delete a webhook subscription by name.

When a webhook receives a POST request, the agent runs the configured prompt with the request body as context.`

const webhookTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "webhook",
		description: WEBHOOK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Action to perform",
					enum: ["subscribe", "list", "remove"],
				},
				name: {
					type: "string",
					description: "Webhook name (required for subscribe and remove)",
				},
				url: {
					type: "string",
					description: "URL to receive POST notifications (required for subscribe)",
				},
				prompt: {
					type: "string",
					description: "Prompt to run when webhook fires (required for subscribe)",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
}

export default webhookTool
