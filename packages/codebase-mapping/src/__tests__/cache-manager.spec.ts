import { describe, it, expect } from "vitest";
import { CacheManager } from "../cache-manager.js";
import { Language } from "../types.js";

describe("CacheManager", () => {
  it("should create instance with default config", () => {
    const cm = new CacheManager();
    expect(cm).toBeInstanceOf(CacheManager);
  });

  it("should return null for missing AST cache entry", () => {
    const cm = new CacheManager();
    const result = cm.getAST("/root", "/test.ts");
    expect(result).toBeNull();
  });

  it("should store and retrieve AST cache entries", () => {
    const cm = new CacheManager();
    const parseResult = {
      filePath: "/test.ts",
      language: Language.TypeScript,
      ast: null,
      contentHash: "abc123",
      parseTimeMs: 10,
      error: null,
      extractedAt: Date.now(),
    };
    cm.setAST("/root", "/test.ts", parseResult);
    const result = cm.getAST("/root", "/test.ts");
    expect(result).toEqual(parseResult);
  });

  it("should store and retrieve symbol cache entries", () => {
    const cm = new CacheManager();
    const symbols: import("../types.js").ExtractedSymbol[] = [];
    cm.setSymbols("/root", "/test.ts", symbols);
    const result = cm.getSymbols("/root", "/test.ts");
    expect(result).toEqual([]);
  });

  it("should clear all caches", () => {
    const cm = new CacheManager();
    cm.setAST("/root", "/test.ts", {
      filePath: "/test.ts",
      language: Language.TypeScript,
      ast: null,
      contentHash: "abc",
      parseTimeMs: 0,
      error: null,
      extractedAt: Date.now(),
    });
    cm.clear();
    expect(cm.getAST("/root", "/test.ts")).toBeNull();
  });

  it("should provide cache stats", () => {
    const cm = new CacheManager();
    const stats = cm.getStats();
    expect(stats.astCacheSize).toBe(0);
    expect(stats.astHitRate).toBe(0);
    expect(stats.totalEvictions).toBe(0);
  });
});
