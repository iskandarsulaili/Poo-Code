import { renderHook, act } from "@testing-library/react"
import { useScrollLifecycle } from "../useScrollLifecycle"
import type { VirtuosoHandle } from "react-virtuoso"

// Mock useEvent from react-use
vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

// Mock debounce to execute immediately in tests
vi.mock("debounce", () => ({
	default: vi.fn((fn: (...args: any[]) => void) => {
		const debounced = (...args: any[]) => fn(...args)
		debounced.clear = vi.fn()
		return debounced
	}),
}))

describe("useScrollLifecycle", () => {
	let mockVirtuoso: { scrollToIndex: ReturnType<typeof vi.fn>; scrollIntoView: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		mockVirtuoso = {
			scrollToIndex: vi.fn(),
			scrollIntoView: vi.fn(),
		}
		vi.stubGlobal("requestAnimationFrame", vi.fn().mockImplementation((cb: () => void) => {
			cb()
			return 1
		}))
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	const createOptions = (overrides: Partial<Parameters<typeof useScrollLifecycle>[0]> = {}) => {
		const virtuosoRef = { current: mockVirtuoso as unknown as VirtuosoHandle }
		const scrollContainerRef = { current: document.createElement("div") }
		return {
			virtuosoRef: virtuosoRef as React.RefObject<VirtuosoHandle | null>,
			scrollContainerRef: scrollContainerRef as React.RefObject<HTMLDivElement | null>,
			taskTs: undefined,
			isStreaming: false,
			isHidden: false,
			hasTask: false,
			...overrides,
		}
	}

	it("should initialize in USER_BROWSING_HISTORY phase when no task exists", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(result.current.showScrollToBottom).toBe(false)
	})

	it("should return refs on initial render", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(result.current.isAtBottomRef).toBeDefined()
		expect(result.current.scrollPhaseRef).toBeDefined()
	})

	it("handleScrollToBottomClick should not throw", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(() => {
			act(() => {
				result.current.handleScrollToBottomClick()
			})
		}).not.toThrow()
	})

	it("enterUserBrowsingHistory should not throw", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(() => {
			act(() => {
				result.current.enterUserBrowsingHistory("wheel-up")
			})
		}).not.toThrow()
	})

	it("atBottomStateChangeCallback should not throw", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(() => {
			act(() => {
				result.current.atBottomStateChangeCallback(true)
			})
		}).not.toThrow()
	})

	it("followOutputCallback should return false in initial state", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(result.current.followOutputCallback()).toBe(false)
	})

	it("scrollToBottomAuto should not throw", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(() => {
			act(() => {
				result.current.scrollToBottomAuto()
			})
		}).not.toThrow()
	})

	it("handleRowHeightChange should not throw", () => {
		const { result } = renderHook(() => useScrollLifecycle(createOptions()))

		expect(() => {
			act(() => {
				result.current.handleRowHeightChange(true)
			})
		}).not.toThrow()
	})

	it("should respond to followOutputCallback change when taskTs is provided", () => {
		const { result, rerender } = renderHook(
			(opts: Parameters<typeof useScrollLifecycle>[0]) => useScrollLifecycle(opts),
			{ initialProps: createOptions({ hasTask: true }) },
		)

		expect(result.current.followOutputCallback()).toBe(false)

		rerender(createOptions({ taskTs: 12345, hasTask: true }))

		// After taskTs is set, phase becomes HYDRATING → not USER_BROWSING_HISTORY → "auto"
		const result1 = result.current.followOutputCallback()
		expect(result1).toBe("auto")
	})

	it("should handle hydration timer expiry", () => {
		vi.useFakeTimers()

		const { result, rerender } = renderHook(
			(opts: Parameters<typeof useScrollLifecycle>[0]) => useScrollLifecycle(opts),
			{ initialProps: createOptions({ hasTask: true }) },
		)

		rerender(createOptions({ taskTs: 1, hasTask: true }))
		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")

		act(() => {
			vi.advanceTimersByTime(1000)
		})

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")

		vi.useRealTimers()
	})
})
