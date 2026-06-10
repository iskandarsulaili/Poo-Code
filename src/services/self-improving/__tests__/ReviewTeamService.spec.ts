import { describe, it, expect, vi, beforeEach } from "vitest"
import { ReviewTeamService } from "../ReviewTeamService"
import type { LearnedPattern } from "../../../../packages/types/src/learning"

describe("ReviewTeamService", () => {
	let service: ReviewTeamService

	beforeEach(() => {
		service = new ReviewTeamService({ appendLine: vi.fn() } as any)
	})

	describe("reviewPattern", () => {
		it("should approve high-confidence patterns", async () => {
			const pattern: LearnedPattern = {
				id: "test-1",
				patternType: "tool",
				state: "active",
				summary: "high confidence pattern",
				confidenceScore: 0.8,
				frequency: 10,
				successRate: 0.9,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file", "edit_file"] },
			}
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.approved).toBe(true)
			expect(verdict.score).toBeGreaterThanOrEqual(0.5)
		})

		it("should reject very-low-confidence patterns", async () => {
			const pattern: LearnedPattern = {
				id: "test-2",
				patternType: "tool",
				state: "active",
				summary: "low confidence pattern",
				confidenceScore: 0.15, // Below minConfidenceForReview (0.2)
				frequency: 1,
				successRate: 0.5,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.approved).toBe(false)
		})

		it("should pass through when disabled", async () => {
			const disabled = new ReviewTeamService({ appendLine: vi.fn() } as any, { enabled: false })
			const pattern: LearnedPattern = {
				id: "test-3",
				patternType: "tool",
				state: "active",
				summary: "test",
				confidenceScore: 0.5,
				frequency: 3,
				successRate: 0.8,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			const verdict = await disabled.reviewPattern(pattern)
			expect(verdict.approved).toBe(true)
			expect(verdict.score).toBe(1.0)
		})

		it("should return Hermes-style SimpleVerdict (score + summary, no personas)", async () => {
			const pattern: LearnedPattern = {
				id: "test-4",
				patternType: "tool",
				state: "active",
				summary: "test",
				confidenceScore: 0.6,
				frequency: 5,
				successRate: 0.8,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file", "edit_file", "execute_command"] },
			}
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.approved).toBe(true)
			expect(typeof verdict.score).toBe("number")
			expect(typeof verdict.summary).toBe("string")
			// No persona votes
			expect((verdict as any).innovatorVote).toBeUndefined()
			expect((verdict as any).contrarianVote).toBeUndefined()
			expect((verdict as any).devilsAdvocateVote).toBeUndefined()
			expect((verdict as any).deciderVote).toBeUndefined()
		})
	})

	describe("reviewPatterns", () => {
		it("should return approved and rejected lists", async () => {
			const patterns: LearnedPattern[] = [
				{
					id: "p1",
					patternType: "tool",
					state: "active",
					summary: "good",
					confidenceScore: 0.8,
					frequency: 10,
					successRate: 0.9,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file", "edit_file"] },
				},
				{
					id: "p2",
					patternType: "tool",
					state: "active",
					summary: "bad",
					confidenceScore: 0.15, // Below minConfidenceForReview (0.2)
					frequency: 1,
					successRate: 0.3,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file"] },
				},
			]
			const result = await service.reviewPatterns(patterns)
			expect(result.approved).toHaveLength(1)
			expect(result.rejected).toHaveLength(1)
			expect(result.verdicts).toHaveLength(2)
		})

		it("should approve patterns above confidence threshold (Hermes-style, no cold-start boost)", async () => {
			const pattern: LearnedPattern = {
				id: "conf-test-1",
				patternType: "tool",
				state: "active",
				summary: "above threshold pattern",
				confidenceScore: 0.3, // Above minConfidenceForReview (0.2)
				frequency: 1,
				successRate: 0.5,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.approved).toBe(true)
			expect(verdict.score).toBeGreaterThanOrEqual(0.3)
		})

		it("should increment approvedPatternCount via reviewPatterns", async () => {
			expect(service.getApprovedPatternCount()).toBe(0)

			const patterns: LearnedPattern[] = [
				{
					id: "boost-test-1",
					patternType: "tool",
					state: "active",
					summary: "first",
					confidenceScore: 0.3,
					frequency: 1,
					successRate: 0.3,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file"] },
				},
				{
					id: "boost-test-2",
					patternType: "tool",
					state: "active",
					summary: "second",
					confidenceScore: 0.8,
					frequency: 10,
					successRate: 0.9,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file", "edit_file"] },
				},
			]
			const result = await service.reviewPatterns(patterns)
			expect(result.approved).toHaveLength(2)
			expect(service.getApprovedPatternCount()).toBe(2)
		})
	})

	describe("updateConfig", () => {
		it("should update config values (Hermes-style)", () => {
			service.updateConfig({ minConfidenceForReview: 0.3 })
			const config = service.getConfig()
			expect(config.minConfidenceForReview).toBe(0.3)
		})
	})
})
