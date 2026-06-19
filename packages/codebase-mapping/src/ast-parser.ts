import { DEFAULT_CONFIG, createLogger, detectLanguage } from "./models.js";
import type { CodebaseMappingConfig, Language, ParseResult, SyntaxNode, SourceRange } from "./types.js";
import { createSyntaxNode, createSourceRange } from "./models.js";

/**
 * Multi-line content for patterns that span lines (imports, dynamic imports, re-exports).
 */
interface AccumulatedImport {
  kind: string;
  name: string;
  rawText: string;
  startLine: number;
  endLine: number;
}

export class ASTParser {
  private config: CodebaseMappingConfig;
  private logger: ReturnType<typeof createLogger>;

  constructor(config: Partial<CodebaseMappingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger(this.config.logLevel);
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing AST parser (regex + multi-line mode)");
  }

  async parse(filePath: string, content: string, language: Language): Promise<ParseResult> {
    const startTime = performance.now();
    this.logger.debug(`Parsing ${filePath}`);

    try {
      const ast = this.parseWithRegex(language, content, filePath);
      const parseTimeMs = performance.now() - startTime;

      return {
        filePath,
        language,
        ast,
        contentHash: this.computeHash(content),
        parseTimeMs,
        error: null,
        extractedAt: Date.now(),
      };
    } catch (err) {
      const parseTimeMs = performance.now() - startTime;
      return {
        filePath,
        language,
        ast: null,
        contentHash: this.computeHash(content),
        parseTimeMs,
        error: err instanceof Error ? err.message : String(err),
        extractedAt: Date.now(),
      };
    }
  }

