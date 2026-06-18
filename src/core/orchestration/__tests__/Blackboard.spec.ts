/**
 * Tests for Blackboard — topic publish/subscribe, conflict detection, resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { Blackboard } from "../Blackboard"
import { LockManager } from "../LockManager"

describe("Blackboard", () => {
	const testDir = path.join(os.tmpdir(), "roo-blackboard-test")
	let lockManager: LockManager
	let blackboard: Blackboard

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true })
		lockManager = new LockManager(path.join(testDir, "heartbeats"))
		blackboard = new Blackboard(lockManager, path.join(testDir, "topics"))
	})

	afterEach(() => {
		lockManager.dispose()
		fs.rmSync(testDir, { recursive: true, force: true })
	})

	describe("publish", () => {
		it("should publish to a topic", async () => {
			const result = await blackboard.publish("shared-types", { types: ["string", "number"] }, "subtask-a")
			expect(result.status).toBe("accepted")
			if (result.status === "accepted") {
				expect(result.version).toBe(1)
			}
		})

		it("should increment version on subsequent publishes", async () => {
			await blackboard.publish("shared-types", { types: ["string"] }, "subtask-a")
			const result = await blackboard.publish("shared-types", { types: ["string", "boolean"] }, "subtask-a")
			expect(result.status).toBe("accepted")
			if (result.status === "accepted") {
				expect(result.version).toBe(2)
			}
		})
	})

	describe("subscribe", () => {
		it("should subscribe a subtask to topics", () => {
			blackboard.subscribe("subtask-a", ["shared-types", "naming-conventions"])
			const topics = blackboard.getSubscribedTopics("subtask-a")
			expect(topics).toContain("shared-types")
			expect(topics).toContain("naming-conventions")
		})
	})

	describe("unsubscribe", () => {
		it("should unsubscribe a subtask from all topics", () => {
			blackboard.subscribe("subtask-a", ["shared-types"])
			blackboard.unsubscribe("subtask-a")
			const topics = blackboard.getSubscribedTopics("subtask-a")
			expect(topics).toHaveLength(0)
		})
	})

	describe("getTopic", () => {
		it("should return null for non-existent topic", async () => {
			const entry = await blackboard.getTopic("nonexistent")
			expect(entry).toBeNull()
		})

		it("should return published data", async () => {
			await blackboard.publish("shared-types", { types: ["string"] }, "subtask-a")
			const entry = await blackboard.getTopic("shared-types")
			expect(entry).not.toBeNull()
			expect(entry!.data).toEqual({ types: ["string"] })
			expect(entry!.version).toBe(1)
		})
	})

	describe("getTopics", () => {
		it("should return built-in topic definitions", () => {
			const topics = blackboard.getTopics()
			expect(topics.length).toBeGreaterThanOrEqual(8)
			expect(topics.find((t) => t.name === "shared-types")).toBeDefined()
			expect(topics.find((t) => t.name === "db-schema-changes")).toBeDefined()
		})
	})

	describe("getSubscriptions", () => {
		it("should return all subscriptions", () => {
			blackboard.subscribe("subtask-a", ["shared-types"])
			blackboard.subscribe("subtask-b", ["api-spec"])
			const subs = blackboard.getSubscriptions()
			expect(subs.get("subtask-a")).toContain("shared-types")
			expect(subs.get("subtask-b")).toContain("api-spec")
		})
	})
})
