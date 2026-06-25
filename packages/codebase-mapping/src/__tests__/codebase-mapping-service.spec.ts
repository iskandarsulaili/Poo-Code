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

	it("should return empty delta when no previous scan", async () => {
		const service = new CodebaseMappingService();
		await service.initialize();
		const delta = await service.getDelta("abc", "def");
		expect(Array.isArray(delta)).toBe(true);
	});

	it("should return empty config links when no files scanned", async () => {
		const service = new CodebaseMappingService();
		await service.initialize();
		const links = await service.getConfigLinks();
		expect(Array.isArray(links)).toBe(true);
	});

	it("should return empty implicit flows when no graph", async () => {
		const service = new CodebaseMappingService();
		await service.initialize();
		const flows = await service.getImplicitFlows();
		expect(Array.isArray(flows)).toBe(true);
	});

	it("should return null git metadata when git not available", async () => {
		const service = new CodebaseMappingService();
		await service.initialize();
		const meta = await service.getGitMetadata("/nonexistent/file.ts");
		expect(meta).toBeNull();
	});

	it("should return empty doc updates when no symbols", async () => {
		const service = new CodebaseMappingService();
		await service.initialize();
		const result = await service.getDocUpdates();
		expect(Array.isArray(result.updates)).toBe(true);
		expect(result.updates).toHaveLength(0);
		expect(Array.isArray(result.staleReports)).toBe(true);
	});

	it("should persist and restore cache stats", async () => {
		const service = new CodebaseMappingService();
		await service.initialize();
		// Simulate some cache activity
		service.cacheManager.getAST("/test", "file.ts");
		service.cacheManager.setAST("/test", "file.ts", {
			filePath: "file.ts",
			language: "typescript" as any,
			ast: null,
			contentHash: "abc",
			parseTimeMs: 1,
			error: null,
			extractedAt: Date.now(),
		});
		service.cacheManager.getAST("/test", "file.ts");

		const tmpDir = "/tmp";
		await service.persistCacheStats(tmpDir);
		// Reset and restore
		const service2 = new CodebaseMappingService();
		await service2.initialize();
		await service2.restoreCacheStats(tmpDir);
		const stats = await service2.getCacheStats();
		expect(stats.astHitRate).toBeGreaterThan(0);
	});
});
