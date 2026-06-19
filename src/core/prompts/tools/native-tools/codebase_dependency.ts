import type OpenAI from "openai"

const CODEBASE_DEPENDENCY_DESCRIPTION = `Query the project's dependency graph to understand code structure, find what depends on a file, and detect architecture violations.

This tool uses the codebase mapping's AST-level dependency graph — NOT semantic search. It provides EXACT dependency information:
- What files import or reference a given file ("reverse dependencies")
- What a file imports ("forward dependencies")
- Dead symbols (exports nothing imports anything)
- All files in a module/directory with their dependency counts
- Circular dependencies (file A → B → C → A)

Use this tool when:
- You need to understand the impact of changing a file before editing it
- You're refactoring and need to know what depends on the code you're changing
- You want to verify that new code doesn't introduce architecture violations
- You need to find unused/dead code that can be safely removed
- You need a quick summary of a module's structure without reading every file

Parameters:
- action: (required) One of: "reverse_deps", "forward_deps", "file_info", "dead_symbols", "module_map", "cycles"
- target: (optional) File path or symbol name to query. Required for: reverse_deps, forward_deps, file_info
- module: (optional) Directory path to scope a module_map query

Examples:
{ "action": "reverse_deps", "target": "src/services/auth.service.ts" }
  → Files that import auth.service.ts
  
{ "action": "forward_deps", "target": "src/utils/date.ts" }
  → What date.ts imports
  
{ "action": "file_info", "target": "src/models/user.ts" }
  → Symbols, exports, imports for user.ts
  
{ "action": "dead_symbols" }
  → All symbols that nothing references
  
{ "action": "module_map", "module": "src/services" }
  → Every file in services/ with dependency counts
  
{ "action": "cycles" }
  → Any circular dependency chains found in the project`

export default {
	type: "function",
	function: {
		name: "codebase_dependency",
		description: CODEBASE_DEPENDENCY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Query type: reverse_deps, forward_deps, file_info, dead_symbols, module_map, cycles",
					enum: ["reverse_deps", "forward_deps", "file_info", "dead_symbols", "module_map", "cycles"],
				},
				target: {
					type: ["string", "null"],
					description: "File path or symbol name (required for reverse_deps, forward_deps, file_info)",
				},
				module: {
					type: ["string", "null"],
					description: "Directory path for module_map query",
				},
			},
			required: ["action", "target", "module"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
