import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "../../shared/tools"
import { WebhookManager } from "../../services/webhook/WebhookManager"

type WebhookParams = NativeToolArgs["webhook"]

export class WebhookTool extends BaseTool<"webhook"> {
	readonly name = "webhook" as const

	async execute(params: WebhookParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		try {
			const manager = WebhookManager.getInstance()

			switch (params.action) {
				case "subscribe": {
					if (!params.name || !params.url || !params.prompt) {
						pushToolResult("Error: name, url, and prompt are required for subscribe")
						return
					}
					await manager.subscribe({
						name: params.name,
						url: params.url,
						prompt: params.prompt,
					})
					pushToolResult(`Webhook subscribed: /webhooks/${params.name} -> ${params.url}`)
					break
				}
				case "list": {
					const hooks = await manager.listSubscriptions()
					if (hooks.length === 0) {
						pushToolResult("No webhook subscriptions.")
						return
					}
					const formatted = hooks
						.map((h) => `- ${h.name}: ${h.url} (${h.active ? "active" : "inactive"})`)
						.join("\n")
					pushToolResult(`Webhook subscriptions (${hooks.length}):\n${formatted}`)
					break
				}
				case "remove": {
					if (!params.name) {
						pushToolResult("Error: name required")
						return
					}
					await manager.remove(params.name)
					pushToolResult(`Webhook ${params.name} removed.`)
					break
				}
			}
		} catch (error) {
			await handleError("managing webhook", error as Error)
		}
	}
}

export const webhookTool = new WebhookTool()
