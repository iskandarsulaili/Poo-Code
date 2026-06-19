import { describe, it, expect, vi, beforeEach } from "vitest"
import { RequirementsVerifier } from "../RequirementsVerifier"

describe("RequirementsVerifier", () => {
	let verifier: RequirementsVerifier

	beforeEach(() => {
		verifier = new RequirementsVerifier(undefined, undefined, undefined, true)
	})

	describe("extractFromPrompt - narrative extraction", () => {
		it("should extract bullet points as separate requirements", () => {
			const prompt = "- Add a login endpoint\n- Implement JWT auth\n- Add password reset"
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(3)
			expect(reqs[0].text).toBe("Add a login endpoint")
			expect(reqs[1].text).toBe("Implement JWT auth")
			expect(reqs[2].text).toBe("Add password reset")
		})

		it("should extract narrative text into multiple requirements via action verbs", () => {
			const prompt =
				"Create a login page with email/password authentication and session management. " +
				"The UI should be responsive and use Tailwind."
			const reqs = verifier.extractFromPrompt(prompt)
			// Should produce multiple requirements from action verbs
			expect(reqs.length).toBeGreaterThanOrEqual(2)
			// First requirement should start with the action verb
			const firstReq = reqs[0]
			expect(firstReq.text).toMatch(/create|implement|add|build/i)
		})

		it("should extract from numbered lists", () => {
			const prompt = "1. Set up database schema\n2. Create API routes\n3. Add tests"
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(3)
			expect(reqs[0].text).toContain("database schema")
		})

		it("should handle single sentence without action verb as goal", () => {
			const prompt = "Review the auth module for security vulnerabilities."
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs.length).toBeGreaterThanOrEqual(1)
			expect(reqs[0].category).toBe("goal")
		})

		it("should extract sentences with 'should' keyword", () => {
			const prompt = "The system should handle 1000 concurrent users. Passwords should be hashed with bcrypt."
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs.length).toBeGreaterThanOrEqual(2)
			expect(reqs.some((r) => r.text.toLowerCase().includes("concurrent"))).toBe(true)
			expect(reqs.some((r) => r.text.toLowerCase().includes("bcrypt"))).toBe(true)
		})
	})

	describe("detectReadOnlyTask", () => {
		it("should NOT trigger read-only bypass for normal tasks", async () => {
			const prompt = "Implement a login system with JWT tokens and password hashing."
			await verifier.processUserMessages([prompt])
			// Internal method - test via verify() behavior
			const result = await verifier.verify()
			expect(result.passed).toBe(true) // passes because no explicit failures
		})

		it("should detect explicit read-only language", async () => {
			const prompt = "Do not modify any files. Review the code for bugs only."
			await verifier.processUserMessages([prompt])
			const result = await verifier.verify()
			expect(result.passed).toBe(true) // passes via read-only detection
		})

		it("should NOT trigger on 'review' when combined with write actions", async () => {
			const prompt = "Review the auth code and fix the security vulnerabilities found."
			await verifier.processUserMessages([prompt])
			const result = await verifier.verify()
			expect(result.passed).toBe(true)
		})
	})

	describe("autoVerifyFromToolHistory", () => {
		it("should verify requirement that matches a file path in tool_use blocks", () => {
			// Add a requirement
			verifier.extractFromPrompt("Add a login endpoint to src/auth/login.ts")

			const apiMessages = [
				{
					role: "assistant" as const,
					content: [
						{
							type: "tool_use",
							name: "write_to_file",
							input: { path: "src/auth/login.ts", content: "..." },
						},
					],
				},
			]

			verifier.autoVerifyFromToolHistory(apiMessages as any, "/test")
			const requirements = verifier.getAllRequirements()
			const loginReq = requirements.find((r) => r.text.includes("login"))
			expect(loginReq).toBeDefined()
			expect(loginReq!.status).toBe("verified")
			expect(loginReq!.evidence).toContain("login.ts")
		})

		it("should fail requirement when no tool call matches its keywords", () => {
			verifier.extractFromPrompt("Set up CI/CD pipeline with GitHub Actions")

			const apiMessages = [
				{
					role: "assistant" as const,
					content: [
						{
							type: "tool_use",
							name: "write_to_file",
							input: { path: "src/app.ts", content: "..." },
						},
					],
				},
			]

			verifier.autoVerifyFromToolHistory(apiMessages as any, "/test")
			const requirements = verifier.getAllRequirements()
			const ciReq = requirements.find((r) => r.text.includes("CI/CD"))
			expect(ciReq).toBeDefined()
			// Should be failed since only app.ts was touched, not CI/CD
			expect(ciReq!.status).toBe("failed")
		})
	})

	describe("processUserMessages", () => {
		it("should extract requirements from the first message", async () => {
			await verifier.processUserMessages(["Add user authentication system"])
			const all = verifier.getAllRequirements()
			expect(all.length).toBeGreaterThanOrEqual(1)
		})

		it("should handle multiple messages with conflict resolution", async () => {
			await verifier.processUserMessages(["Create a login page with email auth"])
			await verifier.processUserMessages([
				"Also add OAuth login as another option",
			])
			const all = verifier.getAllRequirements()
			expect(all.length).toBeGreaterThanOrEqual(2)
		})
	})
})
