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
import type {
  CodebaseMappingAPI,
  CodebaseMappingConfig,
  CodebaseMappingOptions,
  CompressedRepresentation,
  ConfigLink,
  DeadSymbol,
  DeltaChange,
  DependencyGraph,
  DocUpdate,
  ExtractedSymbol,
  GitMetadata,
  ImplicitFlow,
  LevelOfDetail,
  MappingEvent,
  SerializationFormat,
} from "./types.js";

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
    this.logger.info("Scanning workspace");
    this.emitEvent({ type: "scan_started", timestamp: Date.now(), data: {} });

    for (const rootPath of this.config.workspaceRoots) {
      const files = await this.fileDiscovery.discoverFiles(rootPath);
      for (const filePath of files) {
        try {
          const { content } = await this.fileDiscovery.readFile(filePath);
          const { masked } = this.securityLayer.maskSecrets(content, filePath);
          const fileNode = await this.fileDiscovery.buildFileNode(filePath, rootPath);
          const parseResult = await this.astParser.parse(filePath, masked, fileNode.language);
          this.cacheManager.setAST(rootPath, filePath, parseResult);
          const symbols = this.symbolExtractor.extractSymbols(parseResult);
          this.cacheManager.setSymbols(rootPath, filePath, symbols);
        } catch (err) {
          this.logger.error(`Error processing ${filePath}:`, err);
        }
      }
    }

    this.emitEvent({ type: "scan_completed", timestamp: Date.now(), data: {} });
  }

  async getSymbol(name: string, filePath?: string): Promise<ExtractedSymbol | null> {
    this.ensureInitialized();
    // Symbol lookup will be implemented here
    return null;
  }

  async getSymbols(_kind?: import("./types.js").SymbolKind): Promise<ExtractedSymbol[]> {
    this.ensureInitialized();
    return [];
  }

  async getDependencyGraph(): Promise<DependencyGraph> {
    this.ensureInitialized();
    return { files: new Map(), edges: [], rootPaths: [], buildTimeMs: 0 };
  }

  async getDeadCode(): Promise<DeadSymbol[]> {
    this.ensureInitialized();
    return [];
  }

  async getCompressedContext(_lod?: LevelOfDetail): Promise<CompressedRepresentation[]> {
    this.ensureInitialized();
    return [];
  }

  async getDelta(_fromHash: string, _toHash: string): Promise<DeltaChange[]> {
    this.ensureInitialized();
    return [];
  }

  async serialize(_format: SerializationFormat): Promise<string> {
    this.ensureInitialized();
    return "";
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

  async getDocUpdates(): Promise<DocUpdate[]> {
    this.ensureInitialized();
    return [];
  }

  onEvent(handler: (event: MappingEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  dispose(): void {
    this.logger.info("Disposing CodebaseMappingService");
    this.eventHandlers = [];
    this.cacheManager.clear();
    this.initialized = false;
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
}
