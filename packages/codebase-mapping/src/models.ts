import {
  Language,
  SymbolKind,
  LevelOfDetail,
  SerializationFormat,
  DeadCodeReason,
  ImplicitFlowKind,
  DocUpdateType,
  type Position,
  type SourceRange,
  type SyntaxNode,
  type ParseResult,
  type ExtractedSymbol,
  type SymbolReference,
  type DeadSymbol,
  type FileNode,
  type DependencyEdge,
  type DependencyGraph,
  type CompressedRepresentation,
  type DeltaChange,
  type SerializationData,
  type SerializedFile,
  type SerializedSymbol,
  type SerializedEdge,
  type SerializedImplicitFlow,
  type ConfigLink,
  type ImplicitFlow,
  type GitMetadata,
  type BlameInfo,
  type CommitInfo,
  type DocUpdate,
  type StaleDocReport,
  type DocGeneratorConfig,
  type MaskedSecret,
  type PIIDetection,
  type ComplianceBoundary,
  type CacheStats,
  type RootCache,
  type MappingEvent,
  type DocUpdateEvent,
  type CodebaseMappingConfig,
  type CodebaseMappingOptions,
  type CodebaseMappingAPI,
} from "./types.js";

// ============================================================
// Factory Functions
// ============================================================

export function createPosition(line: number, column: number): Position {
  return { line, column };
}

export function createSourceRange(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  startIndex: number,
  endIndex: number
): SourceRange {
  return {
    start: createPosition(startLine, startColumn),
    end: createPosition(endLine, endColumn),
    startIndex,
    endIndex,
  };
}

export function createSyntaxNode(
  id: string,
  kind: string,
  text: string,
  range: SourceRange,
  language: Language,
  children: SyntaxNode[] = []
): SyntaxNode {
  return { id, kind, text, range, children, language };
}

export function createExtractedSymbol(
  id: string,
  name: string,
  kind: SymbolKind,
  range: SourceRange,
  filePath: string,
  language: Language,
  parentId: string | null = null,
  children: string[] = [],
  typeAnnotation: string | null = null,
  generics: string[] = [],
  decorators: string[] = [],
  modifiers: string[] = [],
  visibility: "public" | "protected" | "private" | "internal" = "public",
  isExported = false,
  isDefault = false,
  isAsync = false,
  isAbstract = false,
  isStatic = false,
  documentation: string | null = null,
  references: SymbolReference[] = [],
  metadata: Record<string, unknown> = {}
): ExtractedSymbol {
  return {
    id, name, kind, range, filePath, language, parentId, children,
    typeAnnotation, generics, decorators, modifiers, visibility,
    isExported, isDefault, isAsync, isAbstract, isStatic,
    documentation, references, metadata,
  };
}

export function createSymbolReference(
  fromSymbolId: string,
  fromFilePath: string,
  toSymbolId: string,
  toFilePath: string,
  range: SourceRange,
  referenceKind: SymbolReference["referenceKind"],
  isDynamic = false
): SymbolReference {
  return { fromSymbolId, fromFilePath, toSymbolId, toFilePath, range, referenceKind, isDynamic };
}

export function createDeadSymbol(
  symbolId: string,
  name: string,
  kind: SymbolKind,
  filePath: string,
  reason: DeadCodeReason,
  confidence: number,
  evidence: string
): DeadSymbol {
  return { symbolId, name, kind, filePath, reason, confidence, evidence };
}

export function createFileNode(
  filePath: string,
  language: Language,
  size: number,
  contentHash: string,
  lastModified: number,
  symbols: string[] = [],
  imports: string[] = [],
  exports: string[] = [],
  pageRank = 0
): FileNode {
  return { filePath, language, size, contentHash, lastModified, symbols, imports, exports, pageRank };
}

export function createDependencyEdge(
  from: string,
  to: string,
  kind: DependencyEdge["kind"],
  isExternal = false,
  isDynamic = false
): DependencyEdge {
  return { from, to, kind, isExternal, isDynamic };
}

