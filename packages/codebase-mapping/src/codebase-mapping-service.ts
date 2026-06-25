import { stat } from "node:fs/promises"
import { ASTParser } from "./ast-parser.js"
import { CacheManager } from "./cache-manager.js"
import { DEFAULT_CONFIG, createLogger } from "./models.js"
import { FileDiscovery } from "./file-discovery.js"
import { GraphBuilder } from "./graph-builder.js"
import { SecurityLayer } from "./security-layer.js"
import { Serializer } from "./serializer.js"
import { SymbolExtractor } from "./symbol-extractor.js"
import { TokenCompressor } from "./token-compressor.js"
import { DocGenerator } from "./doc-generator.js"
import { DeadCodeReason, DependencyGraph, DocUpdateType, ImplicitFlowKind, SymbolKind } from "./types.js"
import type {
	BlameInfo,
	CacheStats,
	CodebaseMappingAPI,
	CodebaseMappingConfig,
	CodebaseMappingOptions,
	CommitInfo,
	CompressedRepresentation,
	ConfigLink,
	DeadSymbol,
	DeltaChange,
	DependencyEdge,
	DocUpdate,
	ExtractedSymbol,
	FileNode,
	GitMetadata,
	ImplicitFlow,
	LevelOfDetail,
	MappingEvent,
	ParseResult,
	SerializationFormat,
	SerializationData,
} from "./types.js"
import type { StaleDocReport } from "./types.js"
import { createDependencyEdge, createFileNode, detectLanguage } from "./models.js"

export class CodebaseMappingService implements CodebaseMappingAPI {
	private config: CodebaseMappingConfig
	private logger: ReturnType<typeof createLogger>
	private eventHandlers: Array<(event: MappingEvent) => void>
	private initialized: boolean

	fileDiscovery: FileDiscovery
	astParser: ASTParser
	symbolExtractor: SymbolExtractor
	graphBuilder: GraphBuilder
	tokenCompressor: TokenCompressor
	serializer: Serializer
	securityLayer: SecurityLayer
	cacheManager: CacheManager
	docGenerator: DocGenerator

	private allParseResults: Map<string, import("./types.js").ParseResult>
	private allSymbols: Map<string, ExtractedSymbol[]>
	private currentGraph: DependencyGraph | null
	private deadCodeResults: DeadSymbol[]
	private compressedResults: CompressedRepresentation[]
	/** Fix 3: Current scan status — "idle", "scanning", "completed" */
	public _scanStatus: "idle" | "scanning" | "completed" = "idle"
	/** Fix 6: Parse error count from last scan */
	public _lastScanErrors: number = 0
	/** Number of files scanned so far in the current run */
	public _filesScanned: number = 0
	/** Total file count for the current workspace scan */
	public _totalFilesToScan: number = 0
	/** Provisional edge count accumulated during scanning (before graph build) */
	public _accumulatedEdges: number = 0
	/** Cached file list from pre-count pass, reused in scan loop to avoid double walk */
	private _rootFileCache: Map<string, string[]>
	/** Snapshot of file hashes from the previous scan, for delta detection */
	private _previousFileHashes: Map<string, string> = new Map()
	/** Cached serialization data — invalidated when graph changes */
	private _cachedSerializationData: { data: SerializationData; format: SerializationFormat } | null = null
	/** Cached serialization data payload (format-independent) — invalidated when graph changes */
	private _cachedSerializationPayload: { flows: ImplicitFlow[]; configLinks: ConfigLink[]; gitMetadata: GitMetadata | null } | null = null
	/** Cached directory→files index for getConfigLinks() — invalidated when graph changes */
	private _cachedDirIndex: Map<string, string[]> | null = null
	/** Cached reference index for getImplicitFlows() — invalidated when graph changes */
	private _cachedRefIndex: Map<string, Array<{ filePath: string; name: string }>> | null = null
	/** Cached raw file content for config files (avoids re-reading from disk) */
	private _cachedRawContent: Map<string, string> = new Map()
	private _symbolByName: Map<string, ExtractedSymbol[]> = new Map()
	/** SymbolKind → ExtractedSymbol[] index for O(1) getSymbols(kind) */
	private _symbolsByKind: Map<string, ExtractedSymbol[]> = new Map()
	public _scanInProgress: boolean = false
	/** Timestamp when the last scan started (for stuck detection) */
	private _scanStartTime: number = 0
	/** Guard against concurrent updateSingleFile() calls */
	public _updateInProgress: boolean = false
	/** A save/delete/folder-change event arrived while scanning — schedule a follow-up scan */
	private _pendingRescan: boolean = false
	/** Max rescans in a chain to prevent infinite loops */
	private static readonly MAX_RESCAN_DEPTH = 3
	/** Current rescan depth in the chain */
	private _rescanDepth: number = 0

