import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import http from "http"

export interface WebhookSubscription {
	name: string
	url: string
	prompt: string
	active: boolean
	createdAt: number
}

/**
 * Webhook manager that stores subscriptions and serves an HTTP endpoint
 * to receive webhook POST requests. When a webhook fires, the configured
 * prompt is logged for execution.
 *
 * NOTE: For production use, integrate with the VS Code extension host's
 * HTTP server or deploy as a standalone service.
 */
export class WebhookManager {
	private static instance: WebhookManager
	private subscriptions: Map<string, WebhookSubscription> = new Map()
	private storagePath: string
	private server: http.Server | null = null
	private initialized = false

	private constructor() {
		this.storagePath = path.join(
			process.env.HERMES_HOME || path.join(os.homedir(), ".roo"),
			"webhooks",
			"subscriptions.json",
		)
	}

	static getInstance(): WebhookManager {
		if (!WebhookManager.instance) {
			WebhookManager.instance = new WebhookManager()
		}
		return WebhookManager.instance
	}

	async initialize(port: number = 8765): Promise<void> {
		if (this.initialized) return
		try {
			const data = await fs.readFile(this.storagePath, "utf-8")
			const hooks: WebhookSubscription[] = JSON.parse(data)
			for (const hook of hooks) {
				this.subscriptions.set(hook.name, hook)
			}
		} catch {
			// No existing subscriptions
		}
		this.startServer(port)
		this.initialized = true
	}

	private startServer(port: number): void {
		this.server = http.createServer((req, res) => {
			// CORS headers for cross-origin webhook calls
			res.setHeader("Access-Control-Allow-Origin", "*")
			res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

			if (req.method === "OPTIONS") {
				res.writeHead(204)
				res.end()
				return
			}

			if (req.method !== "POST") {
				res.writeHead(405)
				res.end("Method not allowed")
				return
			}

			const url = req.url || "/"
			const hookName = url.replace(/^\/webhooks\//, "")
			const sub = this.subscriptions.get(hookName)

			if (!sub) {
				res.writeHead(404)
				res.end("Webhook not found")
				return
			}

			let body = ""
			req.on("data", (chunk) => {
				body += chunk
			})
			req.on("end", () => {
				console.log(`[WebhookManager] Webhook "${hookName}" fired. Prompt: ${sub.prompt.substring(0, 100)}...`)
				console.log(`[WebhookManager] Body: ${body.substring(0, 500)}`)
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ status: "ok", hook: hookName }))
			})
		})

		this.server.listen(port, () => {
			console.log(`[WebhookManager] Webhook server listening on port ${port}`)
		})
	}

	private async persist(): Promise<void> {
		await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
		await fs.writeFile(this.storagePath, JSON.stringify(Array.from(this.subscriptions.values()), null, 2))
	}

	async subscribe(params: { name: string; url: string; prompt: string }): Promise<WebhookSubscription> {
		const sub: WebhookSubscription = {
			name: params.name,
			url: params.url,
			prompt: params.prompt,
			active: true,
			createdAt: Date.now(),
		}
		this.subscriptions.set(sub.name, sub)
		await this.persist()
		return sub
	}

	async listSubscriptions(): Promise<WebhookSubscription[]> {
		return Array.from(this.subscriptions.values())
	}

	async remove(name: string): Promise<void> {
		this.subscriptions.delete(name)
		await this.persist()
	}

	dispose(): void {
		if (this.server) {
			this.server.close()
			this.server = null
		}
	}
}

export default WebhookManager
