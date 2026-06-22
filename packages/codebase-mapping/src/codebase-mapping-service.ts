import { ASTParser } from "./ast-parser.js";
import { CacheManager } from "./cache-manager.js";
import { DEFAULT_CONFIG, createLogger } from "./models.js";
import { FileDiscovery } from "./file-discovery.js";
import { GraphBuilder } from "./graph-builder.js";
import { SecurityLayer } from "./security-layer.js";
import { Serializer } from "./serializer.js";
import { SymbolExtractor } from "./symbol-extractor.js";
import { TokenCompressor } from "./token-compressor.js";
import { DocGenerator } from "./doc-generator.js";
import { DeadCodeReason, DependencyGraph, DocUpdateType } from "./types.js";
import type {
  CodebaseMappingAPI,
  CodebaseMappingConfig,
  CodebaseMappingOptions,
  CompressedRepresentation,
  ConfigLink,
  DeadSymbol,
  DeltaChange,
  DocUpdate,
  ExtractedSymbol,
  FileNode,
  GitMetadata,
  ImplicitFlow,
  LevelOfDetail,
  MappingEvent,
  SerializationFormat,
  SerializationData,
} from "./types.js";
import { createDependencyEdge, createFileNode, detectLanguage } from "./models.js";

export class CodebaseMappingService implements CodebaseMappingAPI {
  private config: CodebaseMappingConfig;
  private logger: ReturnType<typeof createLogger>;
  private eventHandlers: Array<(event: MappingEvent) => void>;
  private initialized: boolean;

  fileDiscovery: FileDiscovery;
  astParser: ASTParser;
  symbolExtractor: SymbolExtractor;
  graphBuilder: GraphBuilder;
  tokenCompressor: TokenCompressor;
  serializer: Serializer;
  securityLayer: SecurityLayer;
  cacheManager: CacheManager;
  docGenerator: DocGenerator;

  private allParseResults: Map<string, import("./types.js").ParseResult>;
  private allSymbols: Map<string, ExtractedSymbol[]>;
  private currentGraph: DependencyGraph | null;
  private deadCodeResults: DeadSymbol[];
  private compressedResults: CompressedRepresentation[];
  /** Fix 3: Current scan status — "idle", "scanning", "completed" */
  public _scanStatus: "idle" | "scanning" | "completed" = "idle";
  /** Fix 6: Parse error count from last scan */
  public _lastScanErrors: number = 0;
  /** Number of files scanned so far in the current run */
  public _filesScanned: number = 0;
  /** Total file count for the current workspace scan */
  public _totalFilesToScan: number = 0;
  /** Provisional edge count accumulated during scanning (before graph build) */
  public _accumulatedEdges: number = 0;
  /** Cached file list from pre-count pass, reused in scan loop to avoid double walk */
  private _rootFileCache: Map<string, string[]>;
  /** Guard against concurrent scanWorkspace() calls */
  public _scanInProgress: boolean = false;
  /** Guard against concurrent updateSingleFile() calls */
  public _updateInProgress: boolean = false;
  /** A save/delete/folder-change event arrived while scanning — schedule a follow-up scan */
  private _pendingRescan: boolean = false;

  constructor(options?: CodebaseMappingOptions) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.logger = createLogger(this.config.logLevel);
    this.eventHandlers = [];
    this.initialized = false;

    this.fileDiscovery = new FileDiscovery(this.config);
    this.astParser = new ASTParser(this.config);
    this.symbolExtractor = new SymbolExtractor(this.config);
    this.graphBuilder = new GraphBuilder(this.config);
    this.tokenCompressor = new TokenCompressor(this.config);
    this.serializer = new Serializer(this.config);
    this.securityLayer = new SecurityLayer(this.config);
    this.cacheManager = new CacheManager(this.config);
    this.docGenerator = new DocGenerator(this.config);

