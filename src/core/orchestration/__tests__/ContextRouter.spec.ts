/**
 * Tests for ContextRouter — context building, diffing, token allocation.
 */

import { describe, it, expect } from "vitest"

import type { SubtaskNode } from "@roo-code/types"
import { ContextRouter } from "../ContextRouter"
import { LockManager } from "../LockManager"
import { Blackboard } from "../Blackboard"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("ContextRouter", () => {
	const testDir = path.join(os.tmpdir(), "roo-context-test")
	let router: ContextRouter

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true })
		const lockManager = new LockManager(path.join(testDir, "heartbeats"))
		const blackboard = new Blackboard(lockManager, path.join(testDir, "topics"))
		router = new ContextRouter(blackboard)
	})

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true })
	})

	describe("buildContext", () => {
		it("should build context for a subtask with no input files", async () => {
			const subtask: SubtaskNode = {
				id: "test",
				name: "Test",
				mode: "code",
				prompt: "Do something",
				inputFiles: [],
				outputFiles: [],
				deps: [],
				requiredResources: [],
				subscribedTopics: [],
				publishedTopics: [],
				estimatedTokens: 5000,
				timeoutMs: 300_000,
				isCritical: false,
				status: "pending",
				metadata: { correlationId: "test-run" },
			}
			const context = await router.buildContext(subtask)
			expect(context.prompt).toBe("Do something")
			expect(context.fileContext).toHaveLength(0)
			expect(context.blackboardContext).toHaveLength(0)
			expect(context.tokenBudget).toBe(5000)
		})

		it("should read input files", async () => {
			const filePath = path.join(testDir, "input.txt")
			fs.writeFileSync(filePath, "file content", "utf-8")

			const subtask: SubtaskNode = {
				id: "test",
				name: "Test",
				mode: "code",
				prompt: "Read file",
				inputFiles: [filePath],
				outputFiles: [],
				deps: [],
				requiredResources: [],
				subscribedTopics: [],
				publishedTopics: [],
				estimatedTokens: 5000,
				timeoutMs: 300_000,
				isCritical: false,
				status: "pending",
				metadata: { correlationId: "test-run" },
			}
			const context = await router.buildContext(subtask)
			expect(context.fileContext).toHaveLength(1)
			expect(context.fileContext[0].content).toBe("file content")
		})
	})

	describe("diffContext", () => {
		it("should detect added files", () => {
			const previous = {
				prompt: "test",
				modeDefinition: { roleDefinition: "", groups: [] },
				fileContext: [],
				blackboardContext: [],
				globalAlignment: { architectureDecisions: [], namingConventions: [], sharedTypes: [] },
				tokenBudget: 1000,
			}
			const current = {
				...previous,
				fileContext: [{ path: "new.txt", content: "hello", format: "full" as const }],
			}
			const diff = router.diffContext(previous, current)
			expect(diff.added).toContain("new.txt")
		})

		it("should detect removed files", () => {
			const previous = {
				prompt: "test",
				modeDefinition: { roleDefinition: "", groups: [] },
				fileContext: [{ path: "old.txt", content: "bye", format: "full" as const }],
				blackboardContext: [],
				globalAlignment: { architectureDecisions: [], namingConventions: [], sharedTypes: [] },
				tokenBudget: 1000,
			}
			const current = {
				...previous,
				fileContext: [],
			}
			const diff = router.diffContext(previous, current)
			expect(diff.removed).toContain("old.txt")
		})

		it("should detect modified files", () => {
			const previous = {
				prompt: "test",
				modeDefinition: { roleDefinition: "", groups: [] },
				fileContext: [{ path: "file.txt", content: "old", format: "full" as const }],
				blackboardContext: [],
				globalAlignment: { architectureDecisions: [], namingConventions: [], sharedTypes: [] },
				tokenBudget: 1000,
			}
			const current = {
				...previous,
				fileContext: [{ path: "file.txt", content: "new", format: "full" as const }],
			}
			const diff = router.diffContext(previous, current)
			expect(diff.modified).toContain("file.txt")
		})
	})

	describe("allocateTokenBudget", () => {
		it("should allocate equally with equal strategy", () => {
			const subtasks = [
				{ id: "a", estimatedTokens: 1000 } as SubtaskNode,
				{ id: "b", estimatedTokens: 2000 } as SubtaskNode,
			]
			const allocation = router.allocateTokenBudget(subtasks, 6000, "equal")
			expect(allocation.get("a")).toBe(3000)
			expect(allocation.get("b")).toBe(3000)
		})

		it("should allocate proportionally with weighted strategy", () => {
			const subtasks = [
				{ id: "a", estimatedTokens: 1000 } as SubtaskNode,
				{ id: "b", estimatedTokens: 3000 } as SubtaskNode,
			]
			const allocation = router.allocateTokenBudget(subtasks, 8000, "weighted")
			expect(allocation.get("a")).toBe(2000)
			expect(allocation.get("b")).toBe(6000)
		})

		it("should return empty map for empty subtasks", () => {
			const allocation = router.allocateTokenBudget([], 1000, "equal")
			expect(allocation.size).toBe(0)
		})
	})
})
