// ============================================================
// Core Enums
// ============================================================

export enum Language {
  TypeScript = "typescript",
  JavaScript = "javascript",
  Python = "python",
  Rust = "rust",
  Go = "go",
  Java = "java",
  C = "c",
  Cpp = "cpp",
  Ruby = "ruby",
  PHP = "php",
  Shell = "shell",
  Swift = "swift",
  Kotlin = "kotlin",
  Scala = "scala",
  Dart = "dart",
  Lua = "lua",
  Haskell = "haskell",
  Elixir = "elixir",
  Clojure = "clojure",
  Erlang = "erlang",
  R = "r",
  Julia = "julia",
  SQL = "sql",
  GraphQL = "graphql",
  Yaml = "yaml",
  Json = "json",
  Markdown = "markdown",
  Dockerfile = "dockerfile",
  Makefile = "makefile",
  TOML = "toml",
  Unknown = "unknown",
}

export enum SymbolKind {
  Class = "class",
  Interface = "interface",
  Type = "type",
  Enum = "enum",
  Function = "function",
  Method = "method",
  Property = "property",
  Variable = "variable",
  Constant = "constant",
  Parameter = "parameter",
  Module = "module",
  Namespace = "namespace",
  Decorator = "decorator",
  Generic = "generic",
  Constructor = "constructor",
  Getter = "getter",
  Setter = "setter",
  Event = "event",
  Mixin = "mixin",
  Alias = "alias",
}

export enum LevelOfDetail {
  L0_Summary = 0,
  L1_Signatures = 1,
  L2_Declarations = 2,
  L3_Implementation = 3,
  L4_FullSource = 4,
}

export enum SerializationFormat {
  JSON = "json",
  Mermaid = "mermaid",
  Graphviz = "graphviz",
  ASCII = "ascii",
  HTML = "html",
  Markdown = "markdown",
}

export enum DeadCodeReason {
  UnusedExport = "unused_export",
  UnreachableCode = "unreachable_code",
  OrphanFunction = "orphan_function",
  UnusedParameter = "unused_parameter",
  UnusedVariable = "unused_variable",
  DeadBranch = "dead_branch",
  UnusedType = "unused_type",
  UnusedImport = "unused_import",
}

export enum ImplicitFlowKind {
  EventEmitter = "event_emitter",
  MiddlewareChain = "middleware_chain",
  DependencyInjection = "dependency_injection",
  Callback = "callback",
  PromiseChain = "promise_chain",
  Observable = "observable",
  MessageBus = "message_bus",
  PluginSystem = "plugin_system",
}

export enum DocUpdateType {
  JSDocRegenerated = "jsdoc_regenerated",
  TSDocRegenerated = "tsdoc_regenerated",
  READMEUpdated = "readme_updated",
  APIDocGenerated = "api_doc_generated",
  StaleDocDetected = "stale_doc_detected",
}

// ============================================================
// Position & Range
// ============================================================

export interface Position {
  line: number;
  column: number;
}

export interface SourceRange {
  start: Position;
  end: Position;
  startIndex: number;
  endIndex: number;
}

// ============================================================
// AST & Syntax
// ============================================================

export interface SyntaxNode {
  id: string;
  kind: string;
  text: string;
  range: SourceRange;
  children: SyntaxNode[];
  language: Language;
}

export interface ParseResult {
  filePath: string;
  language: Language;
  ast: SyntaxNode | null;
  contentHash: string;
  parseTimeMs: number;
  error: string | null;
  extractedAt: number;
}

// ============================================================
// Symbols
// ============================================================

export interface ExtractedSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  range: SourceRange;
  filePath: string;
  language: Language;
  parentId: string | null;
  children: string[];
  typeAnnotation: string | null;
  generics: string[];
  decorators: string[];
  modifiers: string[];
  visibility: "public" | "protected" | "private" | "internal";
  isExported: boolean;
  isDefault: boolean;
  isAsync: boolean;
  isAbstract: boolean;
  isStatic: boolean;
  documentation: string | null;
  references: SymbolReference[];
  metadata: Record<string, unknown>;
}

