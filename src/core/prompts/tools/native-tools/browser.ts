import type OpenAI from "openai"

const BROWSER_DESCRIPTION = `Interact with a web browser to navigate, click, type, scroll, take screenshots, and execute JavaScript. Uses Cloak browser with anti-bot protection.

Actions:
- navigate: Go to a URL. Returns page title and text content.
- click: Click an element by CSS selector.
- type: Type text into an input field (clears field first).
- snapshot: Get the current page's interactive elements (links, buttons, inputs) with ref IDs for further interaction.
- scroll: Scroll the page up or down.
- press: Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.).
- evaluate: Execute JavaScript in the page context and return the result.
- screenshot: Take a screenshot of the current page as base64 PNG.

Use this when you need to:
- Browse documentation or reference sites interactively
- Fill out forms or interact with web UIs
- Debug web applications
- Extract data from pages that need interaction (login, pagination, dynamic content)
- Take visual screenshots of web pages`

const browserTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "browser",
		description: BROWSER_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Action to perform",
					enum: [
						"navigate",
						"click",
						"type",
						"snapshot",
						"scroll",
						"press",
						"evaluate",
						"screenshot",
						"close",
						"back",
						"forward",
						"hover",
						"waitForSelector",
					],
				},
				url: {
					type: "string",
					description: "URL to navigate to (required for navigate action)",
				},
				selector: {
					type: "string",
					description: "CSS selector for click/type actions",
				},
				text: {
					type: "string",
					description: "Text to type (required for type action) or JavaScript code (for evaluate action)",
				},
				direction: {
					type: "string",
					description: "Scroll direction (required for scroll action)",
					enum: ["up", "down"],
				},
				key: {
					type: "string",
					description:
						"Keyboard key to press (required for press action): Enter, Escape, Tab, ArrowDown, ArrowUp, etc.",
				},
				timeout: {
					type: "number",
					description: "Timeout in ms for waitForSelector action (default 30000)",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
}

export default browserTool
