import { describe, it, expect } from "vitest";
import { Serializer } from "../serializer.js";
import { SerializationFormat } from "../types.js";
import type { SerializationData } from "../types.js";

function makeData(overrides?: Partial<SerializationData>): SerializationData {
	return {
		metadata: {
			workspaceRoots: ["/test"],
			totalFiles: 2,
			totalSymbols: 3,
			totalEdges: 1,
			generatedAt: 1700000000000,
			format: SerializationFormat.JSON,
		},
		files: [
			{ path: "/test/src/main.ts", language: "typescript" as any, size: 100, symbolCount: 2, importCount: 1, exportCount: 1, pageRank: 0.5 },
			{ path: "/test/src/utils.ts", language: "typescript" as any, size: 50, symbolCount: 1, importCount: 0, exportCount: 1, pageRank: 0.3 },
		],
		symbols: [
			{ id: "main::run", name: "run", kind: "function" as any, filePath: "/test/src/main.ts", range: { start: { line: 1, column: 1 }, end: { line: 10, column: 1 }, startIndex: 0, endIndex: 100 }, parentId: null, typeAnnotation: null, isExported: true, visibility: "public", documentation: null, referenceCount: 1, pageRank: 0.5 },
		],
		edges: [
			{ from: "/test/src/main.ts", to: "/test/src/utils.ts", kind: "import", isDynamic: false },
		],
		deadCode: [],
		flows: [],
		configLinks: [],
		gitMetadata: null,
		...overrides,
	}
}

describe("Serializer", () => {
	it("should create instance with default config", () => {
		const serializer = new Serializer();
		expect(serializer).toBeInstanceOf(Serializer);
	});

	it("should serialize to JSON", () => {
		const serializer = new Serializer();
		const data = serializer.buildSerializationData([], [], []);
		const json = serializer.serialize(data, SerializationFormat.JSON);
		expect(json).toContain("metadata");
		expect(json).toContain("files");
	});

	it("should serialize to Mermaid with nodes and edges", () => {
		const serializer = new Serializer();
		const data = makeData();
		const mermaid = serializer.serialize(data, SerializationFormat.Mermaid);
		expect(mermaid).toContain("graph TD");
		expect(mermaid).toContain("main.ts");
		expect(mermaid).toContain("utils.ts");
		expect(mermaid).toContain("-->");
		expect(mermaid).toContain("Generated");
	});

	it("should serialize to Mermaid with dead code subgraph", () => {
		const serializer = new Serializer();
		const data = makeData({
			deadCode: [{ symbolId: "dead::x", name: "unusedVar", kind: "variable" as any, filePath: "/test/src/main.ts", reason: "unused_export", confidence: 0.8, evidence: "no refs" }],
		});
		const mermaid = serializer.serialize(data, SerializationFormat.Mermaid);
		expect(mermaid).toContain("Dead Code");
		expect(mermaid).toContain("unusedVar");
	});

	it("should serialize to Graphviz", () => {
		const serializer = new Serializer();
		const data = makeData();
		const dot = serializer.serialize(data, SerializationFormat.Graphviz);
		expect(dot).toContain("digraph G");
		expect(dot).toContain("rankdir=LR");
		expect(dot).toContain("->");
	});

	it("should serialize to ASCII", () => {
		const serializer = new Serializer();
		const data = makeData();
		const ascii = serializer.serialize(data, SerializationFormat.ASCII);
		expect(ascii).toContain("Codebase Map");
		expect(ascii).toContain("Files: 2");
		expect(ascii).toContain("main.ts");
		expect(ascii).toContain("->");
	});

	it("should serialize to ASCII with dead code section", () => {
		const serializer = new Serializer();
		const data = makeData({
			deadCode: [{ symbolId: "dead::x", name: "unusedVar", kind: "variable" as any, filePath: "/test/src/main.ts", reason: "unused_export", confidence: 0.8, evidence: "no refs" }],
		});
		const ascii = serializer.serialize(data, SerializationFormat.ASCII);
		expect(ascii).toContain("Dead Code");
		expect(ascii).toContain("unusedVar");
	});

	it("should serialize to HTML", () => {
		const serializer = new Serializer();
		const data = makeData();
		const html = serializer.serialize(data, SerializationFormat.HTML);
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("Codebase Map");
		expect(html).toContain("<table>");
		expect(html).toContain("main.ts");
		expect(html).toContain("utils.ts");
	});

	it("should serialize to HTML with dead code table", () => {
		const serializer = new Serializer();
		const data = makeData({
			deadCode: [{ symbolId: "dead::x", name: "unusedVar", kind: "variable" as any, filePath: "/test/src/main.ts", reason: "unused_export", confidence: 0.8, evidence: "no refs" }],
		});
		const html = serializer.serialize(data, SerializationFormat.HTML);
		expect(html).toContain("Dead Code");
		expect(html).toContain("unusedVar");
	});

	it("should serialize to Markdown", () => {
		const serializer = new Serializer();
		const data = makeData();
		const md = serializer.serialize(data, SerializationFormat.Markdown);
		expect(md).toContain("# Codebase Map");
		expect(md).toContain("**Files:** 2");
		expect(md).toContain("| Path |");
		expect(md).toContain("main.ts");
	});

	it("should serialize to Markdown with dead code section", () => {
		const serializer = new Serializer();
		const data = makeData({
			deadCode: [{ symbolId: "dead::x", name: "unusedVar", kind: "variable" as any, filePath: "/test/src/main.ts", reason: "unused_export", confidence: 0.8, evidence: "no refs" }],
		});
		const md = serializer.serialize(data, SerializationFormat.Markdown);
		expect(md).toContain("Dead Code");
		expect(md).toContain("unusedVar");
	});

	it("should escape HTML entities in HTML output", () => {
		const serializer = new Serializer();
		const data = makeData({
			files: [{ path: "/test/src/<script>", language: "typescript" as any, size: 10, symbolCount: 0, importCount: 0, exportCount: 0, pageRank: 0 }],
		});
		const html = serializer.serialize(data, SerializationFormat.HTML);
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("should fall back to JSON for unknown format", () => {
		const serializer = new Serializer();
		const data = makeData();
		const result = serializer.serialize(data, "unknown" as SerializationFormat);
		expect(result).toContain("metadata");
	});
});
