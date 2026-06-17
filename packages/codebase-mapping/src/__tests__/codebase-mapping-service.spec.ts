import { describe, it, expect } from "vitest";
import { CodebaseMappingService } from "../codebase-mapping-service.js";

describe("CodebaseMappingService", () => {
  it("should create instance with default config", () => {
    const service = new CodebaseMappingService();
    expect(service).toBeInstanceOf(CodebaseMappingService);
  });

  it("should create instance with custom options", () => {
    const service = new CodebaseMappingService({ logLevel: "debug" });
    expect(service).toBeInstanceOf(CodebaseMappingService);
  });

  it("should initialize sub-components", async () => {
    const service = new CodebaseMappingService();
    expect(service.fileDiscovery).toBeDefined();
    expect(service.astParser).toBeDefined();
    expect(service.symbolExtractor).toBeDefined();
    expect(service.graphBuilder).toBeDefined();
    expect(service.tokenCompressor).toBeDefined();
    expect(service.serializer).toBeDefined();
    expect(service.securityLayer).toBeDefined();
    expect(service.cacheManager).toBeDefined();
    expect(service.docGenerator).toBeDefined();
  });

  it("should throw error when not initialized", async () => {
    const service = new CodebaseMappingService();
    await expect(service.getSymbol("test")).rejects.toThrow("not initialized");
  });

  it("should initialize successfully", async () => {
    const service = new CodebaseMappingService();
    await service.initialize();
    const stats = await service.getCacheStats();
    expect(stats).toBeDefined();
  });

  it("should register and emit events", async () => {
    const service = new CodebaseMappingService();
    const events: string[] = [];
    service.onEvent((event) => events.push(event.type));
    await service.initialize();
    expect(events).toContain("scan_started");
  });

  it("should dispose cleanly", async () => {
    const service = new CodebaseMappingService();
    await service.initialize();
    service.dispose();
    await expect(service.getSymbol("test")).rejects.toThrow("not initialized");
  });
});
