import type OpenAI from "openai"

const WEB_EXTRACT_DESCRIPTION = `Request to extract structured data from a URL using CSS selectors. Define named selectors with CSS selector strings and optional attribute extraction. Returns structured JSON matching the selector definitions. Uses Cloak browser with anti-bot protection.`

const URL_DESCRIPTION = `The URL to extract data from`

const SELECTORS_DESCRIPTION = `Array of selector definitions. Each selector has a "name" (field name in output), "selector" (CSS selector string), and optional "attribute" (HTML attribute to extract instead of text content)`

const WAIT_FOR_SELECTOR_DESCRIPTION = `Optional CSS selector to wait for before extracting data (helps with dynamically-loaded content)`

const EXTRACT_ALL_DESCRIPTION = `If true, extract all matching elements for each selector as an array. If false (default), only extract the first match.`

const webExtractTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "web_extract",
		description: WEB_EXTRACT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: URL_DESCRIPTION,
				},
				selectors: {
					type: "array",
					description: SELECTORS_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Field name for the extracted value",
							},
							selector: {
								type: "string",
								description: "CSS selector to target the element",
							},
							attribute: {
								type: "string",
								description: "Optional HTML attribute to extract (e.g., 'href', 'src'). If omitted, extracts text content",
							},
						},
						required: ["name", "selector"],
						additionalProperties: false,
					},
				},
				waitForSelector: {
					type: "string",
					description: WAIT_FOR_SELECTOR_DESCRIPTION,
				},
				extractAll: {
					type: "boolean",
					description: EXTRACT_ALL_DESCRIPTION,
				},
			},
			required: ["url", "selectors"],
			additionalProperties: false,
		},
	},
}

export default webExtractTool