export function createDependencyGraph(
  files: Map<string, FileNode> = new Map(),
  edges: DependencyEdge[] = [],
  rootPaths: string[] = [],
  buildTimeMs = 0
): DependencyGraph {
  return { files, edges, rootPaths, buildTimeMs };
}

export function createCompressedRepresentation(
  filePath: string,
  lod: LevelOfDetail,
  originalSize: number,
  compressedSize: number,
  content: string,
  includedSymbols: string[] = [],
  excludedSymbols: string[] = []
): CompressedRepresentation {
  return {
    filePath, lod, originalSize, compressedSize,
    compressionRatio: originalSize > 0 ? compressedSize / originalSize : 0,
    content, includedSymbols, excludedSymbols,
  };
}

export function createDeltaChange(
  filePath: string,
  changeType: DeltaChange["changeType"],
  oldHash: string | null,
  newHash: string | null,
  diff: string | null,
  affectedSymbols: string[] = []
): DeltaChange {
  return { filePath, changeType, oldHash, newHash, diff, affectedSymbols };
}

export function createConfigLink(
  configFile: string,
  configType: ConfigLink["configType"],
  linkedFiles: string[] = [],
  keyValues: Record<string, string> = {}
): ConfigLink {
  return { configFile, configType, linkedFiles, keyValues };
}

export function createImplicitFlow(
  kind: ImplicitFlowKind,
  sourceFile: string,
  sourceSymbol: string,
  targetFile: string,
  targetSymbol: string,
  description: string,
  confidence = 0.5
): ImplicitFlow {
  return { kind, sourceFile, sourceSymbol, targetFile, targetSymbol, description, confidence };
}

export function createDocUpdate(
  filePath: string,
  symbolId: string,
  symbolName: string,
  oldDoc: string | null,
  newDoc: string,
  updateType: DocUpdateType,
  generatedAt: number = Date.now()
): DocUpdate {
  return { filePath, symbolId, symbolName, oldDoc, newDoc, updateType, generatedAt };
}

export function createStaleDocReport(
  filePath: string,
  symbolId: string,
  symbolName: string,
  existingDoc: string,
  detectedSignature: string,
  reason: string
): StaleDocReport {
  return { filePath, symbolId, symbolName, existingDoc, detectedSignature, reason };
}

export function createMaskedSecret(
  pattern: string,
  originalValue: string,
  maskedValue: string,
  filePath: string,
  line: number,
  column: number
): MaskedSecret {
  return { pattern, originalValue, maskedValue, filePath, line, column };
}

export function createPIIDetection(
  type: PIIDetection["type"],
  value: string,
  filePath: string,
  line: number,
  column: number
): PIIDetection {
  return { type, value, filePath, line, column };
}

export function createComplianceBoundary(
  pattern: string,
  type: ComplianceBoundary["type"],
  matchedFiles: string[] = []
): ComplianceBoundary {
  return { pattern, type, matchedFiles };
}

export function createCacheStats(
  astCacheSize = 0,
  symbolCacheSize = 0,
  graphCacheSize = 0,
  embeddingCacheSize = 0,
  astHitRate = 0,
  symbolHitRate = 0,
  graphHitRate = 0,
  embeddingHitRate = 0,
  totalEvictions = 0,
  memoryUsageBytes = 0
): CacheStats {
  return {
    astCacheSize, symbolCacheSize, graphCacheSize, embeddingCacheSize,
    astHitRate, symbolHitRate, graphHitRate, embeddingHitRate,
    totalEvictions, memoryUsageBytes,
  };
}

export function createRootCache(rootPath: string): RootCache {
  return {
    rootPath,
    astCache: new Map(),
    symbolCache: new Map(),
    graphCache: null,
    lastAccessed: Date.now(),
  };
}

export function createMappingEvent(
  type: MappingEvent["type"],
  data: Record<string, unknown> = {}
): MappingEvent {
  return { type, timestamp: Date.now(), data };
}

