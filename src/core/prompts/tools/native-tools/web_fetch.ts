import type OpenAI from "openai"

const WEB_FETCH_DESCRIPTION = `Request to fetch a URL and return its content using a stealth browser. Supports multiple extraction modes: "text" for readable body text, "html" for full page HTML, and "screenshot" for a base64-encoded PNG screenshot. Uses Cloak browser with anti-bot protection.`

const WEB_FETCH_PARAMETER_DESCRIPTION = `The URL to fetch`

const EXTRACT_MODE_DESCRIPTION = `How to extract content: "text" (default) for readable body text, "html" for full page HTML markup, or "screenshot" for a screenshot encoded as base64 PNG`

const WAIT_FOR_SELECTOR_DESCRIPTION = `Optional CSS selector to wait for before extracting content (helps with dynamically-loaded content)`

const TIMEOUT_DESCRIPTION = `Optional timeout in milliseconds (default: 30000)`

const webFetchTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "web_fetch",
		description: WEB_FETCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: WEB_FETCH_PARAMETER_DESCRIPTION,
				},
				extractMode: {
					type: "string",
					description: EXTRACT_MODE_DESCRIPTION,
					enum: ["text", "html", "screenshot"],
				},
				waitForSelector: {
					type: "string",
					description: WAIT_FOR_SELECTOR_DESCRIPTION,
				},
				timeout: {
					type: "number",
					description: TIMEOUT_DESCRIPTION,
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
}

export default webFetchTool