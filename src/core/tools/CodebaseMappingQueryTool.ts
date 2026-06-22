/**
 * Tool for querying the codebase mapping system's schema, formats, and state.
 */
import * as vscode from "vscode"
import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { CodebaseMappingManager } from "../../services/codebase-mapping"

interface CodebaseMappingQueryParams {
	action: "schema" | "formats" | "stats" | "help"
}

const SCHEMA_DOC = `## Codebase Mapping — Schema

### Core Types

**FileNode** — Represents a single file in the dependency graph:
\`\`\`
{
  filePath: string       // Absolute or relative path
  language: Language     // e.g. "typescript", "python", "rust"
  size: number           // File size in bytes
  contentHash: string    // SHA256-like hash of file content
  lastModified: number   // Unix timestamp
  symbols: string[]      // Symbol IDs defined in this file
  imports: string[]      // Import paths
  exports: string[]      // Export paths
  pageRank: number       // PageRank centrality (0.0 - 1.0)
}
\`\`\`

**DependencyEdge** — A directed dependency between files:
\`\`\`
{
  from: string           // Source file path
  to: string             // Target file path  
  kind: "import" | "dynamic_import" | "require" | "type_import" | "re_export"
  isExternal: boolean    // True if dependency is outside the workspace
  isDynamic: boolean     // True for dynamic imports (import())
}
\`\`\`

**DependencyGraph** — Container for the entire graph:
\`\`\`
{
  files: Map<string, FileNode>   // Path → FileNode
  edges: DependencyEdge[]        // All dependency connections
  rootPaths: string[]            // Workspace root directories
  buildTimeMs: number            // Time to build the graph
}
\`\`\`

**ExtractedSymbol** — A code symbol found in a file:
\`\`\`
{
  id: string                    // Unique symbol ID
  name: string                  // Symbol name
  kind: SymbolKind              // class, function, interface, type, etc.
  filePath: string              // File containing this symbol
  range: SourceRange            // Location in source
  parentId: string | null       // Parent symbol (e.g. method → class)
  isExported: boolean           // Whether symbol is exported
  documentation: string | null  // JSDoc/TSDoc comment
  references: SymbolReference[] // Where this symbol is referenced
  visibility: "public" | "protected" | "private" | "internal"
}
\`\`\`

### Enums

**Language**: typescript, javascript, python, rust, go, java, c, cpp, ruby, php, shell, swift, kotlin, scala, dart, lua, haskell, elixir, clojure, erlang, r, julia, sql, graphql, yaml, json, markdown, dockerfile, makefile, toml, unknown

**SymbolKind**: class, interface, type, enum, function, method, property, variable, constant, parameter, module, namespace, decorator, generic, constructor, getter, setter, event, mixin, alias

**SerializationFormat**: json, mermaid, graphviz, ascii, html, markdown

**LevelOfDetail**: L0_Summary, L1_Signatures, L2_Declarations, L3_Implementation, L4_FullSource

**DeadCodeReason**: unused_export, unreachable_code, orphan_function, unused_parameter, unused_variable, dead_branch, unused_type, unused_import`

const FORMATS_DOC = `## Supported Serialization Formats

### JSON
Full structured export with metadata, files, symbols, edges, and dead code.
\`\`\`
svc.serialize(SerializationFormat.JSON)
→ { metadata: { totalFiles, totalSymbols, totalEdges, generatedAt },
    files: [{ path, language, size, symbolCount, importCount, exportCount }],
    symbols: [{ id, name, kind, filePath, referenceCount }],
    edges: [{ from, to, kind, isDynamic }],
    deadCode: [{ name, kind, filePath, reason, confidence }] }
\`\`\`

### Mermaid.js
Visualizable as a flow chart diagram in markdown.
\`\`\`
svc.serialize(SerializationFormat.Mermaid)
→ graph TD
    A[src/main.ts] --> B[src/utils.ts]
    A --> C[src/config.ts]
\`\`\`

### Graphviz (DOT)
For use with Graphviz rendering tools.
\`\`\`
svc.serialize(SerializationFormat.Graphviz)
→ digraph { "src/main.ts" -> "src/utils.ts"; }
\`\`\`

### ASCII
Text-based tree view of dependencies, useful for terminal/CLI.
\`\`\`
svc.serialize(SerializationFormat.ASCII)
→ src/
  main.ts
    ├── src/utils.ts
    └── src/config.ts
\`\`\`

### HTML
Interactive HTML page with expandable file trees.

### Markdown
Human-readable markdown document with tables and lists.

### Usage in code
\`\`\`typescript
const graph: DependencyGraph = await service.getDependencyGraph()
// graph.files.size → number of files
// graph.edges.length → number of dependency edges

const deadCode: DeadSymbol[] = await service.getDeadCode()
// deadCode.length → unreferenced symbols

const cacheStats: CacheStats = await service.getCacheStats()
// cacheStats.astHitRate → cache effectiveness (0.0 - 1.0)

const mermaid = await service.serialize(4) // SerializationFormat.Mermaid
\`\`\``

