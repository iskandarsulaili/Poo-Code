import { DEFAULT_CONFIG, createLogger } from "./models.js";
import type { CacheStats, CodebaseMappingConfig, ExtractedSymbol, ParseResult, RootCache } from "./types.js";

export class CacheManager {
  private config: CodebaseMappingConfig;
  private logger: ReturnType<typeof createLogger>;
  private roots: Map<string, RootCache>;
  private hits: Map<string, number>;
  private misses: Map<string, number>;
  private evictions: number;

  constructor(config: Partial<CodebaseMappingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger(this.config.logLevel);
    this.roots = new Map();
    this.hits = new Map();
    this.misses = new Map();
    this.evictions = 0;
  }

  getAST(rootPath: string, filePath: string): ParseResult | null {
    const root = this.roots.get(rootPath);
    if (!root) {
      this.recordMiss("ast");
      return null;
    }
    const result = root.astCache.get(filePath) ?? null;
    if (result) {
      this.recordHit("ast");
      root.lastAccessed = Date.now();
    } else {
      this.recordMiss("ast");
    }
    return result;
  }

  setAST(rootPath: string, filePath: string, result: ParseResult): void {
    let root = this.roots.get(rootPath);
    if (!root) {
      root = { rootPath, astCache: new Map(), symbolCache: new Map(), graphCache: null, lastAccessed: Date.now() };
      this.roots.set(rootPath, root);
    }
    this.ensureCapacity(root.astCache);
    root.astCache.set(filePath, result);
    root.lastAccessed = Date.now();
  }

  getSymbols(rootPath: string, filePath: string): ExtractedSymbol[] | null {
    const root = this.roots.get(rootPath);
    if (!root) {
      this.recordMiss("symbol");
      return null;
    }
    const result = root.symbolCache.get(filePath) ?? null;
    if (result) {
      this.recordHit("symbol");
      root.lastAccessed = Date.now();
    } else {
      this.recordMiss("symbol");
    }
    return result;
  }

  setSymbols(rootPath: string, filePath: string, symbols: ExtractedSymbol[]): void {
    let root = this.roots.get(rootPath);
    if (!root) {
      root = { rootPath, astCache: new Map(), symbolCache: new Map(), graphCache: null, lastAccessed: Date.now() };
      this.roots.set(rootPath, root);
    }
    this.ensureCapacity(root.symbolCache);
    root.symbolCache.set(filePath, symbols);
    root.lastAccessed = Date.now();
  }

  clear(rootPath?: string): void {
  	if (rootPath) {
  		this.roots.delete(rootPath);
  	} else {
  		this.roots.clear();
  	}
  	this.logger.info("Cache cleared");
  }

  getHitCounts(): Record<string, number> {
  	return {
  		ast: this.hits.get("ast") ?? 0,
  		symbol: this.hits.get("symbol") ?? 0,
  		graph: this.hits.get("graph") ?? 0,
  		embedding: this.hits.get("embedding") ?? 0,
  	}
  }

  getMissCounts(): Record<string, number> {
  	return {
  		ast: this.misses.get("ast") ?? 0,
  		symbol: this.misses.get("symbol") ?? 0,
  		graph: this.misses.get("graph") ?? 0,
  		embedding: this.misses.get("embedding") ?? 0,
  	}
  }

  restoreCounts(hits: Record<string, number>, misses: Record<string, number>): void {
  	for (const [key, val] of Object.entries(hits)) {
  		if (val > 0) this.hits.set(key, val)
  	}
  	for (const [key, val] of Object.entries(misses)) {
  		if (val > 0) this.misses.set(key, val)
  	}
  }

  getStats(): CacheStats {
    const astHits = this.hits.get("ast") ?? 0;
    const astMisses = this.misses.get("ast") ?? 0;
    const symbolHits = this.hits.get("symbol") ?? 0;
    const symbolMisses = this.misses.get("symbol") ?? 0;
    const graphHits = this.hits.get("graph") ?? 0;
    const graphMisses = this.misses.get("graph") ?? 0;
    const embeddingHits = this.hits.get("embedding") ?? 0;
    const embeddingMisses = this.misses.get("embedding") ?? 0;

    return {
      astCacheSize: this.sumCacheSizes((r) => r.astCache.size),
      symbolCacheSize: this.sumCacheSizes((r) => r.symbolCache.size),
      graphCacheSize: this.roots.size,
      embeddingCacheSize: 0,
      astHitRate: this.calcRate(astHits, astMisses),
      symbolHitRate: this.calcRate(symbolHits, symbolMisses),
      graphHitRate: this.calcRate(graphHits, graphMisses),
      embeddingHitRate: this.calcRate(embeddingHits, embeddingMisses),
      totalEvictions: this.evictions,
      memoryUsageBytes: 0,
    };
  }

  private recordHit(cache: string): void {
    this.hits.set(cache, (this.hits.get(cache) ?? 0) + 1);
  }

  private recordMiss(cache: string): void {
    this.misses.set(cache, (this.misses.get(cache) ?? 0) + 1);
  }

  private calcRate(hits: number, misses: number): number {
    const total = hits + misses;
    return total > 0 ? hits / total : 0;
  }

  private sumCacheSizes(fn: (root: RootCache) => number): number {
    let total = 0;
    for (const root of this.roots.values()) {
      total += fn(root);
    }
    return total;
  }

  private ensureCapacity(cache: Map<string, unknown>): void {
    if (cache.size >= this.config.cacheSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) {
        cache.delete(oldestKey);
        this.evictions++;
      }
    }
  }
}
