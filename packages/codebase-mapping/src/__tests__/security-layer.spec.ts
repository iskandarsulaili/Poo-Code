import { describe, it, expect } from "vitest";
import { SecurityLayer } from "../security-layer.js";

describe("SecurityLayer", () => {
	it("should create instance with default config", () => {
		const sl = new SecurityLayer();
		expect(sl).toBeInstanceOf(SecurityLayer);
	});

	it("should mask API keys in content", () => {
		const sl = new SecurityLayer();
		const { masked, secrets } = sl.maskSecrets(
			'const apiKey = "sk-123...cdef";',
			"/test.ts"
		);
		expect(masked).toContain("***MASKED***");
		expect(secrets).toHaveLength(1);
		expect(secrets[0].pattern).toContain("api");
	});

	it("should detect email PII", () => {
		const sl = new SecurityLayer();
		const detections = sl.detectPII(
			'Contact: user@example.com',
			"/test.ts"
		);
		expect(detections).toHaveLength(1);
		expect(detections[0].type).toBe("email");
	});

	it("should not mask secrets when disabled", () => {
		const sl = new SecurityLayer({ enableSecretMasking: false });
		const { masked, secrets } = sl.maskSecrets(
			'const key = "secret-value";',
			"/test.ts"
		);
		expect(secrets).toHaveLength(0);
		expect(masked).toBe('const key = "secret-value";');
	});

	it("should not detect PII when disabled", () => {
		const sl = new SecurityLayer({ enablePIIDetection: false });
		const detections = sl.detectPII("user@example.com", "/test.ts");
		expect(detections).toHaveLength(0);
	});

	it("should detect .gitignore compliance boundary", () => {
		const sl = new SecurityLayer();
		const boundaries = sl.checkComplianceBoundaries("/project/.git/config");
		expect(boundaries.length).toBeGreaterThan(0);
		expect(boundaries.some((b) => b.type === "gitignore")).toBe(true);
	});

	it("should detect node_modules compliance boundary", () => {
		const sl = new SecurityLayer();
		const boundaries = sl.checkComplianceBoundaries("/project/node_modules/pkg/index.js");
		expect(boundaries.length).toBeGreaterThan(0);
		expect(boundaries.some((b) => b.type === "rooignore")).toBe(true);
	});

	it("should detect custom deny pattern from config", () => {
		const sl = new SecurityLayer({ excludedPatterns: ["**/secrets/**"] });
		const boundaries = sl.checkComplianceBoundaries("/project/secrets/keys.json");
		expect(boundaries.some((b) => b.type === "custom_deny")).toBe(true);
	});

	it("should detect custom allow pattern from config", () => {
		const sl = new SecurityLayer({ allowedPatterns: ["**/*.ts"] });
		const boundaries = sl.checkComplianceBoundaries("/project/src/app.ts");
		expect(boundaries.some((b) => b.type === "custom_allow")).toBe(true);
	});

	it("should return empty for normal source files", () => {
		const sl = new SecurityLayer({ allowedPatterns: [] });
		const boundaries = sl.checkComplianceBoundaries("/project/src/app.ts");
		expect(boundaries).toHaveLength(0);
	});
});
