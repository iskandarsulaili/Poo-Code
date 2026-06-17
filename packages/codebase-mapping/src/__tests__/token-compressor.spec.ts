import { describe, it, expect } from "vitest";
import { TokenCompressor } from "../token-compressor.js";
import { LevelOfDetail } from "../types.js";

describe("TokenCompressor", () => {
  it("should create instance with default config", () => {
    const tc = new TokenCompressor();
    expect(tc).toBeInstanceOf(TokenCompressor);
  });

  it("should compress content at given LOD", () => {
    const tc = new TokenCompressor();
    const result = tc.compress("/test.ts", "const x = 1;", [], LevelOfDetail.L0_Summary);
    expect(result.filePath).toBe("/test.ts");
    expect(result.originalSize).toBe(12);
    expect(result.compressionRatio).toBeDefined();
  });

  it("should compute delta for changed content", () => {
    const tc = new TokenCompressor();
    const delta = tc.computeDelta("const x = 1;", "const y = 2;", "/test.ts");
    expect(delta.filePath).toBe("/test.ts");
    expect(delta.changeType).toBe("modified");
    expect(delta.oldHash).not.toBe(delta.newHash);
  });

  it("should detect unchanged content", () => {
    const tc = new TokenCompressor();
    const delta = tc.computeDelta("const x = 1;", "const x = 1;", "/test.ts");
    expect(delta.diff).toBeNull();
  });
});