    this.allParseResults = new Map();
    this.allSymbols = new Map();
    this.currentGraph = null;
    this.deadCodeResults = [];
    this.compressedResults = [];
    this._rootFileCache = new Map();
  }

  /** Reset partial scan state for force restart (clears stale intermediate data). */
  resetScanState(): void {
    this.allParseResults.clear();
    this.allSymbols.clear();
    this.currentGraph = null;
    this.deadCodeResults = [];
    this.compressedResults = [];
    this._filesScanned = 0;
    this._totalFilesToScan = 0;
    this._accumulatedEdges = 0;
    this._lastScanErrors = 0;
    this._scanInProgress = false;
    this._pendingRescan = false;
    this._updateInProgress = false;
    this._scanStatus = "idle";
    this._rootFileCache.clear();
  }

  async initialize(options?: CodebaseMappingOptions): Promise<void> {
    if (options) {
      this.config = { ...this.config, ...options };
    }
    this.logger.info("Initializing CodebaseMappingService");
    await this.astParser.initialize();
    this.initialized = true;
    this.emitEvent({ type: "scan_started", timestamp: Date.now(), data: {} });
  }

  async scanWorkspace(): Promise<void> {
    this.ensureInitialized();

    // Guard against concurrent scans — saves, folder changes, and manual refreshes can overlap
    if (this._scanInProgress) {
      this.logger.warn("Scan already in progress — queuing follow-up rescan");
      this._pendingRescan = true;
      return;
    }

    this.logger.info("Scanning workspace");
    this._scanInProgress = true;
    this._pendingRescan = false;
    this._updateInProgress = false;
    this._scanStatus = "scanning";
    this.emitEvent({ type: "scan_started", timestamp: Date.now(), data: {} });
    this._lastScanErrors = 0;
    this._filesScanned = 0;
    this._totalFilesToScan = 0;
    this._accumulatedEdges = 0;
    this._rootFileCache.clear();

    this.allParseResults.clear();
    this.allSymbols.clear();
    this.currentGraph = null;
    this.deadCodeResults = [];
    this.compressedResults = [];

    const allFileNodes: FileNode[] = [];
    const allEdges: import("./types.js").DependencyEdge[] = [];

    try {
      // Single pre-count pass: cache file lists to avoid double filesystem walk
      this._rootFileCache = new Map();
      for (const rootPath of this.config.workspaceRoots) {
        const files = await this.fileDiscovery.discoverFiles(rootPath);
        this._rootFileCache.set(rootPath, files);
        this._totalFilesToScan += files.length;
      }
      this.logger.info(`Total files to scan: ${this._totalFilesToScan}`);

      const PROGRESS_INTERVAL = 50;
      let filesSinceLastProgress = 0;

      for (const rootPath of this.config.workspaceRoots) {
        this.logger.info(`Scanning root: ${rootPath}`);
        const files = this._rootFileCache.get(rootPath) ?? [];
        this.logger.info(`Found ${files.length} files in ${rootPath}`);

        for (const filePath of files) {
          try {
            const { content, hash, size } = await this.fileDiscovery.readFile(filePath);
            const { masked } = this.securityLayer.maskSecrets(content, filePath);
            const language = detectLanguage(filePath);

            const fileNode = createFileNode(filePath, language, size, hash, Date.now());

            let parseResult = this.cacheManager.getAST(rootPath, filePath);
            if (!parseResult) {
              parseResult = await this.astParser.parse(filePath, masked, language);
              this.cacheManager.setAST(rootPath, filePath, parseResult);
            }

            this.allParseResults.set(filePath, parseResult);

            let symbols = this.cacheManager.getSymbols(rootPath, filePath);
            if (!symbols) {
              symbols = this.symbolExtractor.extractSymbols(parseResult);
              this.cacheManager.setSymbols(rootPath, filePath, symbols);
            }
            this.allSymbols.set(filePath, symbols);

            for (const sym of symbols) {
              const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string;
              if (metaKind === "import_statement") {
                fileNode.imports.push(sym.name);
                allEdges.push(createDependencyEdge(filePath, sym.name, "import", false, false));
              }
              if (metaKind === "export_statement") {
                fileNode.exports.push(sym.name);
              }
            }

            allFileNodes.push(fileNode);

            this._filesScanned++;
            this._accumulatedEdges = allEdges.length;
            filesSinceLastProgress++;

            if (filesSinceLastProgress >= PROGRESS_INTERVAL) {
              this.emitEvent({
                type: "file_added",
                timestamp: Date.now(),
                data: {
                  filePath,
                  symbolsFound: symbols.length,
                  filesScanned: this._filesScanned,
                  totalFiles: this._totalFilesToScan,
                  edgesAccumulated: this._accumulatedEdges,
                },
              });
              filesSinceLastProgress = 0;
            }
          } catch (err) {
            this.logger.error(`Error processing ${filePath}:`, err);
            this._lastScanErrors++;
            this._filesScanned++;
            filesSinceLastProgress++;
          }
        }
      }

      this.logger.info(`Building graph: ${allFileNodes.length} files, ${allEdges.length} edges`);
      this.currentGraph = this.graphBuilder.buildGraph(allFileNodes, allEdges);
      this.deadCodeResults = this.detectDeadCodeInternal();
      this.compressedResults = await this.compressInternal();

      this._scanStatus = "completed";
      this.emitEvent({
        type: "scan_completed",
        timestamp: Date.now(),
        data: {
          filesScanned: this._filesScanned,
          totalFiles: this._totalFilesToScan,
          edges: allEdges.length,
          deadSymbols: this.deadCodeResults.length,
          parseErrors: this._lastScanErrors,
        },
      });
      this.logger.info(
        `Scan complete: ${allFileNodes.length} files, ${allEdges.length} edges, ${this.deadCodeResults.length} dead symbols`,
      );
    } catch (err) {
      // Critical failure (e.g. disk error, permission denied) — reset status so UI doesn't stick on "scanning"
      this.logger.error("Scan failed with critical error:", err);
      this._scanStatus = "completed";
      this.emitEvent({
        type: "scan_completed",
        timestamp: Date.now(),
        data: {
          filesScanned: this._filesScanned,
          totalFiles: this._totalFilesToScan,
          edges: allEdges.length,
          deadSymbols: 0,
          parseErrors: this._lastScanErrors,
          criticalError: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      this._scanInProgress = false;
      // If a save/delete/folder-change arrived during scan, run again to catch it
      if (this._pendingRescan) {
        this._pendingRescan = false;
    this._updateInProgress = false;
        this.logger.info("Re-scanning to catch pending changes that arrived during previous scan");
        this.scanWorkspace().catch((reErr) => {
          this.logger.error("Follow-up rescan also failed:", reErr);
        });
      }
    }
  }

  onEvent(handler: (event: MappingEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  offEvent(handler: (event: MappingEvent) => void): void {
    const idx = this.eventHandlers.indexOf(handler);
    if (idx !== -1) {
      this.eventHandlers.splice(idx, 1);
    }
  }

  async getSymbol(name: string, filePath?: string): Promise<ExtractedSymbol | null> {
    this.ensureInitialized();
    for (const [fp, symbols] of this.allSymbols) {
      if (filePath && fp !== filePath) continue;
      const found = symbols.find((s) => s.name === name);
      if (found) return found;
    }
    return null;
  }

  async getSymbols(kind?: import("./types.js").SymbolKind): Promise<ExtractedSymbol[]> {
    this.ensureInitialized();
    const all: ExtractedSymbol[] = [];
    for (const symbols of this.allSymbols.values()) {
      if (kind) {
        all.push(...symbols.filter((s) => s.kind === kind));
      } else {
        all.push(...symbols);
      }
    }
    return all;
  }

  async getDependencyGraph(): Promise<DependencyGraph> {
    this.ensureInitialized();
    if (this.currentGraph) return this.currentGraph;
    return { files: new Map(), edges: [], rootPaths: this.config.workspaceRoots, buildTimeMs: 0 };
  }

  async getDeadCode(): Promise<DeadSymbol[]> {
    this.ensureInitialized();
    return this.deadCodeResults;
  }

  async getCompressedContext(lod?: LevelOfDetail): Promise<CompressedRepresentation[]> {
    this.ensureInitialized();
    if (this.compressedResults.length === 0) return [];
    if (lod === undefined) return this.compressedResults;
    return this.compressedResults.filter((c) => c.lod === lod);
  }

  async getDelta(_fromHash: string, _toHash: string): Promise<DeltaChange[]> {
    this.ensureInitialized();
    return [];
  }

  async serialize(format: SerializationFormat): Promise<string> {
    this.ensureInitialized();
    if (!this.currentGraph) return "";

    const allSymbols: ExtractedSymbol[] = [];
    for (const symbols of this.allSymbols.values()) {
      allSymbols.push(...symbols);
    }

    const data: SerializationData = {
      metadata: {
        workspaceRoots: this.config.workspaceRoots,
        totalFiles: this.currentGraph.files.size,
        totalSymbols: allSymbols.length,
        totalEdges: this.currentGraph.edges.length,
        generatedAt: Date.now(),
        format,
      },
      files: Array.from(this.currentGraph.files.values()).map((f) => ({
        path: f.filePath,
        language: f.language,
        size: f.size,
        symbolCount: f.symbols.length,
        importCount: f.imports.length,
        exportCount: f.exports.length,
        pageRank: f.pageRank,
      })),
      symbols: allSymbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
        range: s.range,
        parentId: s.parentId,
        typeAnnotation: s.typeAnnotation,
        isExported: s.isExported,
        visibility: s.visibility,
        documentation: s.documentation,
        referenceCount: s.references.length,
        pageRank: 0,
      })),
      edges: this.currentGraph.edges.map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind,
        isDynamic: e.isDynamic,
      })),
      deadCode: this.deadCodeResults,
      flows: [],
      configLinks: [],
      gitMetadata: null,
    };

    return this.serializer.serialize(data, format);
  }

  async getConfigLinks(): Promise<ConfigLink[]> {
    this.ensureInitialized();
    return [];
  }

  async getImplicitFlows(): Promise<ImplicitFlow[]> {
    this.ensureInitialized();
    return [];
  }

  async getGitMetadata(_filePath: string): Promise<GitMetadata | null> {
    this.ensureInitialized();
    return null;
  }

  async getCacheStats(): Promise<import("./types.js").CacheStats> {
    this.ensureInitialized();
    return this.cacheManager.getStats();
  }

  async persistCacheStats(storagePath: string): Promise<void> {
    const cm = this.cacheManager as any;
    const data = { astHits: cm.hits?.get("ast") ?? 0, astMisses: cm.misses?.get("ast") ?? 0, symbolHits: cm.hits?.get("symbol") ?? 0, symbolMisses: cm.misses?.get("symbol") ?? 0, graphHits: cm.hits?.get("graph") ?? 0, graphMisses: cm.misses?.get("graph") ?? 0, embeddingHits: cm.hits?.get("embedding") ?? 0, embeddingMisses: cm.misses?.get("embedding") ?? 0 };
    try { const fs = await import("fs/promises"); const p = await import("path"); await fs.writeFile(p.join(storagePath, "codebase-mapping-cache-stats.json"), JSON.stringify(data), "utf-8"); } catch {}
  }

  async restoreCacheStats(storagePath: string): Promise<void> {
    try { const fs = await import("fs/promises"); const p = await import("path"); const raw = await fs.readFile(p.join(storagePath, "codebase-mapping-cache-stats.json"), "utf-8"); const data = JSON.parse(raw); const cm = this.cacheManager as any; if (cm.hits && cm.misses && data.astHits != null) { cm.hits.set("ast", data.astHits); cm.misses.set("ast", data.astMisses); cm.hits.set("symbol", data.symbolHits); cm.misses.set("symbol", data.symbolMisses); cm.hits.set("graph", data.graphHits); cm.misses.set("graph", data.graphMisses); cm.hits.set("embedding", data.embeddingHits); cm.misses.set("embedding", data.embeddingMisses); } } catch {}
  }

  async updateSingleFile(filePath: string, rootPath: string): Promise<void> {
    this.ensureInitialized();
    if (!this.currentGraph || this._scanStatus !== "completed") {
      this.logger.info(`Graph not ready, fallback to full scan for ${filePath}`);
      await this.scanWorkspace(); return;
    }
    if (this._updateInProgress) {
      this.logger.warn(`Incremental update already in progress, queued after for ${filePath}`);
      this._pendingRescan = true; return;
    }
    this._updateInProgress = true;
    try {
      const { content, hash, size } = await this.fileDiscovery.readFile(filePath);
      const { masked } = this.securityLayer.maskSecrets(content, filePath);
      const language = detectLanguage(filePath);
      const parseResult = await this.astParser.parse(filePath, masked, language);
      this.cacheManager.setAST(rootPath, filePath, parseResult);
      this.allParseResults.set(filePath, parseResult);
      const symbols = this.symbolExtractor.extractSymbols(parseResult);
      this.cacheManager.setSymbols(rootPath, filePath, symbols);
      this.allSymbols.set(filePath, symbols);
      const imports: string[] = []; const exports: string[] = [];
      for (const sym of symbols) {
        const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string;
        if (metaKind === "import_statement") imports.push(sym.name);
        if (metaKind === "export_statement") exports.push(sym.name);
      }
      const fileNode = createFileNode(filePath, language, size, hash, Date.now());
      fileNode.imports = imports; fileNode.exports = exports;
      this.currentGraph!.files.set(filePath, fileNode);
      const newEdges: import("./types.js").DependencyEdge[] = [];
      for (const [fp, node] of this.currentGraph!.files) {
        for (const imp of node.imports) newEdges.push(createDependencyEdge(fp, imp, "import", false, false));
      }
      this.currentGraph!.edges = newEdges;
      this.deadCodeResults = this.detectDeadCodeInternal();
      this._filesScanned = this.currentGraph!.files.size;
      this._accumulatedEdges = newEdges.length;
      this.emitEvent({ type: "file_modified", timestamp: Date.now(), data: { filePath, symbolsFound: symbols.length } });
      this.logger.info(`Incremental update: ${filePath}: ${symbols.length} symbols, ${newEdges.length} edges`);
    } catch (err) {
      this.logger.error(`Incremental update failed for ${filePath}:`, err);
      this._lastScanErrors++; await this.scanWorkspace();
    } finally {
      this._updateInProgress = false;
    }
  }

  async getDocUpdates(): Promise<DocUpdate[]> {
    this.ensureInitialized();
    const updates: DocUpdate[] = [];
    for (const [filePath, symbols] of this.allSymbols) {
      for (const sym of symbols) {
        const doc = await this.docGenerator.generateDoc(sym.filePath, sym.name, sym.documentation ?? "");
        if (doc) {
          updates.push({
            filePath,
            symbolId: sym.id,
            symbolName: sym.name,
            oldDoc: sym.documentation,
            newDoc: doc.newDoc,
            updateType: DocUpdateType.JSDocRegenerated,
            generatedAt: Date.now(),
          });
        }
      }
    }
    return updates;
  }

  dispose(): void {
    this.logger.info("Disposing CodebaseMappingService");
    this.eventHandlers = [];
    this.cacheManager.clear();
    this.allParseResults.clear();
    this.allSymbols.clear();
    this.currentGraph = null;
    this.deadCodeResults = [];
    this.compressedResults = [];
    this.initialized = false;
    this._scanStatus = "completed";
    this._scanInProgress = false;
    this._pendingRescan = false;
    this._updateInProgress = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("CodebaseMappingService not initialized. Call initialize() first.");
    }
  }

  private emitEvent(event: MappingEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error("Event handler error:", err);
      }
    }
  }

  private detectDeadCodeInternal(): DeadSymbol[] {
    const dead: DeadSymbol[] = [];
    const allRefs = new Map<string, number>();

    for (const symbols of this.allSymbols.values()) {
      for (const sym of symbols) {
        allRefs.set(sym.id, (allRefs.get(sym.id) ?? 0) + sym.references.length);
      }
    }

    for (const symbols of this.allSymbols.values()) {
      for (const sym of symbols) {
        const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string;
        if ((allRefs.get(sym.id) ?? 0) === 0 && !sym.isExported && metaKind !== "import_statement" && metaKind !== "export_statement") {
          dead.push({
            symbolId: sym.id,
            name: sym.name,
            kind: sym.kind,
            filePath: sym.filePath,
            reason: DeadCodeReason.UnusedExport,
            confidence: 0.8,
            evidence: `Symbol ${sym.name} has no references`,
          });
        }
      }
    }

    return dead;
  }

  private async compressInternal(): Promise<CompressedRepresentation[]> {
    if (!this.currentGraph) return [];

    const results: CompressedRepresentation[] = [];
    for (const [filePath, parseResult] of this.allParseResults) {
      const symbols = this.allSymbols.get(filePath) ?? [];
      const content = parseResult.ast?.text ?? "";
      const compressed = this.tokenCompressor.compress(
        filePath,
        content,
        symbols,
      );
      results.push(compressed);
    }

    return results;
  }
}
