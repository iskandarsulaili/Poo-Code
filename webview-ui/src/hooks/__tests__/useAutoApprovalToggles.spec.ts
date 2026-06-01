import { renderHook } from "@testing-library/react"
import { useAutoApprovalToggles } from "../useAutoApprovalToggles"

// Mock the useExtensionState hook with vi.fn() so we can mutate return values
const mockUseExtensionState = vi.fn()

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

describe("useAutoApprovalToggles", () => {
	beforeEach(() => {
		mockUseExtensionState.mockReset()
	})

	it("should return all toggle values from extension state", () => {
		const mockState = {
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: false,
			alwaysAllowExecute: true,
			alwaysAllowMcp: false,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: false,
			alwaysAllowFollowupQuestions: true,
		}

		mockUseExtensionState.mockReturnValue(mockState)

		const { result } = renderHook(() => useAutoApprovalToggles())

		expect(result.current).toEqual(mockState)
	})

	it("should return all false when all extension state values are false", () => {
		const mockState = {
			alwaysAllowReadOnly: false,
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
			alwaysAllowMcp: false,
			alwaysAllowModeSwitch: false,
			alwaysAllowSubtasks: false,
			alwaysAllowFollowupQuestions: false,
		}

		mockUseExtensionState.mockReturnValue(mockState)

		const { result } = renderHook(() => useAutoApprovalToggles())

		expect(result.current).toEqual(mockState)
	})

	it("should return all undefined when extension state values are undefined", () => {
		const mockState = {
			alwaysAllowReadOnly: undefined,
			alwaysAllowWrite: undefined,
			alwaysAllowExecute: undefined,
			alwaysAllowMcp: undefined,
			alwaysAllowModeSwitch: undefined,
			alwaysAllowSubtasks: undefined,
			alwaysAllowFollowupQuestions: undefined,
		}

		mockUseExtensionState.mockReturnValue(mockState)

		const { result } = renderHook(() => useAutoApprovalToggles())

		expect(result.current).toEqual(mockState)
	})

	it("should memoize the result and not re-create when values are the same", () => {
		const mockState = {
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: false,
			alwaysAllowExecute: true,
			alwaysAllowMcp: false,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: false,
			alwaysAllowFollowupQuestions: true,
		}

		mockUseExtensionState.mockReturnValue(mockState)

		const { result, rerender } = renderHook(() => useAutoApprovalToggles())

		const firstResult = result.current

		// Rerender with same state
		rerender()

		expect(result.current).toBe(firstResult)
	})

	it("should update when extension state values change", () => {
		const initialMockState = {
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: false,
			alwaysAllowExecute: true,
			alwaysAllowMcp: false,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: false,
			alwaysAllowFollowupQuestions: true,
		}

		mockUseExtensionState.mockReturnValue(initialMockState)

		const { result, rerender } = renderHook(() => useAutoApprovalToggles())

		expect(result.current.alwaysAllowReadOnly).toBe(true)

		// Update the mock to return new values
		const updatedMockState = {
			...initialMockState,
			alwaysAllowReadOnly: false,
			alwaysAllowWrite: true,
		}
		mockUseExtensionState.mockReturnValue(updatedMockState)

		rerender()

		expect(result.current.alwaysAllowReadOnly).toBe(false)
		expect(result.current.alwaysAllowWrite).toBe(true)
	})
})
