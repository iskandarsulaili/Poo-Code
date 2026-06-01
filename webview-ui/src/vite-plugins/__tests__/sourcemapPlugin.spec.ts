import { sourcemapPlugin } from "../sourcemapPlugin"

describe("sourcemapPlugin", () => {
	it("should return a valid Vite plugin", () => {
		const plugin = sourcemapPlugin()

		expect(plugin).toBeDefined()
		expect(plugin.name).toBe("vite-plugin-sourcemap")
		expect(plugin.apply).toBe("build")
	})

	it("should have closeBundle handler", () => {
		const plugin = sourcemapPlugin()

		expect(plugin.closeBundle).toBeDefined()
		expect(typeof plugin.closeBundle).toBe("object")
	})

	it("should have closeBundle.handler function", () => {
		const plugin = sourcemapPlugin()

		expect(plugin.closeBundle).toHaveProperty("handler")
		expect(typeof (plugin.closeBundle as any).handler).toBe("function")
	})

	it("should have closeBundle.order set to 'post'", () => {
		const plugin = sourcemapPlugin()

		expect((plugin.closeBundle as any).order).toBe("post")
	})

	it("should execute closeBundle handler without error", async () => {
		const plugin = sourcemapPlugin()
		const handler = (plugin.closeBundle as any).handler as () => Promise<void>

		await expect(handler()).resolves.toBeUndefined()
	})
})
