import { DEFAULT_CONFIG, createLogger } from "./models.js";
import type { CodebaseMappingConfig, DependencyEdge, DependencyGraph, FileNode } from "./types.js";

export class GraphBuilder {
  private config: CodebaseMappingConfig;
  private logger: ReturnType<typeof createLogger>;

  constructor(config: Partial<CodebaseMappingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger(this.config.logLevel);
  }

  buildGraph(files: FileNode[], edges: DependencyEdge[]): DependencyGraph {
    const startTime = performance.now();
    this.logger.info(`Building dependency graph for ${files.length} files`);

    const filesMap = new Map<string, FileNode>();
    for (const file of files) {
      filesMap.set(file.filePath, file);
    }

    const graph: DependencyGraph = {
      files: filesMap,
      edges,
      rootPaths: this.config.workspaceRoots,
      buildTimeMs: performance.now() - startTime,
    };

    this.computePageRank(graph);
    return graph;
  }

  private computePageRank(graph: DependencyGraph): void {
  	const dampingFactor = 0.85
  	const iterations = 20
  	const fileCount = graph.files.size
  	if (fileCount === 0) return

  	const initialRank = 1 / fileCount
  	for (const file of graph.files.values()) {
  		file.pageRank = initialRank
  	}

  	for (let i = 0; i < iterations; i++) {
  		const newRanks = new Map<string, number>()
  		for (const file of graph.files.values()) {
  			let rank = 1 - dampingFactor
  			const incomingEdges = graph.edges.filter((e) => e.to === file.filePath && !e.isExternal)
  			for (const edge of incomingEdges) {
  				const source = graph.files.get(edge.from)
  				if (source) {
  					const outgoingCount = graph.edges.filter((e) => e.from === edge.from && !e.isExternal).length
  					if (outgoingCount > 0) {
  						rank += dampingFactor * (source.pageRank / outgoingCount)
  					}
  				}
  			}
  			newRanks.set(file.filePath, rank)
  		}
  		for (const [path, rank] of newRanks) {
  			const file = graph.files.get(path)
  			if (file) file.pageRank = rank
  		}
  	}
  }
}
