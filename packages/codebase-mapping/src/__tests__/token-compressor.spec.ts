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

	it("should summarize at L0", () => {
		const tc = new TokenCompressor();
		const result = tc.compress("/test.ts", "// header\nconst x = 1;\nconst y = 2;", [], LevelOfDetail.L0_Summary);
		expect(result.content).toContain("// header");
		expect(result.content).toContain("lines");
		expect(result.content).toContain("non-empty");
	});

	it("should extract signatures at L1", () => {
		const tc = new TokenCompressor();
		const code = "// comment\nfunction foo() {}\nconst x = 1;\nclass Bar {}";
		const result = tc.compress("/test.ts", code, [], LevelOfDetail.L1_Signatures);
		expect(result.content).toContain("function foo()");
		expect(result.content).toContain("class Bar");
	});

	it("should extract declarations at L2", () => {
		const tc = new TokenCompressor();
		const code = "function foo() {\n  const x = 1;\n}\nconst y = 2;";
		const result = tc.compress("/test.ts", code, [], LevelOfDetail.L2_Declarations);
		expect(result.content).toContain("function foo() {");
		expect(result.content).toContain("const x = 1;");
		expect(result.content).toContain("}");
	});

	it("should return full content at L3", () => {
		const tc = new TokenCompressor();
		const code = "const x = 1;";
		const result = tc.compress("/test.ts", code, [], LevelOfDetail.L3_Implementation);
		expect(result.content).toBe(code);
	});

	it("should return full content at L4", () => {
		const tc = new TokenCompressor();
		const code = "const x = 1;";
		const result = tc.compress("/test.ts", code, [], LevelOfDetail.L4_FullSource);
		expect(result.content).toBe(code);
	});

	it("should generate diff for changed lines", () => {
		const tc = new TokenCompressor();
		const delta = tc.computeDelta("line1\nline2\nline3", "line1\nchanged\nline3", "/test.ts");
		expect(delta.diff).toContain("- line2");
		expect(delta.diff).toContain("+ changed");
	});

	it("should generate diff for added lines", () => {
		const tc = new TokenCompressor();
		const delta = tc.computeDelta("line1", "line1\nline2", "/test.ts");
		expect(delta.diff).toContain("+ line2");
	});

	it("should generate diff for removed lines", () => {
		const tc = new TokenCompressor();
		const delta = tc.computeDelta("line1\nline2", "line1", "/test.ts");
		expect(delta.diff).toContain("- line2");
	});
});