export interface SymbolReference {
  fromSymbolId: string;
  fromFilePath: string;
  toSymbolId: string;
  toFilePath: string;
  range: SourceRange;
  referenceKind: "import" | "call" | "instantiation" | "extension" | "implementation" | "usage" | "type_reference";
  isDynamic: boolean;
}

export interface DeadSymbol {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  reason: DeadCodeReason;
  confidence: number;
  evidence: string;
}

// ============================================================
// Dependency Graph
// ============================================================

export interface FileNode {
  filePath: string;
  language: Language;
  size: number;
  contentHash: string;
  lastModified: number;
  symbols: string[];
  imports: string[];
  exports: string[];
  pageRank: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: "import" | "dynamic_import" | "require" | "type_import" | "re_export";
  isExternal: boolean;
  isDynamic: boolean;
}

export interface DependencyGraph {
  files: Map<string, FileNode>;
  edges: DependencyEdge[];
  rootPaths: string[];
  buildTimeMs: number;
}

// ============================================================
// Token Compression
// ============================================================

export interface CompressedRepresentation {
  filePath: string;
  lod: LevelOfDetail;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  content: string;
  includedSymbols: string[];
  excludedSymbols: string[];
}

export interface DeltaChange {
  filePath: string;
  changeType: "added" | "modified" | "deleted";
  oldHash: string | null;
  newHash: string | null;
  diff: string | null;
  affectedSymbols: string[];
}

// ============================================================
// Serialization
// ============================================================

export interface SerializationData {
  metadata: {
    workspaceRoots: string[];
    totalFiles: number;
    totalSymbols: number;
    totalEdges: number;
    generatedAt: number;
    format: SerializationFormat;
  };
  files: SerializedFile[];
  symbols: SerializedSymbol[];
  edges: SerializedEdge[];
  deadCode: DeadSymbol[];
  flows: SerializedImplicitFlow[];
  configLinks: ConfigLink[];
  gitMetadata: GitMetadata | null;
}

export interface SerializedFile {
  path: string;
  language: Language;
  size: number;
  symbolCount: number;
  importCount: number;
  exportCount: number;
  pageRank: number;
}

export interface SerializedSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  range: SourceRange;
  parentId: string | null;
  typeAnnotation: string | null;
  isExported: boolean;
  visibility: string;
  documentation: string | null;
  referenceCount: number;
  pageRank: number;
}

export interface SerializedEdge {
  from: string;
  to: string;
  kind: string;
  isDynamic: boolean;
}

export interface SerializedImplicitFlow {
  kind: ImplicitFlowKind;
  sourceFile: string;
  sourceSymbol: string;
  targetFile: string;
  targetSymbol: string;
  description: string;
}

// ============================================================
// Contextual Intelligence
// ============================================================

export interface ConfigLink {
  configFile: string;
  configType: "package.json" | "tsconfig" | "Dockerfile" | "env" | "Cargo.toml" | "Makefile" | "docker-compose" | "eslint" | "prettier" | "babel" | "webpack" | "vite" | "jest" | "other";
  linkedFiles: string[];
  keyValues: Record<string, string>;
}

export interface ImplicitFlow {
  kind: ImplicitFlowKind;
  sourceFile: string;
  sourceSymbol: string;
  targetFile: string;
  targetSymbol: string;
  description: string;
  confidence: number;
}

export interface GitMetadata {
  filePath: string;
  blameInfo: BlameInfo[];
  commitHistory: CommitInfo[];
  lastModifiedCommit: string;
  lastModifiedDate: number;
  changeFrequency: number;
  authors: string[];
}

export interface BlameInfo {
  line: number;
  author: string;
  commitHash: string;
  date: number;
  lineCount: number;
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: number;
  message: string;
  filesChanged: string[];
}

// ============================================================
// Documentation
// ============================================================

export interface DocUpdate {
  filePath: string;
  symbolId: string;
  symbolName: string;
  oldDoc: string | null;
  newDoc: string;
  updateType: DocUpdateType;
  generatedAt: number;
}

