import { getCallbackUrl, getOpenRouterAuthUrl, getRequestyAuthUrl, getZooCodeAuthUrl } from "../urls"

vi.mock("@roo/package", () => ({
	Package: {
		publisher: "testpub",
		name: "testext",
		version: "1.0.0",
	},
}))

describe("oauth/urls", () => {
	describe("getCallbackUrl", () => {
		it("should encode a callback URL for a given provider", () => {
			const result = getCallbackUrl("openrouter")
			expect(result).toBe(encodeURIComponent("vscode://testpub.testext/openrouter"))
		})

		it("should use custom URI scheme when provided", () => {
			const result = getCallbackUrl("requesty", "zoocode")
			expect(result).toBe(encodeURIComponent("zoocode://testpub.testext/requesty"))
		})

		it("should return an encoded URI component", () => {
			const result = getCallbackUrl("provider")
			expect(decodeURIComponent(result)).toBe("vscode://testpub.testext/provider")
		})
	})

	describe("getOpenRouterAuthUrl", () => {
		it("should return OpenRouter auth URL with default scheme", () => {
			const result = getOpenRouterAuthUrl()
			expect(result).toContain("https://openrouter.ai/auth")
			expect(result).toContain("callback_url")
			expect(decodeURIComponent(result)).toContain("vscode://testpub.testext/openrouter")
		})

		it("should use custom URI scheme when provided", () => {
			const result = getOpenRouterAuthUrl("zoocode")
			expect(decodeURIComponent(result)).toContain("zoocode://testpub.testext/openrouter")
		})
	})

	describe("getRequestyAuthUrl", () => {
		it("should return Requesty auth URL with default scheme", () => {
			const result = getRequestyAuthUrl()
			expect(result).toContain("https://app.requesty.ai/oauth/authorize")
			expect(result).toContain("callback_url")
			expect(decodeURIComponent(result)).toContain("vscode://testpub.testext/requesty")
		})

		it("should use custom URI scheme when provided", () => {
			const result = getRequestyAuthUrl("zoocode")
			expect(decodeURIComponent(result)).toContain("zoocode://testpub.testext/requesty")
		})
	})

	describe("getZooCodeAuthUrl", () => {
		it("should return Zoo Code auth URL with default parameters", () => {
			const result = getZooCodeAuthUrl()
			expect(result).toContain("https://www.zoocode.dev/dashboard/connect")
			expect(result).toContain("device=VS%20Code")
			expect(result).toContain("editor=VS%20Code")
			expect(result).toContain("version=1.0.0")
			expect(decodeURIComponent(result)).toContain("vscode://testpub.testext/auth-callback")
		})

		it("should use custom base URL when provided", () => {
			const result = getZooCodeAuthUrl(undefined, "https://custom.zoocode.dev")
			expect(result).toContain("https://custom.zoocode.dev/dashboard/connect")
		})

		it("should use custom URI scheme when provided", () => {
			const result = getZooCodeAuthUrl("zoocode")
			expect(decodeURIComponent(result)).toContain("zoocode://testpub.testext/auth-callback")
		})

		it("should use custom device name when provided", () => {
			const result = getZooCodeAuthUrl(undefined, undefined, "MyMachine")
			expect(result).toContain("device=MyMachine")
		})

		it("should encode device name", () => {
			const result = getZooCodeAuthUrl(undefined, undefined, "My Machine Name")
			expect(result).toContain("device=My%20Machine%20Name")
		})
	})
})