	constructor(options?: CodebaseMappingOptions) {
		this.config = { ...DEFAULT_CONFIG, ...options }
		this.logger = createLogger(this.config.logLevel)
		this.eventHandlers = []
		this.initialized = false

		this.fileDiscovery = new FileDiscovery(this.config)
		this.astParser = new ASTParser(this.config)
		this.symbolExtractor = new SymbolExtractor(this.config)
		this.graphBuilder = new GraphBuilder(this.config)
		this.tokenCompressor = new TokenCompressor(this.config)
		this.serializer = new Serializer(this.config)
		this.securityLayer = new SecurityLayer(this.config)
		this.cacheManager = new CacheManager(this.config)
		this.docGenerator = new DocGenerator(this.config)

		this.allParseResults = new Map()
		this.allSymbols = new Map()
		this.currentGraph = null
		this.deadCodeResults = []
		this.compressedResults = []
		this._rootFileCache = new Map()
	}

	/** Reset partial scan state for force restart (clears stale intermediate data). */
	resetScanState(): void {
		this.allParseResults.clear()
		this.allSymbols.clear()
		this._symbolByName.clear()
		this._symbolsByKind.clear()
		this.currentGraph = null
		this.deadCodeResults = []
		this.compressedResults = []
		this._filesScanned = 0
		this._totalFilesToScan = 0
		this._accumulatedEdges = 0
		this._lastScanErrors = 0
		this._scanInProgress = false
		this._pendingRescan = false
		this._rescanDepth = 0
		this._updateInProgress = false
		this._scanStatus = "idle"
		this._rootFileCache.clear()
		this._previousFileHashes.clear()
		this._cachedSerializationData = null
		this._cachedSerializationPayload = null
		this._cachedDirIndex = null
		this._cachedRefIndex = null
		this._cachedRawContent.clear()
	}

	async initialize(options?: CodebaseMappingOptions): Promise<void> {
		if (options) {
			this.config = { ...this.config, ...options }
		}
		this.logger.info("Initializing CodebaseMappingService")
		await this.astParser.initialize()
		this.initialized = true
		this.emitEvent({ type: "scan_started", timestamp: Date.now(), data: {} })
	}

	/** Timeout for auto-detecting a stuck scan (10 minutes) */
	private static readonly SCAN_TIMEOUT_MS = 10 * 60 * 1000

