import type OpenAI from "openai"

const WEB_SEARCH_DESCRIPTION = `Request to search the web using a search engine. Returns a list of search results with title, URL, and snippet. Supports Google, Bing, and DuckDuckGo search engines. Uses Cloak browser with anti-bot protection.`

const QUERY_DESCRIPTION = `The search query`

const COUNT_DESCRIPTION = `Number of search results to return (1-20, default 10)`

const ENGINE_DESCRIPTION = `Search engine to use: "google" (default), "bing", or "duckduckgo"`

const webSearchTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "web_search",
		description: WEB_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: QUERY_DESCRIPTION,
				},
				count: {
					type: "number",
					description: COUNT_DESCRIPTION,
				},
				engine: {
					type: "string",
					description: ENGINE_DESCRIPTION,
					enum: ["google", "bing", "duckduckgo"],
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
}

export default webSearchTool