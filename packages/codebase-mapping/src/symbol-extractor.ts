import { DEFAULT_CONFIG, createLogger } from "./models.js"
import { SymbolKind } from "./types.js"
import type { CodebaseMappingConfig, ExtractedSymbol, ParseResult } from "./types.js"
import { createExtractedSymbol, createSymbolReference } from "./models.js"

const NODE_KIND_TO_SYMBOL_KIND: Record<string, SymbolKind> = {
	function_declaration: SymbolKind.Function,
	method_declaration: SymbolKind.Method,
	class_declaration: SymbolKind.Class,
	interface_declaration: SymbolKind.Interface,
	type_declaration: SymbolKind.Type,
	struct_declaration: SymbolKind.Class,
	enum_declaration: SymbolKind.Enum,
	trait_declaration: SymbolKind.Interface,
	variable_declaration: SymbolKind.Variable,
	const_declaration: SymbolKind.Constant,
	property_declaration: SymbolKind.Property,
	constructor_declaration: SymbolKind.Constructor,
	getter_declaration: SymbolKind.Getter,
	setter_declaration: SymbolKind.Setter,
	decorator_declaration: SymbolKind.Decorator,
	export_statement: SymbolKind.Module,
	import_statement: SymbolKind.Module,
}

export class SymbolExtractor {
	private config: CodebaseMappingConfig
	private logger: ReturnType<typeof createLogger>
	private extractableNodeKinds: Set<string>

	constructor(config: Partial<CodebaseMappingConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.logger = createLogger(this.config.logLevel)
		this.extractableNodeKinds = new Set(Object.keys(NODE_KIND_TO_SYMBOL_KIND))
	}

	extractSymbols(parseResult: ParseResult): ExtractedSymbol[] {
		this.logger.debug(`Extracting symbols from ${parseResult.filePath}`)
		if (!parseResult.ast) return []

		const symbols: ExtractedSymbol[] = []
		const importNames = new Map<string, string>() // name -> symbolId

		for (const child of parseResult.ast.children) {
			if (!this.extractableNodeKinds.has(child.kind)) continue

			const symbolKind = NODE_KIND_TO_SYMBOL_KIND[child.kind] ?? SymbolKind.Variable

			const nameMatch = child.text.match(this.getNameRegex(child.kind))
			if (!nameMatch || !nameMatch[1]) continue
			const name = nameMatch[1]

			const symbolId = `${parseResult.filePath}::${name}`

			const symbol = createExtractedSymbol(
				symbolId,
				name,
				symbolKind,
				child.range,
				parseResult.filePath,
				parseResult.language,
				null,
				[],
				null,
				[],
				[],
				[],
				"public",
				child.kind === "export_statement" ||
					child.kind === "function_declaration" ||
					child.kind === "class_declaration",
				false,
				false,
				false,
				false,
				null,
				[],
				{ kind: child.kind },
			)

			if (child.kind === "import_statement") {
				importNames.set(name, symbolId)
			}

			symbols.push(symbol)
		}

		// Resolve references: match symbol names to imports
		for (const sym of symbols) {
			const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string
			if (metaKind !== "import_statement") {
				for (const [importName, importId] of importNames) {
					if (sym.name === importName || nameMatchesModule(sym.name, importName)) {
						sym.references.push(
							createSymbolReference(sym.id, sym.filePath, importId, "", sym.range, "usage", false),
						)
					}
				}
			}
		}

		this.logger.debug(`Extracted ${symbols.length} symbols from ${parseResult.filePath}`)
		return symbols
	}

	resolveReferences(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
		this.logger.debug(`Resolving references for ${symbols.length} symbols`)
		return symbols
	}

	private getNameRegex(kind: string): RegExp {
		switch (kind) {
			case "function_declaration":
				return /(?:function|def|fn|func|fun|sub)\s+(\w+)/
			case "class_declaration":
				return /(?:class|struct|trait|interface|type)\s+(\w+)/
			case "variable_declaration":
				return /(?:let|var|const|val)\s+(\w+)/
			case "export_statement":
				return /(?:export|module\.exports|pub\s+(?:fn|struct|enum|trait|mod))\s+(?:default\s+)?(?:function|class|const|let|var|fn|struct|enum)?\s*(\w+)?/
			default:
				return /(\w+)/
		}
	}
}

function nameMatchesModule(symbolName: string, importName: string): boolean {
	return (
		symbolName.toLowerCase() === importName.toLowerCase() ||
		symbolName.includes(importName) ||
		importName.includes(symbolName)
	)
}
