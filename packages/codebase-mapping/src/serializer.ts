import { DEFAULT_CONFIG, createLogger } from "./models.js"
import type {
	CodebaseMappingConfig,
	SerializationData,
	SerializedEdge,
	SerializedFile,
	SerializedSymbol,
} from "./types.js"
import { SerializationFormat } from "./types.js"

export class Serializer {
	private config: CodebaseMappingConfig
	private logger: ReturnType<typeof createLogger>

	constructor(config: Partial<CodebaseMappingConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.logger = createLogger(this.config.logLevel)
	}

	serialize(data: SerializationData, format: SerializationFormat): string {
		this.logger.info(`Serializing to ${format}`)
		switch (format) {
			case SerializationFormat.JSON:
				return this.toJSON(data)
			case SerializationFormat.Mermaid:
				return this.toMermaid(data)
			case SerializationFormat.Graphviz:
				return this.toGraphviz(data)
			case SerializationFormat.ASCII:
				return this.toASCII(data)
			case SerializationFormat.HTML:
				return this.toHTML(data)
			case SerializationFormat.Markdown:
				return this.toMarkdown(data)
			default:
				return this.toJSON(data)
		}
	}

	buildSerializationData(
		files: SerializedFile[],
		symbols: SerializedSymbol[],
		edges: SerializedEdge[],
	): SerializationData {
		return {
			metadata: {
				workspaceRoots: this.config.workspaceRoots,
				totalFiles: files.length,
				totalSymbols: symbols.length,
				totalEdges: edges.length,
				generatedAt: Date.now(),
				format: SerializationFormat.JSON,
			},
			files,
			symbols,
			edges,
			deadCode: [],
			flows: [],
			configLinks: [],
			gitMetadata: null,
		}
	}

	private toJSON(data: SerializationData): string {
		return JSON.stringify(data, this.jsonReplacer, 2)
	}

	private toMermaid(data: SerializationData): string {
		const lines: string[] = ["graph TD"]
		for (const file of data.files) {
			const nodeId = this.mermaidId(file.path)
			lines.push(`  ${nodeId}["${this.escapeMermaid(file.path)}"]`)
		}
		for (const edge of data.edges) {
			const fromId = this.mermaidId(edge.from)
			const toId = this.mermaidId(edge.to)
			const style = edge.isDynamic ? "-.->" : "-->"
			lines.push(`  ${fromId} ${style} ${toId}`)
		}
		if (data.deadCode.length > 0) {
			lines.push("")
			lines.push(`  subgraph DeadCode["Dead Code (${data.deadCode.length})"]`)
			for (const d of data.deadCode) {
				const dId = this.mermaidId(d.symbolId)
				lines.push(`    ${dId}["${this.escapeMermaid(d.name)}"]`)
			}
			lines.push("  end")
		}
		lines.push("")
		lines.push(`  %% Generated: ${new Date(data.metadata.generatedAt).toISOString()}`)
		lines.push(`  %% Files: ${data.metadata.totalFiles}, Symbols: ${data.metadata.totalSymbols}, Edges: ${data.metadata.totalEdges}`)
		return lines.join("\n") + "\n"
	}

