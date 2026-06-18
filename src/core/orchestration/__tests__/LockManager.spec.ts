/**
 * Tests for LockManager — lock acquisition, release, deadlock detection, heartbeats.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { LockManager } from "../LockManager"

describe("LockManager", () => {
	const testDir = path.join(os.tmpdir(), "roo-lock-test")
	let lockManager: LockManager

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true })
		lockManager = new LockManager(path.join(testDir, "heartbeats"), 30_000, 5_000)
	})

	afterEach(() => {
		lockManager.dispose()
		fs.rmSync(testDir, { recursive: true, force: true })
	})

	describe("acquire", () => {
		it("should acquire a write lock", async () => {
			const grant = await lockManager.acquire({
				level: "file",
				target: "test.txt",
				type: "write",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			expect(grant).not.toBeNull()
			expect(grant!.lockId).toBeTruthy()
			expect(grant!.subtaskId).toBe("subtask-a")
			expect(grant!.type).toBe("write")
		})

		it("should allow multiple readers on same target", async () => {
			const grant1 = await lockManager.acquire({
				level: "file",
				target: "shared.txt",
				type: "read",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			const grant2 = await lockManager.acquire({
				level: "file",
				target: "shared.txt",
				type: "read",
				subtaskId: "subtask-b",
				timeoutMs: 5_000,
			})
			expect(grant1).not.toBeNull()
			expect(grant2).not.toBeNull()
		})

		it("should block write when read lock is held", async () => {
			await lockManager.acquire({
				level: "file",
				target: "shared.txt",
				type: "read",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			const grant = await lockManager.acquire({
				level: "file",
				target: "shared.txt",
				type: "write",
				subtaskId: "subtask-b",
				timeoutMs: 500,
			})
			expect(grant).toBeNull() // timeout
		})

		it("should return null on timeout", async () => {
			await lockManager.acquire({
				level: "file",
				target: "exclusive.txt",
				type: "write",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			const grant = await lockManager.acquire({
				level: "file",
				target: "exclusive.txt",
				type: "write",
				subtaskId: "subtask-b",
				timeoutMs: 100,
			})
			expect(grant).toBeNull()
		})
	})

	describe("release", () => {
		it("should release a held lock", async () => {
			const grant = await lockManager.acquire({
				level: "file",
				target: "test.txt",
				type: "write",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			expect(grant).not.toBeNull()
			lockManager.release(grant!.lockId)
			expect(lockManager.isLocked("file", "test.txt")).toBe(false)
		})
	})

	describe("isLocked", () => {
		it("should return true for locked target", async () => {
			await lockManager.acquire({
				level: "file",
				target: "locked.txt",
				type: "write",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			expect(lockManager.isLocked("file", "locked.txt")).toBe(true)
		})

		it("should return false for unlocked target", () => {
			expect(lockManager.isLocked("file", "nonexistent.txt")).toBe(false)
		})
	})

	describe("getHeldLocks", () => {
		it("should return locks held by a subtask", async () => {
			await lockManager.acquire({
				level: "file",
				target: "a.txt",
				type: "write",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			await lockManager.acquire({
				level: "file",
				target: "b.txt",
				type: "read",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			const locks = lockManager.getHeldLocks("subtask-a")
			expect(locks).toHaveLength(2)
		})
	})

	describe("releaseAll", () => {
		it("should release all locks for a subtask", async () => {
			await lockManager.acquire({
				level: "file",
				target: "a.txt",
				type: "write",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			await lockManager.acquire({
				level: "file",
				target: "b.txt",
				type: "write",
				subtaskId: "subtask-a",
				timeoutMs: 5_000,
			})
			lockManager.releaseAll("subtask-a")
			expect(lockManager.getHeldLocks("subtask-a")).toHaveLength(0)
		})
	})

	describe("heartbeat", () => {
		it("should create and check heartbeat", () => {
			const hbPath = lockManager.createHeartbeat("subtask-a")
			expect(fs.existsSync(hbPath)).toBe(true)
			expect(lockManager.isHeartbeatAlive(hbPath)).toBe(true)
		})

		it("should detect stale heartbeat", () => {
			const hbPath = lockManager.createHeartbeat("subtask-a")
			// Touch with old timestamp
			const oldTime = new Date(Date.now() - 60_000)
			fs.utimesSync(hbPath, oldTime, oldTime)
			expect(lockManager.isHeartbeatAlive(hbPath)).toBe(false)
		})
	})
})
