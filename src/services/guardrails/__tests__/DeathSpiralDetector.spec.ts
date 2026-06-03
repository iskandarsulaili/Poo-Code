import { DeathSpiralDetector } from "../DeathSpiralDetector"
import { DetectionType, type DetectionEvent, type GuardrailConfig } from "../types"

function makeEvent(overrides: Partial<DetectionEvent> = {}): DetectionEvent {
	return {
		toolName: "write_to_file",
		filePath: "/path/file.ts",
		sha256: "abc123",
		timestamp: Date.now(),
		diagnosisCycle: 1,
		errorMessage: "Error",
		...overrides,
	}
}

describe("DeathSpiralDetector", () => {
	const defaultConfig: GuardrailConfig = {
		detectionThresholds: {
			[DetectionType.EXACT_REPEAT]: { warnAfter: 2, hardStopAfter: 3 },
			[DetectionType.SAME_TOOL_FAILURE]: { warnAfter: 3, hardStopAfter: 5 },
			[DetectionType.IDEMPOTENT_NO_PROGRESS]: { warnAfter: 3, hardStopAfter: 4 },
		},
		failureWindowMs: 60_000,
		resetTimeoutMs: 30_000,
	}

	describe("checkExactRepeat()", () => {
		it("should return null when no error message", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const result = detector.checkExactRepeat(makeEvent({ errorMessage: undefined }))
			expect(result).toBeNull()
		})

		it("should return null on first occurrence", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const result = detector.checkExactRepeat(makeEvent({ errorMessage: "File not found" }))
			expect(result).toBeNull()
		})

		it("should warn after 2 exact repeats", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ errorMessage: "File not found" })
			detector.checkExactRepeat(event)
			const result = detector.checkExactRepeat(event)
			expect(result).not.toBeNull()
			expect(result!.pattern).toBe(DetectionType.EXACT_REPEAT)
			expect(result!.severity).toBe("warn")
			expect(result!.consecutiveCount).toBe(2)
		})

		it("should block after 3 exact repeats", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ errorMessage: "File not found" })
			detector.checkExactRepeat(event)
			detector.checkExactRepeat(event)
			const result = detector.checkExactRepeat(event)
			expect(result).not.toBeNull()
			expect(result!.severity).toBe("block")
			expect(result!.consecutiveCount).toBe(3)
		})

		it("should treat different error messages as distinct", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			detector.checkExactRepeat(makeEvent({ errorMessage: "File not found" }))
			const result = detector.checkExactRepeat(makeEvent({ errorMessage: "Permission denied" }))
			expect(result).toBeNull()
		})

		it("should respect custom thresholds", () => {
			const config: GuardrailConfig = {
				detectionThresholds: {
					[DetectionType.EXACT_REPEAT]: { warnAfter: 1, hardStopAfter: 2 },
				},
			}
			const detector = new DeathSpiralDetector(config)
			const event = makeEvent({ errorMessage: "Error" })
			const first = detector.checkExactRepeat(event)
			expect(first!.severity).toBe("warn")
			const second = detector.checkExactRepeat(event)
			expect(second!.severity).toBe("block")
		})
	})

	describe("checkSameToolFailure()", () => {
		it("should return null when no error message", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const result = detector.checkSameToolFailure(makeEvent({ errorMessage: undefined }))
			expect(result).toBeNull()
		})

		it("should return null below warn threshold", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ errorMessage: "Error" })
			detector.checkSameToolFailure(event)
			const result = detector.checkSameToolFailure(event)
			expect(result).toBeNull()
		})

		it("should warn after 3 same-tool failures on same file", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ toolName: "write_to_file", filePath: "/path/file.ts", errorMessage: "Error" })
			detector.checkSameToolFailure(event)
			detector.checkSameToolFailure(event)
			const result = detector.checkSameToolFailure(event)
			expect(result).not.toBeNull()
			expect(result!.pattern).toBe(DetectionType.SAME_TOOL_FAILURE)
			expect(result!.severity).toBe("warn")
			expect(result!.consecutiveCount).toBe(3)
		})

		it("should block after 5 same-tool failures", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ toolName: "tool", filePath: "/file", errorMessage: "Err" })
			for (let i = 0; i < 4; i++) detector.checkSameToolFailure(event)
			const result = detector.checkSameToolFailure(event)
			expect(result!.severity).toBe("block")
		})

		it("should reset when tool changes", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const ev1 = makeEvent({ toolName: "write_to_file", filePath: "/file", errorMessage: "Err" })
			const ev2 = makeEvent({ toolName: "read_file", filePath: "/file", errorMessage: "Err" })
			for (let i = 0; i < 3; i++) detector.checkSameToolFailure(ev1)
			detector.checkSameToolFailure(ev2)
			const result = detector.checkSameToolFailure(ev2)
			expect(result).toBeNull()
		})
	})

	describe("checkIdempotentNoProgress()", () => {
		it("should return null on first attempt", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const result = detector.checkIdempotentNoProgress("/path/file.ts", "content")
			expect(result).toBeNull()
		})

		it("should warn after 3 attempts with same content", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			detector.checkIdempotentNoProgress("/path/file.ts", "same content")
			detector.checkIdempotentNoProgress("/path/file.ts", "same content")
			const result = detector.checkIdempotentNoProgress("/path/file.ts", "same content")
			expect(result).not.toBeNull()
			expect(result!.pattern).toBe(DetectionType.IDEMPOTENT_NO_PROGRESS)
			expect(result!.severity).toBe("warn")
		})

		it("should block after 4 attempts with same content", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			for (let i = 0; i < 3; i++) detector.checkIdempotentNoProgress("/path/file.ts", "same")
			const result = detector.checkIdempotentNoProgress("/path/file.ts", "same")
			expect(result!.severity).toBe("block")
		})

		it("should reset when content changes", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			detector.checkIdempotentNoProgress("/path/file.ts", "old", "old")
			detector.checkIdempotentNoProgress("/path/file.ts", "old", "old")
			const result = detector.checkIdempotentNoProgress("/path/file.ts", "new", "new")
			expect(result).toBeNull()
		})
	})

	describe("check() — aggregated", () => {
		it("should return null when no patterns detected", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const result = detector.check(makeEvent({ errorMessage: undefined }))
			expect(result).toBeNull()
		})

		it("should return exact repeat detection when threshold reached", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ errorMessage: "Error" })
			detector.check(event)
			const result = detector.check(event)
			expect(result).not.toBeNull()
			expect(result!.pattern).toBe(DetectionType.EXACT_REPEAT)
		})
	})

	describe("getExactRepeatCount() / getToolFailureCount() / getIdempotentCount()", () => {
		it("should return correct counts", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ errorMessage: "Err" })
			detector.checkExactRepeat(event)
			detector.checkExactRepeat(event)
			expect(detector.getExactRepeatCount("write_to_file", "/path/file.ts", "Err")).toBe(2)

			detector.checkSameToolFailure(event)
			detector.checkSameToolFailure(event)
			expect(detector.getToolFailureCount("write_to_file", "/path/file.ts")).toBe(2)

			detector.checkIdempotentNoProgress("/file", "c")
			detector.checkIdempotentNoProgress("/file", "c")
			detector.checkIdempotentNoProgress("/file", "c")
			expect(detector.getIdempotentCount("/file")).toBe(3)
		})

		it("should return 0 for untouched keys", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			expect(detector.getExactRepeatCount("x", "y")).toBe(0)
			expect(detector.getToolFailureCount("x", "y")).toBe(0)
			expect(detector.getIdempotentCount("z")).toBe(0)
		})
	})

	describe("reset()", () => {
		it("should clear all internal state", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ errorMessage: "Err" })
			detector.checkExactRepeat(event)
			detector.checkSameToolFailure(event)
			detector.checkIdempotentNoProgress("/file", "content")

			detector.reset()

			expect(detector.getExactRepeatCount("write_to_file", "/path/file.ts", "Err")).toBe(0)
			expect(detector.getToolFailureCount("write_to_file", "/path/file.ts")).toBe(0)
			expect(detector.getIdempotentCount("/file")).toBe(0)
		})
	})

	describe("resetEvent()", () => {
		it("should clear counts for a specific event", () => {
			const detector = new DeathSpiralDetector(defaultConfig)
			const event = makeEvent({ errorMessage: "Err" })
			detector.checkExactRepeat(event)
			detector.checkExactRepeat(event)
			expect(detector.getExactRepeatCount("write_to_file", "/path/file.ts", "Err")).toBe(2)

			detector.resetEvent(event)
			expect(detector.getExactRepeatCount("write_to_file", "/path/file.ts", "Err")).toBe(0)
		})
	})

	describe("Configuration defaults", () => {
		it("should use default thresholds when config is empty", () => {
			const detector = new DeathSpiralDetector({})
			const event = makeEvent({ errorMessage: "e" })
			detector.checkExactRepeat(event)
			const warn = detector.checkExactRepeat(event)
			expect(warn).not.toBeNull()
			expect(warn!.severity).toBe("warn")
		})
	})
})