	async scanWorkspace(): Promise<void> {
		this.ensureInitialized()

		// Auto-detect stuck scan — if scan has been running longer than timeout, force-reset
		if (this._scanInProgress) {
			const elapsed = Date.now() - this._scanStartTime
			if (elapsed > CodebaseMappingService.SCAN_TIMEOUT_MS) {
				this.logger.warn(`Scan stuck for ${Math.round(elapsed / 1000)}s, force-resetting`)
				this._scanInProgress = false
				this._scanStatus = "idle"
			} else {
				this.logger.warn("Scan already in progress — queuing follow-up rescan")
				this._pendingRescan = true
				return
			}
		}

		this.logger.info("Scanning workspace")
		this._scanInProgress = true
		this._pendingRescan = false
		this._updateInProgress = false
		this._scanStatus = "scanning"
		this._scanStartTime = Date.now()
		this._rescanDepth = 0
		this.emitEvent({ type: "scan_started", timestamp: Date.now(), data: {} })
		this._lastScanErrors = 0
		this._filesScanned = 0
		this._totalFilesToScan = 0
		this._accumulatedEdges = 0
		this._rootFileCache.clear()

		this.allParseResults.clear()
		this.allSymbols.clear()
		this._symbolByName.clear()
		this._symbolsByKind.clear()
		this.currentGraph = null
		this.deadCodeResults = []
		this.compressedResults = []

		const allFileNodes: FileNode[] = []
		const allEdges: import("./types.js").DependencyEdge[] = []

		try {
			// Single pre-count pass: cache file lists to avoid double filesystem walk
			this._rootFileCache = new Map()
			for (const rootPath of this.config.workspaceRoots) {
				const files = await this.fileDiscovery.discoverFiles(rootPath)
				this._rootFileCache.set(rootPath, files)
				this._totalFilesToScan += files.length
			}
			this.logger.info(`Total files to scan: ${this._totalFilesToScan}`)

			const PROGRESS_INTERVAL = 50
			let filesSinceLastProgress = 0

			for (const rootPath of this.config.workspaceRoots) {
				this.logger.info(`Scanning root: ${rootPath}`)
				const files = this._rootFileCache.get(rootPath) ?? []
				this.logger.info(`Found ${files.length} files in ${rootPath}`)

				for (const filePath of files) {
					try {
						// Skip files larger than maxFileSize — readFile + regex parse would hang
						const stats = await stat(filePath)
						if (stats.size > this.config.maxFileSize) {
							this.logger.warn(`Skipping oversized file (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${(this.config.maxFileSize / 1024 / 1024).toFixed(0)}MB): ${filePath}`)
							this._filesScanned++
							this._totalFilesToScan-- // adjust total since we're skipping
							filesSinceLastProgress++
							continue
						}
						const { content, hash, size } = await this.fileDiscovery.readFile(filePath)
						const { masked } = this.securityLayer.maskSecrets(content, filePath)
						const language = detectLanguage(filePath)

						const fileNode = createFileNode(filePath, language, size, hash, Date.now())

						let parseResult = this.cacheManager.getAST(rootPath, filePath)
						if (!parseResult) {
							parseResult = await this.astParser.parse(filePath, masked, language)
							this.cacheManager.setAST(rootPath, filePath, parseResult)
						}

						this.allParseResults.set(filePath, parseResult)

						let symbols = this.cacheManager.getSymbols(rootPath, filePath)
						if (!symbols) {
							symbols = this.symbolExtractor.extractSymbols(parseResult)
							this.cacheManager.setSymbols(rootPath, filePath, symbols)
						}
						this.allSymbols.set(filePath, symbols)
						// Populate symbol indexes
						for (const sym of symbols) {
							const byName = this._symbolByName.get(sym.name) ?? []
							byName.push(sym)
							this._symbolByName.set(sym.name, byName)
							const byKind = this._symbolsByKind.get(sym.kind) ?? []
							byKind.push(sym)
							this._symbolsByKind.set(sym.kind, byKind)
						}

						for (const sym of symbols) {
							const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string
							if (metaKind === "import_statement") {
								fileNode.imports.push(sym.name)
								allEdges.push(createDependencyEdge(filePath, sym.name, "import", false, false))
							}
							if (metaKind === "export_statement") {
								fileNode.exports.push(sym.name)
							}
						}

						allFileNodes.push(fileNode)

						this._filesScanned++
						this._accumulatedEdges = allEdges.length
						filesSinceLastProgress++

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
							})
							filesSinceLastProgress = 0
						}
					} catch (err) {
						this.logger.error(`Error processing ${filePath}:`, err)
						this._lastScanErrors++
						this._filesScanned++
						filesSinceLastProgress++
					}
				}
			}

			this.logger.info(`Building graph: ${allFileNodes.length} files, ${allEdges.length} edges`)
			this.currentGraph = this.graphBuilder.buildGraph(allFileNodes, allEdges)
			this.deadCodeResults = this.detectDeadCodeInternal()
			this.compressedResults = await this.compressInternal()
			this._cachedSerializationData = null
			this._cachedSerializationPayload = null
			this._cachedDirIndex = null
			this._cachedRefIndex = null
			this._cachedRawContent.clear()

			this._scanStatus = "completed"
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
			})
			this.logger.info(
				`Scan complete: ${allFileNodes.length} files, ${allEdges.length} edges, ${this.deadCodeResults.length} dead symbols`,
			)
			// Snapshot current file hashes for delta detection
			this._previousFileHashes.clear()
			for (const [fp, pr] of this.allParseResults) {
				this._previousFileHashes.set(fp, pr.contentHash)
			}
		} catch (err) {
			// Critical failure (e.g. disk error, permission denied) — reset status so UI doesn't stick on "scanning"
			this.logger.error("Scan failed with critical error:", err)
			this._scanStatus = "completed"
			// Still snapshot whatever we managed to parse, so delta detection has a baseline
			this._previousFileHashes.clear()
			for (const [fp, pr] of this.allParseResults) {
				this._previousFileHashes.set(fp, pr.contentHash)
			}
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
			})
		} finally {
			this._scanInProgress = false
			// If a save/delete/folder-change arrived during scan, run again to catch it
			if (this._pendingRescan && this._rescanDepth < CodebaseMappingService.MAX_RESCAN_DEPTH) {
				this._pendingRescan = false
				this._rescanDepth++
				this.logger.info(
					`Re-scanning to catch pending changes (depth ${this._rescanDepth}/${CodebaseMappingService.MAX_RESCAN_DEPTH})`,
				)
				this.scanWorkspace().catch((reErr) => {
					this.logger.error("Follow-up rescan also failed:", reErr)
				})
			} else if (this._pendingRescan) {
				this.logger.warn(
					`Rescan depth limit (${CodebaseMappingService.MAX_RESCAN_DEPTH}) reached, dropping pending rescan`,
				)
				this._pendingRescan = false
			}
		}
	}

	onEvent(handler: (event: MappingEvent) => void): void {
		this.eventHandlers.push(handler)
	}

	offEvent(handler: (event: MappingEvent) => void): void {
		const idx = this.eventHandlers.indexOf(handler)
		if (idx !== -1) {
			this.eventHandlers.splice(idx, 1)
		}
	}

	async getSymbol(name: string, filePath?: string): Promise<ExtractedSymbol | null> {
		this.ensureInitialized()
		if (filePath) {
			const symbols = this.allSymbols.get(filePath)
			return symbols?.find((s) => s.name === name) ?? null
		}
		const matches = this._symbolByName.get(name)
		return matches?.[0] ?? null
	}

	async getSymbols(kind?: import("./types.js").SymbolKind): Promise<ExtractedSymbol[]> {
		this.ensureInitialized()
		if (kind) {
			return this._symbolsByKind.get(kind) ?? []
		}
		const all: ExtractedSymbol[] = []
		for (const symbols of this.allSymbols.values()) {
			all.push(...symbols)
		}
		return all
	}

	async getDependencyGraph(): Promise<DependencyGraph> {
		this.ensureInitialized()
		if (this.currentGraph) return this.currentGraph
		return { files: new Map(), edges: [], rootPaths: this.config.workspaceRoots, buildTimeMs: 0 }
	}

	async getDeadCode(): Promise<DeadSymbol[]> {
		this.ensureInitialized()
		return this.deadCodeResults
	}

	async getCompressedContext(lod?: LevelOfDetail): Promise<CompressedRepresentation[]> {
		this.ensureInitialized()
		if (this.compressedResults.length === 0) return []
		if (lod === undefined) return this.compressedResults
		return this.compressedResults.filter((c) => c.lod === lod)
	}

	async getDelta(fromHash: string, toHash: string): Promise<DeltaChange[]> {
		this.ensureInitialized()
		const changes: DeltaChange[] = []

		// Deleted files: in previous snapshot but not in current parse results
		if (this._previousFileHashes.size > 0) {
			for (const [fp, oldHash] of this._previousFileHashes) {
				if (!this.allParseResults.has(fp)) {
					changes.push({
						filePath: fp,
						changeType: "deleted",
						oldHash,
						newHash: null,
						diff: null,
						affectedSymbols: [],
					})
				}
			}
		}

		// Added/modified files: in current parse results
		for (const [filePath, parseResult] of this.allParseResults) {
			const contentHash = parseResult.contentHash
			const oldHash = this._previousFileHashes.get(filePath)

			if (oldHash === undefined) {
				// New file — only report if toHash doesn't match (caller wants delta to a specific state)
				if (toHash && contentHash !== toHash) {
					const symbols = this.allSymbols.get(filePath) ?? []
					changes.push({
						filePath,
						changeType: "added",
						oldHash: null,
						newHash: contentHash,
						diff: null,
						affectedSymbols: symbols.map((s) => s.id),
					})
				}
			} else if (contentHash !== fromHash) {
				// Modified file — only report if content differs from the requested baseline
				const symbols = this.allSymbols.get(filePath) ?? []
				changes.push({
					filePath,
					changeType: "modified",
					oldHash,
					newHash: contentHash,
					diff: null,
					affectedSymbols: symbols.map((s) => s.id),
				})
			}
		}
		return changes
	}

	async serialize(format: SerializationFormat): Promise<string> {
		this.ensureInitialized()
		if (!this.currentGraph) return ""

		// Return cached serialization if available and format matches
		if (this._cachedSerializationData && this._cachedSerializationData.format === format) {
			return this.serializer.serialize(this._cachedSerializationData.data, format)
		}

		const allSymbols: ExtractedSymbol[] = []
		for (const symbols of this.allSymbols.values()) {
			allSymbols.push(...symbols)
		}

		// Use cached payload if available (format-independent)
		let flows: ImplicitFlow[]
		let configLinks: ConfigLink[]
		let gitMetadata: GitMetadata | null
		if (this._cachedSerializationPayload) {
			flows = this._cachedSerializationPayload.flows
			configLinks = this._cachedSerializationPayload.configLinks
			gitMetadata = this._cachedSerializationPayload.gitMetadata
		} else {
			;[flows, configLinks, gitMetadata] = await Promise.all([
				this.getImplicitFlows(),
				this.getConfigLinks(),
				this.getGitMetadata(this.config.workspaceRoots[0] ?? ""),
			])
			this._cachedSerializationPayload = { flows, configLinks, gitMetadata }
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
			flows,
			configLinks,
			gitMetadata,
		}

		this._cachedSerializationData = { data, format }
		return this.serializer.serialize(data, format)
	}

	async getConfigLinks(): Promise<ConfigLink[]> {
		this.ensureInitialized()
		const links: ConfigLink[] = []
		const configPatterns: Array<{ type: ConfigLink["configType"]; patterns: string[] }> = [
			{ type: "package.json", patterns: ["**/package.json"] },
			{ type: "tsconfig", patterns: ["**/tsconfig.json", "**/tsconfig.*.json"] },
			{ type: "Dockerfile", patterns: ["**/Dockerfile", "**/Dockerfile.*"] },
			{ type: "env", patterns: ["**/.env*", "**/.env.*"] },
			{ type: "Cargo.toml", patterns: ["**/Cargo.toml"] },
			{ type: "Makefile", patterns: ["**/Makefile", "**/makefile"] },
			{ type: "docker-compose", patterns: ["**/docker-compose*.yml", "**/docker-compose*.yaml"] },
			{ type: "eslint", patterns: ["**/.eslintrc*", "**/eslint.config.*"] },
			{ type: "prettier", patterns: ["**/.prettierrc*", "**/prettier.config.*"] },
			{ type: "babel", patterns: ["**/.babelrc*", "**/babel.config.*"] },
			{ type: "webpack", patterns: ["**/webpack.config.*"] },
			{ type: "vite", patterns: ["**/vite.config.*"] },
			{ type: "jest", patterns: ["**/jest.config.*", "**/jest.setup.*"] },
		]

		// Build directory index once (O(n)) instead of per-config-file (O(n²))
		if (!this._cachedDirIndex) {
			this._cachedDirIndex = new Map()
			for (const [fp] of this.allParseResults) {
				const dir = fp.substring(0, fp.lastIndexOf("/") + 1)
				const files = this._cachedDirIndex.get(dir) ?? []
				files.push(fp)
				this._cachedDirIndex.set(dir, files)
			}
		}

		const { minimatch } = await import("minimatch")
		for (const [filePath] of this.allParseResults) {
			for (const entry of configPatterns) {
				for (const pattern of entry.patterns) {
					if (minimatch(filePath, pattern)) {
						const dir = filePath.substring(0, filePath.lastIndexOf("/") + 1)
						const linkedFiles = (this._cachedDirIndex.get(dir) ?? []).filter((fp) => fp !== filePath)
						const keyValues: Record<string, string> = {}
						// Extract key values from package.json (use cached raw content, not masked AST text)
						if (entry.type === "package.json") {
							try {
								let raw = this._cachedRawContent.get(filePath)
								if (!raw) {
									const rawContent = await this.fileDiscovery.readFile(filePath)
									raw = rawContent.content
									this._cachedRawContent.set(filePath, raw)
								}
								const pkg = JSON.parse(raw)
								if (pkg.name) keyValues.name = pkg.name
								if (pkg.version) keyValues.version = pkg.version
								if (pkg.description) keyValues.description = pkg.description
							} catch {
								// Not valid JSON or file not readable — skip
							}
						}
						links.push({
							configFile: filePath,
							configType: entry.type,
							linkedFiles: linkedFiles.slice(0, 50),
							keyValues,
						})
						break
					}
				}
			}
		}
		return links
	}

	async getImplicitFlows(): Promise<ImplicitFlow[]> {
		this.ensureInitialized()
		const flows: ImplicitFlow[] = []
		if (!this.currentGraph) return flows

		// Build reference index once (O(n)) and cache it
		if (!this._cachedRefIndex) {
			this._cachedRefIndex = new Map()
			for (const [filePath, symbols] of this.allSymbols) {
				for (const sym of symbols) {
					for (const ref of sym.references) {
						const entries = this._cachedRefIndex.get(ref.toSymbolId) ?? []
						entries.push({ filePath, name: sym.name })
						this._cachedRefIndex.set(ref.toSymbolId, entries)
					}
				}
			}
		}
		const refIndex = this._cachedRefIndex

		// Event emitter flows: class_declaration with "event" in name → its referrers
		for (const [filePath, symbols] of this.allSymbols) {
			for (const sym of symbols) {
				const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string
				if (metaKind === "class_declaration" && sym.name.toLowerCase().includes("event")) {
					const referrers = refIndex.get(sym.id) ?? []
					for (const ref of referrers) {
						if (ref.filePath === filePath) continue
						flows.push({
							kind: ImplicitFlowKind.EventEmitter,
							sourceFile: filePath,
							sourceSymbol: sym.name,
							targetFile: ref.filePath,
							targetSymbol: ref.name,
							description: `${ref.name} in ${ref.filePath} uses event emitter ${sym.name}`,
							confidence: 0.6,
						})
					}
				}
			}
		}

		// Middleware chain flows: function/method with middleware-like name → its referrers
		const middlewarePattern = /middleware|handler|interceptor|filter/i
		for (const [filePath, symbols] of this.allSymbols) {
			for (const sym of symbols) {
				if (middlewarePattern.test(sym.name) && (sym.kind === SymbolKind.Function || sym.kind === SymbolKind.Method)) {
					const referrers = refIndex.get(sym.id) ?? []
					for (const ref of referrers) {
						if (ref.filePath === filePath) continue
						flows.push({
							kind: ImplicitFlowKind.MiddlewareChain,
							sourceFile: filePath,
							sourceSymbol: sym.name,
							targetFile: ref.filePath,
							targetSymbol: ref.name,
							description: `${ref.name} in ${ref.filePath} uses middleware ${sym.name}`,
							confidence: 0.5,
						})
					}
				}
			}
		}

		// Callback flows: parameters typed as callback
		for (const [, symbols] of this.allSymbols) {
			for (const sym of symbols) {
				if (sym.typeAnnotation && /=>|Function|Callback|Handler/i.test(sym.typeAnnotation)) {
					flows.push({
						kind: ImplicitFlowKind.Callback,
						sourceFile: sym.filePath,
						sourceSymbol: sym.name,
						targetFile: sym.filePath,
						targetSymbol: sym.name,
						description: `${sym.name} in ${sym.filePath} accepts a callback parameter`,
						confidence: 0.4,
					})
				}
			}
		}

		return flows
	}

	async getGitMetadata(filePath: string): Promise<GitMetadata | null> {
		this.ensureInitialized()
		if (!this.config.enableGitIntegration) return null

		try {
			const { execFile } = await import("child_process")
			const { promisify } = await import("util")
			const execFileAsync = promisify(execFile)
			const dir = filePath.substring(0, filePath.lastIndexOf("/") + 1) || "."

			// Git log — async, non-blocking
			const logResult = await execFileAsync("git", [
				"-C", dir, "log", "--oneline", "--follow",
				`--format=%H|%an|%at|%s`, "--", filePath,
			], { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "" }))

			const lines = logResult.stdout.trim().split("\n").filter(Boolean)
			if (lines.length === 0) return null

			const commitHistory: CommitInfo[] = []
			const authors = new Set<string>()
			let lastModifiedCommit = ""
			let lastModifiedDate = 0

			for (const line of lines) {
				const parts = line.split("|")
				if (parts.length >= 4) {
					const hash = parts[0] ?? ""
					const author = parts[1] ?? ""
					const date = parseInt(parts[2] ?? "0", 10) * 1000
					const message = parts.slice(3).join("|")

					commitHistory.push({
						hash,
						author,
						date,
						message,
						filesChanged: [filePath],
					})
					authors.add(author)

					if (date > lastModifiedDate) {
						lastModifiedDate = date
						lastModifiedCommit = hash
					}
				}
			}

			// Git blame — async, non-blocking, limited to 500 lines of porcelain output
			const blameResult = await execFileAsync("git", [
				"-C", dir, "blame", "--line-porcelain", filePath,
			], { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "" }))

			const blameLines = blameResult.stdout.split("\n").slice(0, 500)
			const blameInfo: BlameInfo[] = []
			let currentAuthor = ""
			let currentHash = ""
			let currentDate = 0
			let currentLine = 0

			for (const bl of blameLines) {
				if (bl.startsWith("author ")) {
					currentAuthor = bl.slice(7)
				} else if (bl.startsWith("author-time ")) {
					currentDate = parseInt(bl.slice(12), 10) * 1000
				} else if (/^[0-9a-f]{40}/.test(bl) && bl.includes(" ")) {
					const parts = bl.split(" ")
					currentHash = parts[0] ?? ""
					currentLine = parseInt(parts[1] ?? "0", 10)
				} else if (bl.startsWith("	") && currentHash) {
					blameInfo.push({
						line: currentLine,
						author: currentAuthor,
						commitHash: currentHash,
						date: currentDate,
						lineCount: 1,
					})
					currentHash = ""
				}
			}

			return {
				filePath,
				blameInfo: blameInfo.slice(0, 100),
				commitHistory: commitHistory.slice(0, 50),
				lastModifiedCommit,
				lastModifiedDate,
				changeFrequency: commitHistory.length,
				authors: Array.from(authors),
			}
		} catch (err) {
			this.logger.warn(`Git metadata unavailable for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
			return null
		}
	}

	async getCacheStats(): Promise<import("./types.js").CacheStats> {
		this.ensureInitialized()
		return this.cacheManager.getStats()
	}

	async persistCacheStats(storagePath: string): Promise<void> {
		const hits = this.cacheManager.getHitCounts()
		const misses = this.cacheManager.getMissCounts()
		const data = {
			astHits: hits.ast,
			astMisses: misses.ast,
			symbolHits: hits.symbol,
			symbolMisses: misses.symbol,
			graphHits: hits.graph,
			graphMisses: misses.graph,
			embeddingHits: hits.embedding,
			embeddingMisses: misses.embedding,
		}
		try {
			const fs = await import("fs/promises")
			const p = await import("path")
			const filePath = p.join(storagePath, "codebase-mapping-cache-stats.json")
			await fs.writeFile(filePath, JSON.stringify(data), "utf-8")
		} catch {
			// Silently ignore — cache stats are best-effort
		}
	}

	async restoreCacheStats(storagePath: string): Promise<void> {
		try {
			const fs = await import("fs/promises")
			const p = await import("path")
			const raw = await fs.readFile(p.join(storagePath, "codebase-mapping-cache-stats.json"), "utf-8")
			const data = JSON.parse(raw)
			if (data.astHits != null) {
				this.cacheManager.restoreCounts(
					{
						ast: data.astHits,
						symbol: data.symbolHits,
						graph: data.graphHits,
						embedding: data.embeddingHits,
					},
					{
						ast: data.astMisses,
						symbol: data.symbolMisses,
						graph: data.graphMisses,
						embedding: data.embeddingMisses,
					},
				)
			}
		} catch {
			// Silently ignore — cache stats are best-effort
		}
	}

	async updateSingleFile(filePath: string, rootPath: string): Promise<void> {
		this.ensureInitialized()
		if (!this.currentGraph || this._scanStatus !== "completed") {
			this.logger.info(`Graph not ready, queuing rescan for ${filePath}`)
			this._pendingRescan = true
			return
		}
		if (this._updateInProgress) {
			this.logger.warn(`Incremental update already in progress, queued after for ${filePath}`)
			this._pendingRescan = true
			return
		}
		this._updateInProgress = true
		try {
			const { content, hash, size } = await this.fileDiscovery.readFile(filePath)
			const { masked } = this.securityLayer.maskSecrets(content, filePath)
			const language = detectLanguage(filePath)
			const parseResult = await this.astParser.parse(filePath, masked, language)
			this.cacheManager.setAST(rootPath, filePath, parseResult)
			this.allParseResults.set(filePath, parseResult)
			const symbols = this.symbolExtractor.extractSymbols(parseResult)
			this.cacheManager.setSymbols(rootPath, filePath, symbols)
			this.allSymbols.set(filePath, symbols)
			// Update symbol indexes: remove old entries for this file, add new ones
			for (const [name, entries] of this._symbolByName) {
				const filtered = entries.filter((e) => e.filePath !== filePath)
				if (filtered.length > 0) {
					this._symbolByName.set(name, filtered)
				} else {
					this._symbolByName.delete(name)
				}
			}
			for (const [kind, entries] of this._symbolsByKind) {
				const filtered = entries.filter((e) => e.filePath !== filePath)
				if (filtered.length > 0) {
					this._symbolsByKind.set(kind, filtered)
				} else {
					this._symbolsByKind.delete(kind)
				}
			}
			for (const sym of symbols) {
				const byName = this._symbolByName.get(sym.name) ?? []
				byName.push(sym)
				this._symbolByName.set(sym.name, byName)
				const byKind = this._symbolsByKind.get(sym.kind) ?? []
				byKind.push(sym)
				this._symbolsByKind.set(sym.kind, byKind)
			}
			const imports: string[] = []
			const exports: string[] = []
			for (const sym of symbols) {
				const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string
				if (metaKind === "import_statement") imports.push(sym.name)
				if (metaKind === "export_statement") exports.push(sym.name)
			}
			const fileNode = createFileNode(filePath, language, size, hash, Date.now())
			fileNode.imports = imports
			fileNode.exports = exports
			this.currentGraph!.files.set(filePath, fileNode)
			const newEdges: import("./types.js").DependencyEdge[] = []
			for (const [fp, node] of this.currentGraph!.files) {
				for (const imp of node.imports) newEdges.push(createDependencyEdge(fp, imp, "import", false, false))
			}
			this.currentGraph!.edges = newEdges
			this.deadCodeResults = this.detectDeadCodeInternal()
			this._filesScanned = this.currentGraph!.files.size
			this._accumulatedEdges = newEdges.length
			this.emitEvent({
				type: "file_modified",
				timestamp: Date.now(),
				data: { filePath, symbolsFound: symbols.length },
			})
			this.logger.info(`Incremental update: ${filePath}: ${symbols.length} symbols, ${newEdges.length} edges`)
			// Update hash snapshot for delta detection
			this._previousFileHashes.set(filePath, hash)
			// Invalidate all caches
			this._cachedSerializationData = null
			this._cachedSerializationPayload = null
			this._cachedDirIndex = null
			this._cachedRefIndex = null
			this._cachedRawContent.clear()
		} catch (err) {
			this.logger.error(`Incremental update failed for ${filePath}:`, err)
			this._lastScanErrors++
			await this.scanWorkspace()
		} finally {
			this._updateInProgress = false
		}
	}

	async getDocUpdates(limit = 1000, offset = 0): Promise<{ updates: DocUpdate[]; staleReports: StaleDocReport[] }> {
		this.ensureInitialized()
		if (!this.config.enableDocGenerator) return { updates: [], staleReports: [] }

		const docConfig = this.docGenerator.getConfig()
		if (!docConfig.enabled) return { updates: [], staleReports: [] }

		const updates: DocUpdate[] = []
		const staleReports: StaleDocReport[] = []
		let staleChecked = 0
		const maxStaleChecks = docConfig.watchDocFiles ? Infinity : limit * 2

		// Pre-pass: collect stale reports sequentially (no shared mutable state in concurrent code)
		// and build eligible list for doc generation (only symbols without existing docs)
		const eligible: Array<{ sym: ExtractedSymbol; sourceCode: string }> = []
		for (const [filePath, symbols] of this.allSymbols) {
			const parseResult = this.allParseResults.get(filePath)
			const sourceCode = parseResult?.ast?.text ?? ""

			for (const sym of symbols) {
				const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string
				if (metaKind === "import_statement" || metaKind === "export_statement") continue
				if (!docConfig.autoRegenerateJSDoc && !docConfig.autoRegenerateTSDoc) continue

				// Stale detection for symbols with existing docs (sequential, no race)
				if (sym.documentation) {
					if (staleChecked < maxStaleChecks) {
						staleChecked++
						const stale = this.docGenerator.detectStaleDocs(sym.filePath, sourceCode, sym.documentation)
						if (stale) staleReports.push(stale)
					}
					continue // never generate new docs for symbols that already have docs
				}

				// Only symbols without docs go into the eligible batch
				eligible.push({ sym, sourceCode })
				if (eligible.length >= offset + limit) break
			}
			if (eligible.length >= offset + limit) break
		}

		// Apply offset
		const batch = eligible.slice(offset, offset + limit)

		// Process doc generation with concurrency limit
		const CONCURRENCY = 50
		for (let i = 0; i < batch.length; i += CONCURRENCY) {
			const slice = batch.slice(i, i + CONCURRENCY)
			const results = await Promise.all(
				slice.map(async ({ sym, sourceCode }) => {
					const useTSDoc = docConfig.autoRegenerateTSDoc && !docConfig.autoRegenerateJSDoc
					const doc = await this.docGenerator.generateDoc(sym.filePath, sym.name, sourceCode, useTSDoc)
					if (!doc) return null

					const finalDoc = doc.newDoc.length > docConfig.maxDocSize
						? doc.newDoc.slice(0, docConfig.maxDocSize) + "\n// [truncated]"
						: doc.newDoc

					const oldDoc = sym.documentation
					sym.documentation = finalDoc

					return {
						filePath: sym.filePath,
						symbolId: sym.id,
						symbolName: sym.name,
						oldDoc,
						newDoc: finalDoc,
						updateType: useTSDoc ? DocUpdateType.TSDocRegenerated : DocUpdateType.JSDocRegenerated,
						generatedAt: Date.now(),
					} satisfies DocUpdate
				}),
			)
			for (const r of results) {
				if (r) updates.push(r)
			}
		}

		// Handle README updates if enabled
		if (docConfig.autoUpdateREADME) {
			for (const [filePath] of this.allParseResults) {
				if (filePath.endsWith("README.md")) {
					// README update would go here — placeholder for future implementation
					this.logger.debug(`README update requested for ${filePath} (autoUpdateREADME enabled)`)
				}
			}
		}

		// Emit doc_updated event if any updates or stale reports
		if (updates.length > 0 || staleReports.length > 0) {
			this.emitEvent({
				type: "doc_updated",
				timestamp: Date.now(),
				data: {
					updatesGenerated: updates.length,
					staleDocsDetected: staleReports.length,
				},
			})
		}

		return { updates, staleReports }
	}

	dispose(): void {
		this.logger.info("Disposing CodebaseMappingService")
		this.eventHandlers = []
		this.cacheManager.clear()
		this.allParseResults.clear()
		this.allSymbols.clear()
		this._symbolByName.clear()
		this._symbolsByKind.clear()
		this.currentGraph = null
		this.deadCodeResults = []
		this.compressedResults = []
		this.initialized = false
		this._scanStatus = "completed"
		this._scanInProgress = false
		this._pendingRescan = false
		this._rescanDepth = 0
		this._updateInProgress = false
		this._previousFileHashes.clear()
		this._cachedRawContent.clear()
	}

	private ensureInitialized(): void {
		if (!this.initialized) {
			throw new Error("CodebaseMappingService not initialized. Call initialize() first.")
		}
	}

	private emitEvent(event: MappingEvent): void {
		for (const handler of this.eventHandlers) {
			try {
				handler(event)
			} catch (err) {
				this.logger.error("Event handler error:", err)
			}
		}
	}

	private detectDeadCodeInternal(): DeadSymbol[] {
		const dead: DeadSymbol[] = []
		const allRefs = new Map<string, number>()

		for (const symbols of this.allSymbols.values()) {
			for (const sym of symbols) {
				allRefs.set(sym.id, (allRefs.get(sym.id) ?? 0) + sym.references.length)
			}
		}

		for (const symbols of this.allSymbols.values()) {
			for (const sym of symbols) {
				const metaKind = (sym.metadata as Record<string, unknown>)?.kind as string
				if (
					(allRefs.get(sym.id) ?? 0) === 0 &&
					!sym.isExported &&
					metaKind !== "import_statement" &&
					metaKind !== "export_statement"
				) {
					dead.push({
						symbolId: sym.id,
						name: sym.name,
						kind: sym.kind,
						filePath: sym.filePath,
						reason: DeadCodeReason.UnusedExport,
						confidence: 0.8,
						evidence: `Symbol ${sym.name} has no references`,
					})
				}
			}
		}

		return dead
	}

	private async compressInternal(): Promise<CompressedRepresentation[]> {
		if (!this.currentGraph) return []

		const results: CompressedRepresentation[] = []
		for (const [filePath, parseResult] of this.allParseResults) {
			const symbols = this.allSymbols.get(filePath) ?? []
			const content = parseResult.ast?.text ?? ""
			const compressed = this.tokenCompressor.compress(filePath, content, symbols)
			results.push(compressed)
		}

		return results
	}
}
