import { describe, it, expect } from "vitest";
import { SymbolExtractor } from "../symbol-extractor.js";
import { Language } from "../types.js";

describe("SymbolExtractor", () => {
  it("should create instance with default config", () => {
    const extractor = new SymbolExtractor();
    expect(extractor).toBeInstanceOf(SymbolExtractor);
  });

  it("should return empty array for null AST", () => {
    const extractor = new SymbolExtractor();
    const result = extractor.extractSymbols({
      filePath: "/test.ts",
      language: Language.TypeScript,
      ast: null,
      contentHash: "abc",
      parseTimeMs: 0,
      error: null,
      extractedAt: Date.now(),
    });
    expect(result).toEqual([]);
  });

  it("should return empty references for empty symbols", () => {
    const extractor = new SymbolExtractor();
    const refs = extractor.resolveReferences([]);
    expect(refs).toEqual([]);
  });
});
