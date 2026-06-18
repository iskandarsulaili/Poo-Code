import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import pLimit from "p-limit";
import { DEFAULT_CONFIG, createLogger, detectLanguage } from "./models.js";
import type { CodebaseMappingConfig, FileNode, Language } from "./types.js";

export class FileDiscovery {
  private config: CodebaseMappingConfig;
  private logger: ReturnType<typeof createLogger>;
  private ig: ReturnType<typeof ignore>;

  constructor(config: Partial<CodebaseMappingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger(this.config.logLevel);
    this.ig = ignore().add(this.config.excludedPatterns);
  }

  async discoverFiles(rootPath: string): Promise<string[]> {
    this.logger.info(`Discovering files in ${rootPath}`);
    const allFiles = await this.walkDirectory(rootPath);
    const filtered = allFiles.filter((f) => this.isAllowed(f));
    this.logger.info(`Found ${filtered.length} files after filtering`);
    return filtered;
  }

  async readFile(filePath: string): Promise<{ content: string; hash: string; size: number }> {
    const content = await readFile(filePath, "utf-8");
    const stats = await stat(filePath);
    const hash = this.computeHash(content);
    return { content, hash, size: stats.size };
  }

  async buildFileNode(filePath: string, rootPath: string): Promise<FileNode> {
    const { content, hash, size } = await this.readFile(filePath);
    const language = detectLanguage(filePath);
    const relativePath = relative(rootPath, filePath);

    return {
      filePath: relativePath,
      language,
      size,
      contentHash: hash,
      lastModified: Date.now(),
      symbols: [],
      imports: [],
      exports: [],
      pageRank: 0,
    };
  }

  isAllowed(filePath: string): boolean {
    const relativePath = relative(resolve(this.config.workspaceRoots[0] || ""), filePath);
    if (this.ig.ignores(relativePath)) return false;
    return this.config.allowedPatterns.some((pattern) => minimatch(filePath, pattern));
  }

  private async walkDirectory(dirPath: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dirPath, { withFileTypes: true });
    const results: string[] = [];

    const limit = pLimit(this.config.parallelism.maxFileReads);
    const tasks = entries.map((entry) =>
      limit(async () => {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") return;
          const sub = await this.walkDirectory(fullPath);
          results.push(...sub);
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      })
    );

    await Promise.all(tasks);
    return results;
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