	private mermaidId(path: string): string {
		return "n" + Array.from(path).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36).replace(/^-/, "z")
	}

	private escapeMermaid(s: string): string {
		return s.replace(/"/g, "#quot;").replace(/\(/g, "#40;").replace(/\)/g, "#41;").replace(/\[/g, "#91;").replace(/\]/g, "#93;")
	}

	private toGraphviz(data: SerializationData): string {
		const lines: string[] = [
			"digraph G {",
			"  rankdir=LR;",
			"  node [shape=box, style=rounded];",
			`  label="Codebase Map — ${data.metadata.totalFiles} files, ${data.metadata.totalSymbols} symbols, ${data.metadata.totalEdges} edges";`,
			"",
		]
		for (const file of data.files) {
			const id = this.graphvizId(file.path)
			lines.push(`  ${id} [label="${this.escapeGraphviz(file.path)}"];`)
		}
		for (const edge of data.edges) {
			const fromId = this.graphvizId(edge.from)
			const toId = this.graphvizId(edge.to)
			const style = edge.isDynamic ? "dashed" : "solid"
			lines.push(`  ${fromId} -> ${toId} [style=${style}];`)
		}
		lines.push("}")
		return lines.join("\n") + "\n"
	}

	private graphvizId(path: string): string {
		return "_" + Array.from(path).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36)
	}

	private escapeGraphviz(s: string): string {
		return s.replace(/"/g, '\\"').replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
	}

	private toASCII(data: SerializationData): string {
		const lines: string[] = [
			"Codebase Map",
			"============",
			`Files: ${data.metadata.totalFiles}  Symbols: ${data.metadata.totalSymbols}  Edges: ${data.metadata.totalEdges}`,
			`Generated: ${new Date(data.metadata.generatedAt).toISOString()}`,
			"",
		]
		for (const file of data.files) {
			lines.push(`  ${file.path}`)
			if (file.symbolCount > 0) {
				lines.push(`    symbols: ${file.symbolCount}, imports: ${file.importCount}, exports: ${file.exportCount}`)
			}
		}
		if (data.edges.length > 0) {
			lines.push("")
			lines.push("Dependencies:")
			for (const edge of data.edges) {
				const marker = edge.isDynamic ? " ~>" : " ->"
				lines.push(`  ${edge.from}${marker} ${edge.to}`)
			}
		}
		if (data.deadCode.length > 0) {
			lines.push("")
			lines.push(`Dead Code (${data.deadCode.length}):`)
			for (const d of data.deadCode) {
				lines.push(`  ${d.filePath} :: ${d.name} (${d.reason})`)
			}
		}
		return lines.join("\n") + "\n"
	}

	private toHTML(data: SerializationData): string {
		const fileRows = data.files
			.map(
				(f) =>
					`      <tr><td>${this.escapeHtml(f.path)}</td><td>${f.language}</td><td>${f.size}</td><td>${f.symbolCount}</td><td>${f.importCount}</td><td>${f.exportCount}</td><td>${f.pageRank.toFixed(4)}</td></tr>`,
			)
			.join("\n")
		const edgeRows = data.edges
			.map(
				(e) =>
					`      <tr><td>${this.escapeHtml(e.from)}</td><td>${this.escapeHtml(e.to)}</td><td>${e.kind}</td><td>${e.isDynamic ? "dynamic" : "static"}</td></tr>`,
			)
			.join("\n")
		const deadRows = data.deadCode
			.map((d) => `      <tr><td>${this.escapeHtml(d.filePath)}</td><td>${this.escapeHtml(d.name)}</td><td>${d.reason}</td><td>${d.confidence}</td></tr>`)
			.join("\n")
		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Codebase Map</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
    th { background: #f5f5f5; }
    .meta { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Codebase Map</h1>
  <p class="meta">Files: ${data.metadata.totalFiles} | Symbols: ${data.metadata.totalSymbols} | Edges: ${data.metadata.totalEdges} | Generated: ${new Date(data.metadata.generatedAt).toISOString()}</p>
  <h2>Files</h2>
  <table><thead><tr><th>Path</th><th>Language</th><th>Size</th><th>Symbols</th><th>Imports</th><th>Exports</th><th>PageRank</th></tr></thead>
  <tbody>
${fileRows}
  </tbody></table>
  <h2>Dependencies (${data.edges.length})</h2>
  <table><thead><tr><th>From</th><th>To</th><th>Kind</th><th>Type</th></tr></thead>
  <tbody>
${edgeRows}
  </tbody></table>
  ${data.deadCode.length > 0 ? `<h2>Dead Code (${data.deadCode.length})</h2><table><thead><tr><th>File</th><th>Symbol</th><th>Reason</th><th>Confidence</th></tr></thead><tbody>\n${deadRows}\n  </tbody></table>` : ""}
</body>
</html>
`
	}

	private toMarkdown(data: SerializationData): string {
		const lines: string[] = [
			"# Codebase Map",
			"",
			`- **Files:** ${data.metadata.totalFiles}`,
			`- **Symbols:** ${data.metadata.totalSymbols}`,
			`- **Edges:** ${data.metadata.totalEdges}`,
			`- **Generated:** ${new Date(data.metadata.generatedAt).toISOString()}`,
			"",
			"## Files",
			"",
			"| Path | Language | Size | Symbols | Imports | Exports | PageRank |",
			"|------|----------|------|---------|---------|---------|----------|",
		]
		for (const f of data.files) {
			lines.push(`| ${f.path} | ${f.language} | ${f.size} | ${f.symbolCount} | ${f.importCount} | ${f.exportCount} | ${f.pageRank.toFixed(4)} |`)
		}
		if (data.edges.length > 0) {
			lines.push("", "## Dependencies", "", "| From | To | Kind | Type |", "|------|----|------|------|")
			for (const e of data.edges) {
				lines.push(`| ${e.from} | ${e.to} | ${e.kind} | ${e.isDynamic ? "dynamic" : "static"} |`)
			}
		}
		if (data.deadCode.length > 0) {
			lines.push("", "## Dead Code", "", "| File | Symbol | Reason | Confidence |", "|------|--------|--------|------------|")
			for (const d of data.deadCode) {
				lines.push(`| ${d.filePath} | ${d.name} | ${d.reason} | ${d.confidence} |`)
			}
		}
		return lines.join("\n") + "\n"
	}

	private escapeHtml(s: string): string {
		return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
	}

	private jsonReplacer(_key: string, value: unknown): unknown {
		if (value instanceof Map) {
			return Object.fromEntries(value)
		}
		return value
	}
}
