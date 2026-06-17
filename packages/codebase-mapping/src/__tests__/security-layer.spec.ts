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
      'const apiKey = "sk-1234567890abcdef";',
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
});