export interface StaleDocReport {
  filePath: string;
  symbolId: string;
  symbolName: string;
  existingDoc: string;
  detectedSignature: string;
  reason: string;
}

export interface DocGeneratorConfig {
  enabled: boolean;
  autoRegenerateJSDoc: boolean;
  autoRegenerateTSDoc: boolean;
  autoUpdateREADME: boolean;
  watchDocFiles: boolean;
  maxDocSize: number;
}

// ============================================================
// Security
// ============================================================

export interface MaskedSecret {
  pattern: string;
  originalValue: string;
  maskedValue: string;
  filePath: string;
  line: number;
  column: number;
}

export interface PIIDetection {
  type: "email" | "phone" | "ssn" | "credit_card" | "ip_address" | "custom";
  value: string;
  filePath: string;
  line: number;
  column: number;
}

export interface ComplianceBoundary {
  pattern: string;
  type: "gitignore" | "rooignore" | "custom_deny" | "custom_allow";
  matchedFiles: string[];
}

// ============================================================
// Cache
// ============================================================

export interface CacheStats {
  astCacheSize: number;
  symbolCacheSize: number;
  graphCacheSize: number;
  embeddingCacheSize: number;
  astHitRate: number;
  symbolHitRate: number;
  graphHitRate: number;
  embeddingHitRate: number;
  totalEvictions: number;
  memoryUsageBytes: number;
}

export interface RootCache {
  rootPath: string;
  astCache: Map<string, ParseResult>;
  symbolCache: Map<string, ExtractedSymbol[]>;
  graphCache: DependencyGraph | null;
  lastAccessed: number;
}

// ============================================================
// Events
// ============================================================

export interface MappingEvent {
  type: "scan_started" | "scan_completed" | "file_added" | "file_modified" | "file_deleted" | "symbol_updated" | "graph_updated" | "error" | "cache_evicted" | "secret_detected" | "doc_updated";
  timestamp: number;
  data: Record<string, unknown>;
}

export interface DocUpdateEvent {
  type: "doc_updated";
  timestamp: number;
  updates: DocUpdate[];
}

// ============================================================
// Configuration
// ============================================================

export interface CodebaseMappingConfig {
  workspaceRoots: string[];
  maxFileSize: number;
  cacheSize: number;
  contextWindowSize: number;
  excludedPatterns: string[];
  allowedPatterns: string[];
  enableSecretMasking: boolean;
  enablePIIDetection: boolean;
  enableDeadCodeDetection: boolean;
  enableCrossLanguageResolution: boolean;
  enableImplicitFlowTracking: boolean;
  enableGitIntegration: boolean;
  enableDocGenerator: boolean;
  enableDeltaMapping: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  parallelism: {
    maxFileReads: number;
    maxParses: number;
  };
}

export interface CodebaseMappingOptions extends Partial<CodebaseMappingConfig> {}

// ============================================================
// Service Interface
// ============================================================

export interface CodebaseMappingAPI {
  initialize(options?: CodebaseMappingOptions): Promise<void>;
  scanWorkspace(): Promise<void>;
  getSymbol(name: string, filePath?: string): Promise<ExtractedSymbol | null>;
  getSymbols(kind?: SymbolKind): Promise<ExtractedSymbol[]>;
  getDependencyGraph(): Promise<DependencyGraph>;
  getDeadCode(): Promise<DeadSymbol[]>;
  getCompressedContext(lod?: LevelOfDetail): Promise<CompressedRepresentation[]>;
  getDelta(fromHash: string, toHash: string): Promise<DeltaChange[]>;
  serialize(format: SerializationFormat): Promise<string>;
  getConfigLinks(): Promise<ConfigLink[]>;
  getImplicitFlows(): Promise<ImplicitFlow[]>;
  getGitMetadata(filePath: string): Promise<GitMetadata | null>;
  getCacheStats(): Promise<CacheStats>;
  getDocUpdates(): Promise<DocUpdate[]>;
  onEvent(handler: (event: MappingEvent) => void): void;
  offEvent(handler: (event: MappingEvent) => void): void;
  dispose(): void;
}