export function createDocUpdateEvent(updates: DocUpdate[]): DocUpdateEvent {
  return { type: "doc_updated", timestamp: Date.now(), updates };
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_CONFIG: CodebaseMappingConfig = {
  workspaceRoots: [],
  maxFileSize: 10 * 1024 * 1024, // 10MB
  cacheSize: 5000,
  contextWindowSize: 128000,
  excludedPatterns: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/vendor/**",
    "**/.turbo/**",
    "**/bin/**",
    "**/.vscode-test/**",
    "**/*.min.*",
    "**/*.bundle.*",
  ],
  allowedPatterns: [
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.py",
    "**/*.rs",
    "**/*.go",
    "**/*.java",
    "**/*.c",
    "**/*.cpp",
    "**/*.rb",
    "**/*.php",
    "**/*.sh",
    "**/*.json",
    "**/*.yaml",
    "**/*.yml",
    "**/*.md",
    "**/Dockerfile",
    "**/Makefile",
    "**/*.toml",
  ],
  enableSecretMasking: true,
  enablePIIDetection: true,
  enableDeadCodeDetection: true,
  enableCrossLanguageResolution: true,
  enableImplicitFlowTracking: true,
  enableGitIntegration: true,
  enableDocGenerator: true,
  enableDeltaMapping: true,
  logLevel: "info",
  parallelism: {
    maxFileReads: 100,
    maxParses: 50,
  },
};

// ============================================================
// Language Detection Helpers
// ============================================================

const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ".ts": Language.TypeScript,
  ".tsx": Language.TypeScript,
  ".js": Language.JavaScript,
  ".jsx": Language.JavaScript,
  ".mjs": Language.JavaScript,
  ".cjs": Language.JavaScript,
  ".py": Language.Python,
  ".rs": Language.Rust,
  ".go": Language.Go,
  ".java": Language.Java,
  ".c": Language.C,
  ".cpp": Language.Cpp,
  ".h": Language.Cpp,
  ".hpp": Language.Cpp,
  ".rb": Language.Ruby,
  ".php": Language.PHP,
  ".sh": Language.Shell,
  ".bash": Language.Shell,
  ".swift": Language.Swift,
  ".kt": Language.Kotlin,
  ".kts": Language.Kotlin,
  ".scala": Language.Scala,
  ".dart": Language.Dart,
  ".lua": Language.Lua,
  ".hs": Language.Haskell,
  ".ex": Language.Elixir,
  ".exs": Language.Elixir,
  ".clj": Language.Clojure,
  ".erl": Language.Erlang,
  ".r": Language.R,
  ".jl": Language.Julia,
  ".sql": Language.SQL,
  ".graphql": Language.GraphQL,
  ".gql": Language.GraphQL,
  ".yaml": Language.Yaml,
  ".yml": Language.Yaml,
  ".json": Language.Json,
  ".md": Language.Markdown,
  ".toml": Language.TOML,
};

export function detectLanguage(filePath: string): Language {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("dockerfile")) return Language.Dockerfile;
  if (lower.endsWith("makefile")) return Language.Makefile;
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex === -1) return Language.Unknown;
  const ext = lower.slice(dotIndex);
  return EXTENSION_TO_LANGUAGE[ext] ?? Language.Unknown;
}

export function isParseableLanguage(language: Language): boolean {
  return language !== Language.Unknown &&
         language !== Language.Yaml &&
         language !== Language.Json &&
         language !== Language.Markdown &&
         language !== Language.Dockerfile &&
         language !== Language.Makefile &&
         language !== Language.TOML &&
         language !== Language.SQL &&
         language !== Language.GraphQL;
}

// ============================================================
// Logging
// ============================================================

export function createLogger(level: CodebaseMappingConfig["logLevel"]) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level] ?? 1;

  return {
    debug: (...args: unknown[]) => { if (currentLevel <= 0) console.debug("[codebase-mapping:debug]", ...args); },
    info: (...args: unknown[]) => { if (currentLevel <= 1) console.info("[codebase-mapping:info]", ...args); },
    warn: (...args: unknown[]) => { if (currentLevel <= 2) console.warn("[codebase-mapping:warn]", ...args); },
    error: (...args: unknown[]) => { if (currentLevel <= 3) console.error("[codebase-mapping:error]", ...args); },
  };
}