const HELP_DOC = `## Codebase Mapping — Usage Guide

### Available Tools
- \`codebase_dependency\` — Query the dependency graph (reverse deps, forward deps, file info, dead symbols, module map, cycles)
- \`codebase_mapping_query\` — Query mapping system metadata (this tool)

### VS Code Commands
- \`zoo-code.refreshCodebaseMap\` or \`zoo-code.forceRescanCodebaseMap\` — Start/rescan codebase mapping
- \`zoo-code.showCodebaseMap\` — Show current stats (files, edges, dead symbols, cache rate)
- \`zoo-code.exportCodebaseMap\` — Export the dependency graph for documentation

### Workflow Tips
1. Before refactoring: run \`codebase_dependency(action="reverse_deps", target="<file>")\` to find everything that depends on the file
2. Before deleting code: run \`codebase_dependency(action="dead_symbols")\` to find unreferenced code
3. For architecture docs: use \`codebase_mapping_query(action="formats")\` then \`codebase_dependency(action="module_map", module="src/feature")\`
4. After making changes: the graph auto-updates via incremental file scan

### Scan Status
- The mapping scans independently of code indexing
- Status shown in the webview badge (green=ready, yellow=scanning, gray=idle)
- Cache hit rate > 0% on re-scans means faster subsequent analyses
- Dead symbols are only detected after a full scan completes`

export class CodebaseMappingQueryTool extends BaseTool<"codebase_mapping_query"> {
	readonly name = "codebase_mapping_query" as const

	async execute(params: CodebaseMappingQueryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks
		const { action } = params

		try {
			switch (action) {
				case "schema": {
					pushToolResult(SCHEMA_DOC)
					break
				}
				case "formats": {
					pushToolResult(FORMATS_DOC)
					break
				}
				case "help": {
					pushToolResult(HELP_DOC)
					break
				}
				case "stats": {
					const context = task.providerRef.deref()?.context
					if (!context) {
						pushToolResult("Extension context not available.")
						return
					}
					const service = CodebaseMappingManager.getInstance(context, task.cwd)
					if (!service) {
						pushToolResult("Codebase mapping not available. Run 'zoo-code.refreshCodebaseMap' to start.")
						return
					}
					const graph = await service.getDependencyGraph()
					const deadCode = await service.getDeadCode()
					const stats = await service.getCacheStats()

					const scanStatus = (service as any)._scanStatus || "unknown"
					const errorCount = (service as any)._lastScanErrors || 0

					const statusInfo = scanStatus === "scanning"
						? "⚠ Scan in progress — results may be incomplete"
						: errorCount > 0
							? `⚠ ${errorCount} parse error(s) in last scan`
							: "✅ Scan complete"

					const fileCount = (service as any)._filesScanned || graph.files.size
					const edgeCount = (service as any)._accumulatedEdges || graph.edges.length

					pushToolResult(`## Codebase Mapping Stats

- **Status**: ${statusInfo}
- **Files**: ${fileCount}
- **Edges**: ${edgeCount}
- **Dead symbols**: ${deadCode.length}
- **Cache hit rate**: ${(stats.astHitRate * 100).toFixed(1)}%
- **Cache size (AST)**: ${stats.astCacheSize} entries
- **Evictions**: ${stats.totalEvictions}
- **Graph build time**: ${graph.buildTimeMs}ms

Use \`codebase_mapping_query(action="schema")\` for type reference or \`codebase_mapping_query(action="formats")\` for export options.`)
					break
				}
			}
		} catch (err) {
			handleError(`Failed to query codebase mapping: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}

export const codebaseMappingQueryTool = new CodebaseMappingQueryTool()
