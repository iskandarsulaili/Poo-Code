import type OpenAI from "openai"

const CODEBASE_MAPPING_QUERY_DESCRIPTION = `Query metadata about the codebase mapping system itself: its schema, supported formats, current scan state, and architecture overview.

This tool does NOT query the project's dependency graph (use codebase_dependency for that). Instead it returns information ABOUT the mapping system — the types, enums, serialization formats, and current state.

Use this tool when:
- You need to understand what data the codebase mapping contains
- You want to know which serialization formats are available (JSON, Mermaid, Graphviz, ASCII, HTML, Markdown)
- You need the current scan stats (files, edges, dead symbols, cache rate) before refactoring
- You want to export the dependency graph in a specific format for documentation
- You need to understand the schema of FileNode, DependencyEdge, ExtractedSymbol types

Parameters:
- action: (required) One of:
  "schema" — Return the TypeScript types/enums used by the mapping system
  "formats" — List supported serialization formats with example output
  "stats" — Return current file count, edges, dead code, cache hit rate
  "help" — Guidance on how to use codebase mapping features

Examples:
{ "action": "stats" } → Current project stats: 1,234 files, 8,901 edges, 12 dead symbols
{ "action": "schema" } → FileNode, DependencyEdge, ExtractedSymbol, SymbolKind, SerializationFormat types
{ "action": "formats" } → Supported formats with syntax examples
{ "action": "help" } → How to export maps, understand dead code, use dependency queries`

export default {
	type: "function",
	function: {
		name: "codebase_mapping_query",
		description: CODEBASE_MAPPING_QUERY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Query type: schema, formats, stats, help",
					enum: ["schema", "formats", "stats", "help"],
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