  private parseWithRegex(language: Language, content: string, filePath: string): SyntaxNode {
    const lines = content.split("\n");
    const children: SyntaxNode[] = [];
    let nodeId = 0;
    const accumulated: AccumulatedImport[] = [];

    const patterns = this.getPatternsForLanguage(language);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (!line) continue;

      // --- 1. Single-line pattern matches ---
      for (const { kind, regex } of patterns) {
        const match = line.match(regex);
        if (match && match[1]) {
          const name = match[1];
          const startIndex = content.indexOf(line);
          const endIndex = startIndex + line.length;
          const range = createSourceRange(
            lineIdx + 1, 1,
            lineIdx + 1, line.length,
            startIndex, endIndex
          );
          const id = `${filePath}::${name}::${nodeId++}`;
          children.push(createSyntaxNode(id, kind, line, range, language));
        }
      }

      // --- 2. Multi-line import detection (Fix 2) ---
      // Detect start of multi-line import: e.g. "import {", "const {", "const ["
      const trimmed = line.trim();
      if (/^(import|const)\s*[{\[(]/.test(trimmed) && !trimmed.includes("}")) {
        // Look ahead to find the closing bracket
        let accName = "";
        let accKind = "import_statement";
        let accText = line;
        let endLine = lineIdx;

        for (let lookIdx = lineIdx + 1; lookIdx < lines.length; lookIdx++) {
          const lookLine = lines[lookIdx];
          endLine = lookIdx;
          accText += "\n" + lookLine;

          // Extract the module path: "from './path'" or "require('./path')"
          const fromMatch = lookLine.match(/from\s+["']([^"']+)["']/);
          const requireMatch = lookLine.match(/require\(["']([^"']+)["']/);
          const resolvedPath = fromMatch?.[1] || requireMatch?.[1] || "";

          // Check for closing bracket
          if (/[}\]]/.test(lookLine) && resolvedPath) {
            accName = resolvedPath;
            // Also extract specific named imports for fine-grained deps
            const namedImports = trimmed.match(/\{\s*([^}]+)\s*\}/);
            if (namedImports) {
              // The primary import is the module path
            }
            break;
          }
          // Reached a from/require without bracket close — treat as import
          if ((/from\s+["']/.test(lookLine) || /require\(["']/.test(lookLine)) && !/from\s+["'][^"']+["']/.test(accText)) {
            const multiMatch = accText.match(/from\s+["']([^"']+)["']/);
            if (multiMatch) accName = multiMatch[1];
            break;
          }
        }

        if (accName) {
          const range = createSourceRange(
            lineIdx + 1, 1,
            endLine + 1, 80,
            content.indexOf(line), content.indexOf(lines[endLine]) + lines[endLine].length
          );
          const id = `${filePath}::${accName}::${nodeId++}`;
          children.push(createSyntaxNode(id, accKind, `import ${accName}`, range, language));
        }
      }

      // --- 3. Dynamic imports (Fix 2) ---
      // import("./path"), require("./path" with the function call on one line
      if ((/import\(["']/.test(trimmed) || /dynamic\s+import\(["']/.test(trimmed)) && !trimmed.includes("from")) {
        const dynMatch = trimmed.match(/import\s*\(\s*["']([^"']+)["']\s*\)/);
        if (dynMatch) {
          const startIndex = content.indexOf(line);
          const endIndex = startIndex + line.length;
          const range = createSourceRange(lineIdx + 1, 1, lineIdx + 1, line.length, startIndex, endIndex);
          const id = `${filePath}::${dynMatch[1]}::${nodeId++}`;
          children.push(createSyntaxNode(id, "import_statement", `dynamic import ${dynMatch[1]}`, range, language));
        }
      }

      // --- 4. Re-exports (Fix 2) ---
      // export * from "./path", export { X } from "./path", export { default as X } from "./path"
      const reExportMatch = trimmed.match(/export\s+(?:\*\s+from\s+["']([^"']+)["']|\{[^}]*\}\s+from\s+["']([^"']+)["'])/);
      if (reExportMatch) {
        const reExportName = reExportMatch[1] || reExportMatch[2];
        if (reExportName) {
          const startIndex = content.indexOf(line);
          const endIndex = startIndex + line.length;
          const range = createSourceRange(lineIdx + 1, 1, lineIdx + 1, line.length, startIndex, endIndex);
          const id = `${filePath}::re-export:${reExportName}::${nodeId++}`;
          children.push(createSyntaxNode(id, "import_statement", `re-export ${reExportName}`, range, language));
        }
      }
    }

    // Root node wrapping all children
    const root: SyntaxNode = {
      id: `${filePath}::root`,
      kind: "program",
      text: content,
      range: createSourceRange(1, 1, lines.length, 1, 0, content.length),
      children,
      language,
    };

    return root;
  }

  private getPatternsForLanguage(language: Language): Array<{ kind: string; regex: RegExp }> {
    // Universal patterns that work across many languages
    const universal: Array<{ kind: string; regex: RegExp }> = [
      { kind: "function_declaration", regex: /(?:function|def|fn|func|fun|sub)\s+(\w+)/ },
      { kind: "class_declaration", regex: /(?:class|struct|trait|interface|type)\s+(\w+)/ },
      { kind: "variable_declaration", regex: /(?:let|var|const|val|var|let)\s+(\w+)/ },
      { kind: "import_statement", regex: /(?:import|use|require|include|from)\s+["']?([\w.\-/]+)/ },
      { kind: "export_statement", regex: /(?:export|module\.exports|pub\s+(?:fn|struct|enum|trait|fn|mod))\s+(?:default\s+)?(?:function|class|const|let|var|fn|struct|enum)?\s*(\w+)?/ },
    ];

    // Language-specific additions
    switch (language) {
      case "python":
        return [
          { kind: "function_declaration", regex: /def\s+(\w+)/ },
          { kind: "class_declaration", regex: /class\s+(\w+)/ },
          { kind: "import_statement", regex: /(?:import|from)\s+(\w+)/ },
        ];
      case "rust":
        return [
          { kind: "function_declaration", regex: /fn\s+(\w+)/ },
          { kind: "struct_declaration", regex: /struct\s+(\w+)/ },
          { kind: "enum_declaration", regex: /enum\s+(\w+)/ },
          { kind: "trait_declaration", regex: /trait\s+(\w+)/ },
          { kind: "import_statement", regex: /use\s+(\w+)/ },
        ];
      case "go":
        return [
          { kind: "function_declaration", regex: /func\s+(\w+)/ },
          { kind: "type_declaration", regex: /type\s+(\w+)/ },
          { kind: "import_statement", regex: /"([\w./-]+)"/ },
        ];
      default:
        return universal;
    }
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
