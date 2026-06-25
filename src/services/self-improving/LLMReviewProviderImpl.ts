import OpenAI from "openai"
import type { CuratorAction, LLMReviewProvider } from "./CuratorService"

/**
 * Real LLM review provider that calls the configured LLM API
 * to analyze skills and recommend consolidation actions.
 */
export class LLMReviewProviderImpl implements LLMReviewProvider {
	private client: OpenAI | null = null
	private model: string

	constructor(model: string = "gpt-4o-mini") {
		this.model = model
	}

	private getClient(): OpenAI {
		if (this.client) return this.client

		// Try VS Code extension config first, then env vars
		let apiKey = ""
		let baseURL = "https://api.openai.com/v1"

		try {
			const vscode = require("vscode")
			const config = vscode.workspace.getConfiguration("zoo-code")
			const rawKey: unknown = config.get("openRouterApiKey")
			apiKey = typeof rawKey === "string" ? rawKey : ""
			if (apiKey) {
				baseURL = "https://openrouter.ai/api/v1"
			}
		} catch {}

		if (!apiKey) {
			apiKey =
				process.env["OPENAI_API_KEY"] ||
				process.env["ANTHROPIC_API_KEY"] ||
				process.env["OPENROUTER_API_KEY"] ||
				""
		}
		if (!apiKey) {
			baseURL = process.env["OPENROUTER_BASE_URL"] || baseURL
		}

		if (!apiKey) {
			throw new Error(
				"No API key configured for LLM review. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY, or configure openRouterApiKey in VS Code settings.",
			)
		}

		this.client = new OpenAI({ apiKey, baseURL })
		return this.client
	}

	async review(prompt: string): Promise<CuratorAction[]> {
		try {
			const client = this.getClient()
			const response = await client.chat.completions.create({
				model: this.model,
				messages: [
					{
						role: "system",
						content:
							"You are a skill curator. Return ONLY valid YAML with a top-level 'actions' key. No markdown, no explanation.",
					},
					{ role: "user", content: prompt },
				],
				temperature: 0.1,
				max_tokens: 2000,
			})

			const content = response.choices[0]?.message?.content
			if (!content) return []

			return this.parseActions(content)
		} catch (error) {
			console.error("[LLMReviewProvider] Review failed:", error)
			return []
		}
	}

	private parseActions(content: string): CuratorAction[] {
		try {
			const actions: CuratorAction[] = []
			const actionRegex = /- \{action: (\w+), (.+?)\}/g
			let match: RegExpExecArray | null

			while ((match = actionRegex.exec(content)) !== null) {
				const action: Record<string, any> = { action: match[1] }
				const rest = match[2]

				const kvRegex = /(\w+):\s*(?:"([^"]*)"|\[([^\]]*)\]|(\S+))/g
				let kvMatch: RegExpExecArray | null
				while ((kvMatch = kvRegex.exec(rest)) !== null) {
					const key = kvMatch[1]
					const val =
						kvMatch[2] || // quoted string
						kvMatch[3]?.split(",").map((s: string) => s.trim().replace(/^"|"$/g, "")) || // array
						kvMatch[4] // simple value
					action[key] = val
				}

				actions.push(action as CuratorAction)
			}

			return actions
		} catch {
			return []
		}
	}
}
