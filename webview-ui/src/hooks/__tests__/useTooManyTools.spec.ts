import { renderHook } from "@testing-library/react"
import { useTooManyTools } from "../useTooManyTools"
import { MAX_MCP_TOOLS_THRESHOLD } from "@roo-code/types"
import type { McpServer } from "@roo-code/types"

// Mock the useExtensionState hook
const mockUseExtensionState = vi.fn()

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

// Mock the useAppTranslation hook
const mockUseAppTranslation = vi.fn()

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => mockUseAppTranslation(),
}))

function createMockServer(
	id: string,
	options: { disabled?: boolean; status?: string; toolCount?: number } = {},
): McpServer {
	const { disabled = false, status = "connected", toolCount = 1 } = options
	return {
		name: `server-${id}`,
		disabled,
		status,
		tools: Array.from({ length: toolCount }, (_, i) => ({
			name: `tool-${id}-${i}`,
			enabledForPrompt: true,
			description: `Tool ${i} on server ${id}`,
			inputSchema: { type: "object", properties: {} },
		})),
	} as McpServer
}

describe("useTooManyTools", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseAppTranslation.mockReturnValue({
			t: (key: string, options?: Record<string, any>) => {
				if (key === "chat:tooManyTools.toolsPart") {
					return `${options?.count} tools`
				}
				if (key === "chat:tooManyTools.serversPart") {
					return `${options?.count} servers`
				}
				if (key === "chat:tooManyTools.messageTemplate") {
					return `Warning: ${options?.tools} across ${options?.servers} (threshold: ${options?.threshold})`
				}
				return key
			},
		})
	})

	it("should return under threshold when tool count is below MAX_MCP_TOOLS_THRESHOLD", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [createMockServer("a", { toolCount: 1 })],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledToolCount).toBe(1)
		expect(result.current.enabledServerCount).toBe(1)
		expect(result.current.isOverThreshold).toBe(false)
		expect(result.current.threshold).toBe(MAX_MCP_TOOLS_THRESHOLD)
	})

	it("should be over threshold when tool count exceeds MAX_MCP_TOOLS_THRESHOLD", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [createMockServer("big", { toolCount: MAX_MCP_TOOLS_THRESHOLD + 1 })],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledToolCount).toBe(MAX_MCP_TOOLS_THRESHOLD + 1)
		expect(result.current.isOverThreshold).toBe(true)
	})

	it("should be exactly at threshold when tool count equals MAX_MCP_TOOLS_THRESHOLD", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [createMockServer("exact", { toolCount: MAX_MCP_TOOLS_THRESHOLD })],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledToolCount).toBe(MAX_MCP_TOOLS_THRESHOLD)
		expect(result.current.isOverThreshold).toBe(false)
	})

	it("should not count disabled servers", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [
				createMockServer("disabled", { disabled: true, toolCount: 100 }),
				createMockServer("enabled", { toolCount: 5 }),
			],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledServerCount).toBe(1)
		expect(result.current.enabledToolCount).toBe(5)
		expect(result.current.isOverThreshold).toBe(false)
	})

	it("should not count disconnected servers", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [
				createMockServer("disconnected", { status: "disconnected", toolCount: 100 }),
				createMockServer("connected", { toolCount: 3 }),
			],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledServerCount).toBe(1)
		expect(result.current.enabledToolCount).toBe(3)
		expect(result.current.isOverThreshold).toBe(false)
	})

	it("should count tools across multiple enabled servers", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [
				createMockServer("a", { toolCount: 10 }),
				createMockServer("b", { toolCount: 20 }),
				createMockServer("c", { toolCount: 30 }),
			],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledServerCount).toBe(3)
		expect(result.current.enabledToolCount).toBe(60)
		expect(result.current.isOverThreshold).toBe(false)
	})

	it("should provide translated title string", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [createMockServer("a")],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(typeof result.current.title).toBe("string")
	})

	it("should provide translated message with tool and server counts", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [createMockServer("a", { toolCount: MAX_MCP_TOOLS_THRESHOLD + 5 })],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.message).toContain(`${MAX_MCP_TOOLS_THRESHOLD + 5} tools`)
		expect(result.current.message).toContain("1 servers")
		expect(result.current.message).toContain(String(MAX_MCP_TOOLS_THRESHOLD))
	})

	it("should return empty server count when no mcpServers exist", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledServerCount).toBe(0)
		expect(result.current.enabledToolCount).toBe(0)
		expect(result.current.isOverThreshold).toBe(false)
	})

	it("should handle servers with undefined tools array", () => {
		mockUseExtensionState.mockReturnValue({
			mcpServers: [
				{
					name: "no-tools",
					disabled: false,
					status: "connected",
					tools: undefined,
				} as unknown as McpServer,
			],
		})

		const { result } = renderHook(() => useTooManyTools())

		expect(result.current.enabledServerCount).toBe(1)
		expect(result.current.enabledToolCount).toBe(0)
	})
})
