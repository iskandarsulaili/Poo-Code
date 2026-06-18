import { describe, it, expect } from "vitest";
import { GraphBuilder } from "../graph-builder.js";
import { Language } from "../types.js";
import { createFileNode, createDependencyEdge } from "../models.js";

describe("GraphBuilder", () => {
  it("should create instance with default config", () => {
    const gb = new GraphBuilder();
    expect(gb).toBeInstanceOf(GraphBuilder);
  });

  it("should build empty graph for no files", () => {
    const gb = new GraphBuilder();
    const graph = gb.buildGraph([], []);
    expect(graph.files.size).toBe(0);
    expect(graph.edges).toEqual([]);
  });

  it("should build graph with files and edges", () => {
    const gb = new GraphBuilder({ workspaceRoots: ["/test"] });
    const files = [
      createFileNode("a.ts", Language.TypeScript, 100, "hash1", Date.now()),
      createFileNode("b.ts", Language.TypeScript, 200, "hash2", Date.now()),
    ];
    const edges = [createDependencyEdge("a.ts", "b.ts", "import")];
    const graph = gb.buildGraph(files, edges);
    expect(graph.files.size).toBe(2);
    expect(graph.edges).toHaveLength(1);
  });

  it("should compute page rank for files", () => {
    const gb = new GraphBuilder({ workspaceRoots: ["/test"] });
    const files = [
      createFileNode("a.ts", Language.TypeScript, 100, "hash1", Date.now()),
      createFileNode("b.ts", Language.TypeScript, 200, "hash2", Date.now()),
    ];
    const edges = [createDependencyEdge("a.ts", "b.ts", "import")];
    const graph = gb.buildGraph(files, edges);
    const fileA = graph.files.get("a.ts");
    const fileB = graph.files.get("b.ts");
    expect(fileA?.pageRank).toBeGreaterThan(0);
    expect(fileB?.pageRank).toBeGreaterThan(0);
  });
});
