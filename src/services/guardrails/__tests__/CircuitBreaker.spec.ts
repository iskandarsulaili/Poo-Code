import { CircuitBreaker } from "../CircuitBreaker"
import { DeathSpiralDetector } from "../DeathSpiralDetector"
import { DetectionType, GuardrailError, type DetectionEvent, type GuardrailConfig } from "../types"

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

function makeConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
	return {
		detectionThresholds: {
			[DetectionType.EXACT_REPEAT]: { warnAfter: 1, hardStopAfter: 2 },
			[DetectionType.SAME_TOOL_FAILURE]: { warnAfter: 1, hardStopAfter: 2 },
			[DetectionType.IDEMPOTENT_NO_PROGRESS]: { warnAfter: 1, hardStopAfter: 2 },
		},
		resetTimeoutMs: 60_000,
		...overrides,
	}
}

describe("CircuitBreaker", () => {
	describe("constructor", () => {
		it("should start in CLOSED state", () => {
			const breaker = new CircuitBreaker()
			expect(breaker.getState().state).toBe("CLOSED")
		})

		it("should create default detector when none provided", () => {
			const breaker = new CircuitBreaker()
			expect(breaker.getDetector()).toBeInstanceOf(DeathSpiralDetector)
		})
	})

	describe("getState()", () => {
		it("should return current state copy", () => {
			const breaker = new CircuitBreaker()
			const state = breaker.getState()
			expect(state.state).toBe("CLOSED")
		})
	})

	describe("getDetector()", () => {
		it("should return the same detector instance", () => {
			const detector = new DeathSpiralDetector()
			const breaker = new CircuitBreaker({}, detector)
			expect(breaker.getDetector()).toBe(detector)
		})
	})

	describe("State Machine — CLOSED", () => {
		it("should allow calls in CLOSED state", () => {
			const breaker = new CircuitBreaker(makeConfig())
			const result = breaker.isAllowed("write_to_file", "/path/file.ts")
			expect(result.allowed).toBe(true)
		})

		it("should transition to HALF_OPEN via processEvent with warn severity", () => {
			const config = makeConfig({
				detectionThresholds: {
					[DetectionType.EXACT_REPEAT]: { warnAfter: 1, hardStopAfter: 3 },
				},
			})
			const breaker = new CircuitBreaker(config)
			const event = makeEvent({ errorMessage: "Error" })

			// First check (warnAfter=1) triggers HALF_OPEN
			breaker.processEvent(event)
			expect(breaker.getState().state).toBe("HALF_OPEN")
		})

		it("should transition to OPEN via processEvent with block severity", () => {
			const config = makeConfig({
				detectionThresholds: {
					[DetectionType.EXACT_REPEAT]: { warnAfter: 1, hardStopAfter: 2 },
				},
			})
			const breaker = new CircuitBreaker(config)
			const event = makeEvent({ errorMessage: "Error" })

			// First call -> warn -> HALF_OPEN
			breaker.processEvent(event)
			// Second call -> block -> OPEN + throw
			expect(() => breaker.processEvent(event)).toThrow(GuardrailError)
			expect(breaker.getState().state).toBe("OPEN")
		})
	})

	describe("State Machine — HALF_OPEN", () => {
		it("should produce warning reason when HALF_OPEN with prior failures", () => {
			const breaker = new CircuitBreaker(makeConfig())
			breaker.forceState("HALF_OPEN")
			breaker.recordCall("write_to_file", "/path/file.ts", false)

			const result = breaker.isAllowed("write_to_file", "/path/file.ts")
			expect(result.allowed).toBe(true)
			expect(result.reason).toContain("HALF_OPEN")
		})

		it("should transition to CLOSED on successful probe", () => {
			const breaker = new CircuitBreaker(makeConfig())
			breaker.forceState("HALF_OPEN")

			breaker.recordCall("write_to_file", "/path/file.ts", true)
			expect(breaker.getState().state).toBe("CLOSED")
		})
	})

	describe("State Machine — OPEN", () => {
		it("should block calls in OPEN state", () => {
			const breaker = new CircuitBreaker(makeConfig())
			breaker.forceState("OPEN")

			const result = breaker.isAllowed("write_to_file", "/path/file.ts")
			expect(result.allowed).toBe(false)
		})
	})

	describe("recordCall()", () => {
		it("should increment failure count on failure", () => {
			const breaker = new CircuitBreaker(makeConfig())
			breaker.recordCall("write_to_file", "/path/file.ts", false)
			expect(breaker.getFailureCount("write_to_file", "/path/file.ts")).toBe(1)
		})

		it("should decrease failure count on success", () => {
			const breaker = new CircuitBreaker(makeConfig())
			breaker.recordCall("write_to_file", "/path/file.ts", false)
			breaker.recordCall("write_to_file", "/path/file.ts", true)
			expect(breaker.getFailureCount("write_to_file", "/path/file.ts")).toBe(0)
		})
	})

	describe("getFailureCount()", () => {
		it("should return 0 for unknown key", () => {
			const breaker = new CircuitBreaker(makeConfig())
			expect(breaker.getFailureCount("unknown", "/path")).toBe(0)
		})
	})

	describe("processEvent() — recording incidents", () => {
		it("should record incidents from processEvent", () => {
			const config = makeConfig({
				detectionThresholds: {
					[DetectionType.EXACT_REPEAT]: { warnAfter: 1, hardStopAfter: 3 },
				},
			})
			const breaker = new CircuitBreaker(config)
			const event = makeEvent({ errorMessage: "Error" })

			breaker.processEvent(event)
			const incidents = breaker.getIncidents()
			expect(incidents.length).toBeGreaterThan(0)
			expect(incidents[0].severity).toBe("warn")
		})
	})

	describe("checkIdempotentNoProgress()", () => {
		it("should delegate to detector", () => {
			const config = makeConfig({
				detectionThresholds: {
					[DetectionType.IDEMPOTENT_NO_PROGRESS]: { warnAfter: 1, hardStopAfter: 2 },
				},
			})
			const breaker = new CircuitBreaker(config)
			breaker.checkIdempotentNoProgress("/path/file.ts", "content")
			// No throw on first call
			expect(breaker.getDetector().getIdempotentCount("/path/file.ts")).toBe(1)
		})

		it("should record incident after repeated same content", () => {
			const config = makeConfig({
				detectionThresholds: {
					[DetectionType.IDEMPOTENT_NO_PROGRESS]: { warnAfter: 2, hardStopAfter: 3 },
				},
			})
			const breaker = new CircuitBreaker(config)
			breaker.checkIdempotentNoProgress("/path/file.ts", "same")
			breaker.checkIdempotentNoProgress("/path/file.ts", "same")
			const incidents = breaker.getIncidents()
			expect(incidents.length).toBe(1)
			expect(incidents[0].severity).toBe("warn")
			expect(incidents[0].type).toBe(DetectionType.IDEMPOTENT_NO_PROGRESS)
		})
	})

	describe("reset()", () => {
		it("should reset to CLOSED state and clear all state", () => {
			const breaker = new CircuitBreaker(makeConfig())
			breaker.forceState("OPEN")
			breaker.recordCall("tool", "/path", false)

			breaker.reset()
			expect(breaker.getState().state).toBe("CLOSED")
			expect(breaker.getFailureCount("tool", "/path")).toBe(0)
		})
	})

	describe("forceState()", () => {
		it("should force transition to any state", () => {
			const breaker = new CircuitBreaker(makeConfig())
			breaker.forceState("OPEN")
			expect(breaker.getState().state).toBe("OPEN")
		})
	})
})
