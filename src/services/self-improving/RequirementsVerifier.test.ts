import { describe, it, expect, vi, beforeEach } from "vitest"
import { RequirementsVerifier } from "./RequirementsVerifier"

describe("RequirementsVerifier", () => {
	let verifier: RequirementsVerifier
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		logger = { appendLine: vi.fn() }
		verifier = new RequirementsVerifier(logger)
	})

	describe("config", () => {
		it("should use defaults when no config provided", () => {
			const v = new RequirementsVerifier()
			const config = v.getConfig()
			expect(config.mandatory).toBe(true)
			expect(config.autoExtract).toBe(true)
			expect(config.requireAllVerified).toBe(true)
		})

		it("should merge partial config with defaults", () => {
			const v = new RequirementsVerifier(undefined, { mandatory: false })
			const config = v.getConfig()
			expect(config.mandatory).toBe(false)
			expect(config.autoExtract).toBe(true)
			expect(config.requireAllVerified).toBe(true)
		})

		it("should update config via updateConfig", () => {
			verifier.updateConfig({ requireAllVerified: false })
			const config = verifier.getConfig()
			expect(config.requireAllVerified).toBe(false)
			expect(config.mandatory).toBe(true)
		})
	})

	describe("extractFromPrompt", () => {
		it("should extract requirements from bullet points", () => {
			const prompt = `
- Implement user authentication
- Add database schema
- Write API tests
			`.trim()
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(3)
			expect(reqs[0].text).toBe("Implement user authentication")
			expect(reqs[1].text).toBe("Add database schema")
			expect(reqs[2].text).toBe("Write API tests")
			expect(reqs.every((r) => r.status === "pending")).toBe(true)
		})

		it("should extract requirements from numbered lists", () => {
			const prompt = `
1. Set up CI/CD pipeline
2. Configure monitoring
3. Deploy to production
			`.trim()
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(3)
			expect(reqs[0].text).toBe("Set up CI/CD pipeline")
			expect(reqs[1].text).toBe("Configure monitoring")
			expect(reqs[2].text).toBe("Deploy to production")
		})

		it("should extract requirements from keyword sentences", () => {
			const prompt = "The system must handle 10k concurrent users. It should encrypt all data at rest. We need to implement rate limiting."
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs.length).toBeGreaterThanOrEqual(1)
			expect(reqs.some((r) => r.text.includes("handle 10k concurrent users"))).toBe(true)
		})

		it("should treat plain prompt as one goal requirement", () => {
			const prompt = "Build a todo app"
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(1)
			expect(reqs[0].text).toBe("Build a todo app")
			expect(reqs[0].category).toBe("goal")
		})

		it("should detect category headers", () => {
			const prompt = `
	## Security
	- Encrypt all passwords
	## Constraint
	- Response time under 200ms
				`.trim()
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(2)
			expect(reqs[0].category).toBe("security")
			expect(reqs[1].category).toBe("constraint")
		})

		it("should return empty array for empty prompt", () => {
			const reqs = verifier.extractFromPrompt("")
			expect(reqs).toHaveLength(0)
		})
	})

	describe("addRequirement", () => {
		it("should add a requirement manually", () => {
			const req = verifier.addRequirement("Test requirement", "constraint")
			expect(req.text).toBe("Test requirement")
			expect(req.category).toBe("constraint")
			expect(req.status).toBe("pending")
			expect(req.id).toBeTruthy()
		})

		it("should default to functional category", () => {
			const req = verifier.addRequirement("Some requirement")
			expect(req.category).toBe("functional")
		})
	})

	describe("verifyRequirement", () => {
		it("should mark requirement as verified with evidence", () => {
			const req = verifier.addRequirement("Test")
			const result = verifier.verifyRequirement(req.id, "code-review", "Code reviewed and approved")
			expect(result).toBe(true)

			const updated = verifier.getAllRequirements()[0]
			expect(updated.status).toBe("verified")
			expect(updated.verifiedBy).toBe("code-review")
			expect(updated.evidence).toBe("Code reviewed and approved")
			expect(updated.verifiedAt).toBeGreaterThan(0)
		})

		it("should return false for unknown id", () => {
			const result = verifier.verifyRequirement("nonexistent", "manual", "n/a")
			expect(result).toBe(false)
		})
	})

	describe("failRequirement", () => {
		it("should mark requirement as failed with evidence", () => {
			const req = verifier.addRequirement("Test")
			const result = verifier.failRequirement(req.id, "Build failed")
			expect(result).toBe(true)

			const updated = verifier.getAllRequirements()[0]
			expect(updated.status).toBe("failed")
			expect(updated.evidence).toBe("Build failed")
		})

		it("should return false for unknown id", () => {
			const result = verifier.failRequirement("nonexistent", "n/a")
			expect(result).toBe(false)
		})
	})

	describe("getAllRequirements", () => {
		it("should return all requirements", () => {
			verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")
			expect(verifier.getAllRequirements()).toHaveLength(2)
		})

		it("should return empty array when no requirements", () => {
			expect(verifier.getAllRequirements()).toHaveLength(0)
		})
	})

	describe("getRequirementsByStatus", () => {
		it("should filter by status", () => {
			const r1 = verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")
			verifier.verifyRequirement(r1.id, "manual", "done")

			const verified = verifier.getRequirementsByStatus("verified")
			const pending = verifier.getRequirementsByStatus("pending")

			expect(verified).toHaveLength(1)
			expect(verified[0].text).toBe("Req 1")
			expect(pending).toHaveLength(1)
			expect(pending[0].text).toBe("Req 2")
		})
	})

	describe("verify", () => {
		it("should return passed=true when no requirements", async () => {
			const result = await verifier.verify()
			expect(result.passed).toBe(true)
			expect(result.total).toBe(0)
			expect(result.summary).toBe("No requirements extracted")
		})

		it("should return passed=true when all verified", async () => {
			const r1 = verifier.addRequirement("Req 1")
			const r2 = verifier.addRequirement("Req 2")
			verifier.verifyRequirement(r1.id, "test", "Tests pass")
			verifier.verifyRequirement(r2.id, "code-review", "Reviewed")

			const result = await verifier.verify()
			expect(result.passed).toBe(true)
			expect(result.total).toBe(2)
			expect(result.verified).toHaveLength(2)
			expect(result.failed).toHaveLength(0)
			expect(result.pending).toHaveLength(0)
		})

		it("should return passed=false when any failed", async () => {
			const r1 = verifier.addRequirement("Req 1")
			verifier.failRequirement(r1.id, "Failed")

			const result = await verifier.verify()
			expect(result.passed).toBe(false)
			expect(result.total).toBe(1)
			expect(result.failed).toHaveLength(1)
			expect(result.summary).toContain("requirements failed")
		})

		it("should return passed=false when pending and requireAllVerified=true", async () => {
			verifier.addRequirement("Req 1")

			const result = await verifier.verify()
			expect(result.passed).toBe(false)
			expect(result.pending).toHaveLength(1)
		})

		it("should return passed=true when pending and requireAllVerified=false", async () => {
			verifier.updateConfig({ requireAllVerified: false })
			verifier.addRequirement("Req 1")

			const result = await verifier.verify()
			expect(result.passed).toBe(true)
			expect(result.pending).toHaveLength(1)
		})
	})

	describe("reset", () => {
		it("should clear all requirements", () => {
			verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")
			expect(verifier.getAllRequirements()).toHaveLength(2)

			verifier.reset()
			expect(verifier.getAllRequirements()).toHaveLength(0)
		})
	})
})
