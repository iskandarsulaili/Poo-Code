// npx vitest services/__tests__/subagent/IsolatedContext.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { IsolatedContextFactory, IsolatedContext } from "../../subagent/IsolatedContext"
import { ContextError } from "../../subagent/types"

describe("IsolatedContextFactory", () => {
	describe("create", () => {
		it("should create a context with a temp directory", async () => {
			const context = await IsolatedContextFactory.create({
				role: "leaf",
				workspaceRoot: "/tmp/test-workspace",
			})

			expect(context).toBeDefined()
			expect(context.id).toBeDefined()
			expect(typeof context.id).toBe("string")
			expect(context.tempDir).toBeDefined()

			// Verify the temp directory was actually created
			const stat = await fs.stat(context.tempDir)
			expect(stat.isDirectory()).toBe(true)

			// Clean up
			await IsolatedContextFactory.destroy(context)
		})

		it("should resolve workdir relative to workspaceRoot when not provided", async () => {
			const context = await IsolatedContextFactory.create({
				role: "leaf",
				workspaceRoot: "/tmp/test-workspace",
			})

			expect(context.workdir).toBe("/tmp/test-workspace")

			await IsolatedContextFactory.destroy(context)
		})

		it("should use provided workdir when specified", async () => {
			const context = await IsolatedContextFactory.create({
				role: "leaf",
				workspaceRoot: "/tmp/test-workspace",
				workdir: "/tmp/custom-workdir",
			})

			expect(context.workdir).toBe("/tmp/custom-workdir")

			await IsolatedContextFactory.destroy(context)
		})

		it("should propagate env vars", async () => {
			const context = await IsolatedContextFactory.create({
				role: "leaf",
				workspaceRoot: "/tmp/test-workspace",
				envVars: { FOO: "bar", BAZ: "qux" },
			})

			expect(context.envVars.FOO).toBe("bar")
			expect(context.envVars.BAZ).toBe("qux")

			await IsolatedContextFactory.destroy(context)
		})
	})

	describe("restrictTools", () => {
		it("should block leaf tools for leaf role", async () => {
			const context = await IsolatedContextFactory.create({
				role: "leaf",
				workspaceRoot: "/tmp/test-workspace",
			})

			expect(context.blockedTools).toContain("delegate_task")
			expect(context.blockedTools).toContain("new_task")
			expect(context.blockedTools).toContain("memory")

			await IsolatedContextFactory.destroy(context)
		})

		it("should pass through allowedTools", async () => {
			const context = await IsolatedContextFactory.create({
				role: "leaf",
				workspaceRoot: "/tmp/test-workspace",
				allowedTools: ["read_file", "search_files", "apply_diff"],
			})

			expect(context.allowedTools).toEqual(["read_file", "search_files", "apply_diff"])

			await IsolatedContextFactory.destroy(context)
		})
	})

	describe("destroy", () => {
		it("should clean up the temp directory", async () => {
			const context = await IsolatedContextFactory.create({
				role: "leaf",
				workspaceRoot: "/tmp/test-workspace",
			})

			const tempDir = context.tempDir

			// Verify directory exists before destroy
			await expect(fs.stat(tempDir)).resolves.toBeDefined()

			await IsolatedContextFactory.destroy(context)

			// Verify directory is gone after destroy
			await expect(fs.stat(tempDir)).rejects.toThrow()
		})
	})
})
