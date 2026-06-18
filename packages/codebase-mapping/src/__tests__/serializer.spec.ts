import { describe, it, expect } from "vitest";
import { Serializer } from "../serializer.js";
import { SerializationFormat } from "../types.js";

describe("Serializer", () => {
  it("should create instance with default config", () => {
    const serializer = new Serializer();
    expect(serializer).toBeInstanceOf(Serializer);
  });

  it("should serialize to JSON", () => {
    const serializer = new Serializer();
    const data = serializer.buildSerializationData([], [], [], {
      files: new Map(),
      edges: [],
      rootPaths: [],
      buildTimeMs: 0,
    });
    const json = serializer.serialize(data, SerializationFormat.JSON);
    expect(json).toContain("metadata");
    expect(json).toContain("files");
  });

  it("should serialize to Mermaid", () => {
    const serializer = new Serializer();
    const data = serializer.buildSerializationData([], [], [], {
      files: new Map(),
      edges: [],
      rootPaths: [],
      buildTimeMs: 0,
    });
    const mermaid = serializer.serialize(data, SerializationFormat.Mermaid);
    expect(mermaid).toContain("graph TD");
  });

  it("should serialize to Graphviz", () => {
    const serializer = new Serializer();
    const data = serializer.buildSerializationData([], [], [], {
      files: new Map(),
      edges: [],
      rootPaths: [],
      buildTimeMs: 0,
    });
    const dot = serializer.serialize(data, SerializationFormat.Graphviz);
    expect(dot).toContain("digraph G");
  });
});
