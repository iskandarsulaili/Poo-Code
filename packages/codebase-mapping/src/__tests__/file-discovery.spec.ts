import { describe, it, expect } from "vitest";
import { FileDiscovery } from "../file-discovery.js";

describe("FileDiscovery", () => {
  it("should create instance with default config", () => {
    const fd = new FileDiscovery();
    expect(fd).toBeInstanceOf(FileDiscovery);
  });

  it("should create instance with custom config", () => {
    const fd = new FileDiscovery({ logLevel: "debug" });
    expect(fd).toBeInstanceOf(FileDiscovery);
  });

  it("should reject disallowed file patterns", () => {
    const fd = new FileDiscovery({
      workspaceRoots: ["/test"],
      excludedPatterns: ["**/node_modules/**"],
      allowedPatterns: [],
    });
    expect(fd.isAllowed("/test/node_modules/foo.bin")).toBe(false);
  });

  it("should allow override of excluded pattern via allowedPatterns", () => {
    const fd = new FileDiscovery({
      workspaceRoots: ["/test"],
      excludedPatterns: ["**/node_modules/**"],
      allowedPatterns: ["**/*.ts"],
    });
    expect(fd.isAllowed("/test/node_modules/override.ts")).toBe(true);
  });

  it("should allow files not in excluded patterns by default", () => {
    const fd = new FileDiscovery({
      workspaceRoots: ["/test"],
      allowedPatterns: [],
    });
    expect(fd.isAllowed("/test/src/index.ts")).toBe(true);
  });
});
