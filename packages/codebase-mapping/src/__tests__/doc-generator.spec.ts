import { describe, it, expect } from "vitest";
import { DocGenerator } from "../doc-generator.js";

describe("DocGenerator", () => {
  it("should create instance with default config", () => {
    const dg = new DocGenerator();
    expect(dg).toBeInstanceOf(DocGenerator);
  });

  it("should generate doc update for a symbol", async () => {
    const dg = new DocGenerator();
    const update = await dg.generateDoc("/test.ts", "myFunction", "function myFunction() {}");
    expect(update.filePath).toBe("/test.ts");
    expect(update.symbolName).toBe("myFunction");
    expect(update.newDoc).toBeDefined();
    expect(update.generatedAt).toBeGreaterThan(0);
  });

  it("should return null for non-stale docs", () => {
    const dg = new DocGenerator();
    const result = dg.detectStaleDocs("/test.ts", "function foo() {}", "/** Foo */");
    expect(result).toBeNull();
  });

  it("should provide default config", () => {
    const dg = new DocGenerator();
    const config = dg.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.autoRegenerateJSDoc).toBe(true);
  });

  it("should update config", () => {
    const dg = new DocGenerator();
    dg.updateConfig({ autoRegenerateJSDoc: false });
    expect(dg.getConfig().autoRegenerateJSDoc).toBe(false);
  });
});
