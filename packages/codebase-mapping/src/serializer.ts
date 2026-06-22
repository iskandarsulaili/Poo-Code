import { DEFAULT_CONFIG, createLogger } from "./models.js"
import type {
	CodebaseMappingConfig,
	DependencyGraph,
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
		_graph: DependencyGraph,
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

	private toMermaid(_data: SerializationData): string {
		// Mermaid diagram generation will be implemented here
		return "graph TD\n"
	}

	private toGraphviz(_data: SerializationData): string {
		// Graphviz DOT generation will be implemented here
		return "digraph G {}\n"
	}

	private toASCII(_data: SerializationData): string {
		// ASCII art generation will be implemented here
		return ""
	}

	private toHTML(_data: SerializationData): string {
		// HTML report generation will be implemented here
		return "<!DOCTYPE html>\n<html></html>\n"
	}

	private toMarkdown(_data: SerializationData): string {
		// Markdown report generation will be implemented here
		return "# Codebase Map\n\n"
	}

	private jsonReplacer(_key: string, value: unknown): unknown {
		if (value instanceof Map) {
			return Object.fromEntries(value)
		}
		return value
	}
}
