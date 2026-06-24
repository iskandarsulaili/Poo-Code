import type OpenAI from "openai"

const SESSION_SEARCH_DESCRIPTION = `Search past conversations and sessions using full-text search. Returns matching sessions with snippets, goals, and resolutions. Use this to recall what was discussed in previous sessions, find past decisions, or reference earlier work.

Parameters:
- query: (required) Search query. Supports AND (default), OR, quoted phrases, and prefix wildcards.
- limit: (optional) Max sessions to return (default 5, max 20)
- mode: (optional) Search mode: "fulltext" (default), "semantic", or "hybrid"`

const sessionSearchTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "session_search",
		description: SESSION_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Search query. AND is default, use OR for broader recall, quoted phrases for exact match, prefix wildcards (deploy*)",
				},
				limit: {
					type: "number",
					description: "Max sessions to return (default 5, max 20)",
				},
				mode: {
					type: "string",
					description: "Search mode: fulltext (default), semantic, or hybrid",
					enum: ["fulltext", "semantic", "hybrid"],
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
}

export default sessionSearchTool
