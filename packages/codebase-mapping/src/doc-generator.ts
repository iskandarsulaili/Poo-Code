import { DEFAULT_CONFIG, createLogger } from "./models.js"
import type { CodebaseMappingConfig, DocGeneratorConfig, DocUpdate, StaleDocReport } from "./types.js"

export class DocGenerator {
	private config: CodebaseMappingConfig
	private logger: ReturnType<typeof createLogger>
	private docConfig: DocGeneratorConfig

	constructor(config: Partial<CodebaseMappingConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.logger = createLogger(this.config.logLevel)
		this.docConfig = {
			enabled: this.config.enableDocGenerator,
			autoRegenerateJSDoc: true,
			autoRegenerateTSDoc: true,
			autoUpdateREADME: false,
			watchDocFiles: false,
			maxDocSize: 10000,
		}
	}

	async generateDoc(filePath: string, symbolName: string, code: string, useTSDoc = false): Promise<DocUpdate> {
		this.logger.debug(`Generating documentation for ${symbolName} in ${filePath}`)
		const existingDoc = this.extractExistingDoc(code, symbolName)
		const newDoc = this.generateTemplateDoc(symbolName, filePath, code, useTSDoc)
		return {
			filePath,
			symbolId: `${filePath}::${symbolName}`,
			symbolName,
			oldDoc: existingDoc,
			newDoc,
			updateType: "api_doc_generated" as DocUpdate["updateType"],
			generatedAt: Date.now(),
		}
	}

	detectStaleDocs(filePath: string, code: string, existingDoc: string): StaleDocReport | null {
		// Check if the doc references symbols or signatures that no longer exist in the code
		const codeLines = code.split("\n")
		const docLines = existingDoc.split("\n")

		// Extract symbol names from doc
		const docSymbols = new Set<string>()
		for (const line of docLines) {
			const matches = line.matchAll(/`(\w+)`/g)
			for (const m of matches) {
				if (m[1]) docSymbols.add(m[1])
			}
		}

		if (docSymbols.size === 0) return null

		// Check if each doc symbol still appears in the code
		const staleSymbols: string[] = []
		for (const sym of docSymbols) {
			const found = codeLines.some((l) => l.includes(sym))
			if (!found) staleSymbols.push(sym)
		}

		if (staleSymbols.length === 0) return null

		return {
			filePath,
			symbolId: `${filePath}::stale`,
			symbolName: staleSymbols.join(", "),
			existingDoc,
			detectedSignature: staleSymbols.join(", "),
			reason: `Symbols referenced in doc no longer found in code: ${staleSymbols.join(", ")}`,
		}
	}

	private extractExistingDoc(code: string, symbolName: string): string | null {
		// Try to extract existing JSDoc/TSDoc comment above the symbol
		const lines = code.split("\n")
		for (let i = 0; i < lines.length; i++) {
			const line: string | undefined = lines[i]
			if (line !== undefined && line.includes(symbolName)) {
				// Look backwards for doc comments
				const docLines: string[] = []
				for (let j = i - 1; j >= 0; j--) {
					const currentLine: string | undefined = lines[j]
					if (currentLine === undefined) break
					const trimmed = currentLine.trim()
					if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/**")) {
						docLines.unshift(currentLine)
					} else if (trimmed === "" || trimmed.startsWith("@")) {
						continue
					} else {
						break
					}
				}
				if (docLines.length > 0) return docLines.join("\n")
				break
			}
		}
		return null
	}

	private generateTemplateDoc(symbolName: string, filePath: string, code: string, useTSDoc = false): string {
		const ext = filePath.split(".").pop()?.toLowerCase() || ""
		const lang = ext === "ts" || ext === "tsx" ? "TypeScript" : ext === "py" ? "Python" : ext === "rs" ? "Rust" : ext === "go" ? "Go" : ext === "java" ? "Java" : ext === "js" || ext === "jsx" ? "JavaScript" : "Code"

		// Detect symbol kind from code context
		let kind = "symbol"
		if (/function\s+\w+|def\s+\w+|fn\s+\w+|func\s+\w+|fun\s+\w+|sub\s+\w+/.test(code)) kind = "function"
		else if (/class\s+\w+|struct\s+\w+/.test(code)) kind = "class"
		else if (/interface\s+\w+|trait\s+\w+/.test(code)) kind = "interface"
		else if (/type\s+\w+|enum\s+\w+/.test(code)) kind = "type"
		else if (/const\s+\w+|let\s+\w+|var\s+\w+|val\s+\w+/.test(code)) kind = "variable"

		const lines: string[] = [
			`/**`,
			` * ${symbolName} — ${kind}`,
			` *`,
			` * @file ${filePath}`,
			` * @language ${lang}`,
			` * @kind ${kind}`,
			` *`,
			` * @description`,
			` * TODO: Describe the purpose and behavior of ${symbolName}.`,
			` *`,
		]

		if (kind === "function") {
			if (useTSDoc) {
				lines.push(
					` * @param params — TODO: Document parameters`,
					` * @returns — TODO: Document return value`,
				)
			} else {
				lines.push(
					` * @param {...} params — TODO: Document parameters`,
					` * @returns {void} — TODO: Document return value`,
				)
			}
		} else if (kind === "class") {
			if (useTSDoc) {
				lines.push(
					` * @property — TODO: Document properties`,
					` * @method — TODO: Document methods`,
				)
			} else {
				lines.push(
					` * @property {...} — TODO: Document properties`,
					` * @method {...} — TODO: Document methods`,
				)
			}
		}

		lines.push(
			` *`,
			` * @example`,
			` * // TODO: Add usage example`,
			` */`,
		)

		return lines.join("\n")
	}

	getConfig(): DocGeneratorConfig {
		return { ...this.docConfig }
	}

	updateConfig(updates: Partial<DocGeneratorConfig>): void {
		this.docConfig = { ...this.docConfig, ...updates }
	}
}
