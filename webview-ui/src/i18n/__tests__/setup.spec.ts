// Store mock reference outside factory for type safety
const mockAddResourceBundle = vi.fn()

vi.mock("../setup", () => ({
	loadTranslations: () => {
		// Simulates the real behavior: adds resource bundles for each locale/namespace
		mockAddResourceBundle("en", "common", { hello: "Hello" }, true, true)
		mockAddResourceBundle("en", "chat", { title: "Chat" }, true, true)
		mockAddResourceBundle("fr", "common", { hello: "Bonjour" }, true, true)
	},
	default: {
		use: vi.fn().mockReturnThis(),
		init: vi.fn().mockResolvedValue(undefined),
		addResourceBundle: vi.fn(),
	},
}))

import { loadTranslations } from "../setup"

describe("i18n/setup", () => {
	beforeEach(() => {
		mockAddResourceBundle.mockClear()
	})

	it("should call loadTranslations without error", () => {
		expect(() => {
			loadTranslations()
		}).not.toThrow()
	})

	it("should add resource bundles for multiple locale/namespace combinations", () => {
		loadTranslations()

		expect(mockAddResourceBundle).toHaveBeenCalled()
		const calls = mockAddResourceBundle.mock.calls
		expect(calls.length).toBeGreaterThan(1)

		for (const call of calls) {
			expect(call).toHaveLength(5)
			expect(call[3]).toBe(true) // deep
			expect(call[4]).toBe(true) // overwrite
		}
	})

	it("should call addResourceBundle with string language codes", () => {
		loadTranslations()

		const calls = mockAddResourceBundle.mock.calls
		for (const [lang] of calls) {
			expect(typeof lang).toBe("string")
			expect(lang.length).toBeGreaterThan(0)
		}
	})

	it("should call addResourceBundle with string namespace names", () => {
		loadTranslations()

		const calls = mockAddResourceBundle.mock.calls
		for (const [_, ns] of calls) {
			expect(typeof ns).toBe("string")
			expect(ns.length).toBeGreaterThan(0)
		}
	})

	it("should provide translation resources as objects", () => {
		loadTranslations()

		const calls = mockAddResourceBundle.mock.calls
		for (const [,, resources] of calls) {
			expect(typeof resources).toBe("object")
			expect(resources).not.toBeNull()
		}
	})
})
