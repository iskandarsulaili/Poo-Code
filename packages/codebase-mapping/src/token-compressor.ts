import { DEFAULT_CONFIG, createLogger } from "./models.js";
import type { CodebaseMappingConfig, CompressedRepresentation, DeltaChange, ExtractedSymbol } from "./types.js";
import { LevelOfDetail } from "./types.js";

export class TokenCompressor {
  private config: CodebaseMappingConfig;
  private logger: ReturnType<typeof createLogger>;

  constructor(config: Partial<CodebaseMappingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger(this.config.logLevel);
  }

  compress(
    filePath: string,
    content: string,
    symbols: ExtractedSymbol[],
    lod: LevelOfDetail = LevelOfDetail.L2_Declarations
  ): CompressedRepresentation {
    this.logger.debug(`Compressing ${filePath} at LOD ${lod}`);

    const originalSize = content.length;
    const compressedContent = this.applyLevelOfDetail(content, symbols, lod);
    const compressedSize = compressedContent.length;

    return {
      filePath,
      lod,
      originalSize,
      compressedSize,
      compressionRatio: originalSize > 0 ? compressedSize / originalSize : 0,
      content: compressedContent,
      includedSymbols: symbols.map((s) => s.id),
      excludedSymbols: [],
    };
  }

  computeDelta(oldContent: string, newContent: string, filePath: string): DeltaChange {
    this.logger.debug(`Computing delta for ${filePath}`);
    const oldHash = this.computeHash(oldContent);
    const newHash = this.computeHash(newContent);

    if (oldHash === newHash) {
      return {
        filePath,
        changeType: "modified",
        oldHash,
        newHash,
        diff: null,
        affectedSymbols: [],
      };
    }

    return {
      filePath,
      changeType: "modified",
      oldHash,
      newHash,
      diff: this.generateDiff(oldContent, newContent),
      affectedSymbols: [],
    };
  }

  private applyLevelOfDetail(content: string, _symbols: ExtractedSymbol[], lod: LevelOfDetail): string {
    switch (lod) {
      case LevelOfDetail.L0_Summary:
        return this.summarize(content);
      case LevelOfDetail.L1_Signatures:
        return this.extractSignatures(content);
      case LevelOfDetail.L2_Declarations:
        return this.extractDeclarations(content);
      case LevelOfDetail.L3_Implementation:
        return content;
      case LevelOfDetail.L4_FullSource:
        return content;
      default:
        return content;
    }
  }

  private summarize(content: string): string {
  	// L0: Keep only first line of each file (filename/header) + line count
  	const lines = content.split("\n")
  	const header = lines[0] || ""
  	const totalLines = lines.length
  	const nonEmpty = lines.filter((l) => l.trim().length > 0).length
  	return `${header}\n  [${totalLines} lines, ${nonEmpty} non-empty]`
  }

  private extractSignatures(content: string): string {
  	// L1: Extract function/class/interface signatures (lines matching declaration patterns)
  	const lines = content.split("\n")
  	const sigLines: string[] = []
  	const sigPatterns = [
  		/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|fun|func)\s+\w+/,
  		/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:get|set|function|method)\s+\w+/,
  		/^\s*(?:import|from|use|require)\s+/,
  		/^\s*(?:export\s+)?(?:default\s+)?(?:function|class|const|let|var)\s+\w+/,
  		/^\s*@\w+/,
  		/^\s*\/\*\*/,
  		/^\s*\*\/?/,
  	]
  	for (const line of lines) {
  		for (const pat of sigPatterns) {
  			if (pat.test(line)) {
  				sigLines.push(line)
  				break
  			}
  		}
  	}
  	return sigLines.join("\n")
  }

  private extractDeclarations(content: string): string {
  	// L2: Extract declarations + their opening braces (up to first {)
  	const lines = content.split("\n")
  	const declLines: string[] = []
  	let inDecl = false
  	let braceDepth = 0
  	for (const line of lines) {
  		if (!inDecl) {
  			const isDecl = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|fun|func)\s+\w+/.test(line)
  			if (isDecl) {
  				inDecl = true
  				braceDepth = 0
  			}
  		}
  		if (inDecl) {
  			declLines.push(line)
  			for (const ch of line) {
  				if (ch === "{") braceDepth++
  				if (ch === "}") braceDepth--
  			}
  			if (braceDepth <= 0 && /^\s*\}?\s*$/.test(line)) {
  				inDecl = false
  			}
  		}
  	}
  	return declLines.join("\n")
  }

  private generateDiff(oldContent: string, newContent: string): string {
  	// Simple line-based diff (no external dep needed)
  	const oldLines = oldContent.split("\n")
  	const newLines = newContent.split("\n")
  	const result: string[] = []
  	const maxLen = Math.max(oldLines.length, newLines.length)
  	for (let i = 0; i < maxLen; i++) {
  		const oldLine = oldLines[i] ?? ""
  		const newLine = newLines[i] ?? ""
  		if (oldLine !== newLine) {
  			if (oldLine) result.push(`- ${oldLine}`)
  			if (newLine) result.push(`+ ${newLine}`)
  		}
  	}
  	return result.join("\n")
  }

  private computeHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(16);
  }
}
