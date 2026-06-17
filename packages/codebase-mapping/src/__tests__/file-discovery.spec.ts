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
    });
    expect(fd.isAllowed("/test/node_modules/foo.js")).toBe(false);
  });

  it("should allow matching file patterns", () => {
    const fd = new FileDiscovery({
      workspaceRoots: ["/test"],
      allowedPatterns: ["**/*.ts"],
    });
    expect(fd.isAllowed("/test/src/index.ts")).toBe(true);
  });
});
