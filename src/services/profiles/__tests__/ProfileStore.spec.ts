import { ProfileStore } from "../ProfileStore"
import type { ProfileConfig } from "../types"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

describe("ProfileStore", () => {
	const testDir = path.join(os.tmpdir(), "zoo-profiles-test", `store-${Date.now()}`)
	let store: ProfileStore

	beforeEach(async () => {
		store = new ProfileStore({ baseDir: testDir })
		await store.initialize()
	})

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true })
	})

	const makeProfile = (id: string, overrides: Partial<ProfileConfig> = {}): ProfileConfig => ({
		id,
		name: `Profile ${id}`,
		scope: "global",
		version: 1,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	})

	describe("initialize()", () => {
		it("should create the base directory", async () => {
			await expect(fs.stat(testDir)).resolves.toBeDefined()
		})

		it("should be idempotent", async () => {
			await store.initialize()
			await expect(fs.stat(testDir)).resolves.toBeDefined()
		})
	})

	describe("save()", () => {
		it("should persist a new profile", async () => {
			const profile = makeProfile("p1")
			await store.save(profile)
			const retrieved = await store.get("p1")
			expect(retrieved).toBeDefined()
			expect(retrieved!.name).toBe("Profile p1")
		})

		it("should preserve createdAt on update", async () => {
			const profile = makeProfile("p2", { createdAt: 100 })
			await store.save(profile)
			profile.name = "Updated"
			await store.save(profile)

			const retrieved = await store.get("p2")
			expect(retrieved!.createdAt).toBe(100)
			expect(retrieved!.name).toBe("Updated")
		})

		it("should persist to disk", async () => {
			const profile = makeProfile("p3")
			await store.save(profile)
			const filePath = path.join(testDir, "p3.json")
			const content = await fs.readFile(filePath, "utf-8")
			const parsed = JSON.parse(content)
			expect(parsed.id).toBe("p3")
		})
	})

	describe("get()", () => {
		it("should return undefined for unknown id", async () => {
			const result = await store.get("unknown")
			expect(result).toBeUndefined()
		})

		it("should return saved profile", async () => {
			const profile = makeProfile("p4")
			await store.save(profile)
			const result = await store.get("p4")
			expect(result!.id).toBe("p4")
		})
	})

	describe("getAll()", () => {
		it("should return all profiles", async () => {
			await store.save(makeProfile("a"))
			await store.save(makeProfile("b"))
			const all = await store.getAll()
			expect(all).toHaveLength(2)
		})

		it("should return empty array when none saved", async () => {
			const store2 = new ProfileStore({ baseDir: path.join(testDir, "empty") })
			await store2.initialize()
			expect(await store2.getAll()).toEqual([])
			await fs.rm(path.join(testDir, "empty"), { recursive: true, force: true })
		})
	})

	describe("delete()", () => {
		it("should remove profile from cache and disk", async () => {
			const profile = makeProfile("d1")
			await store.save(profile)
			await store.delete("d1")

			expect(await store.get("d1")).toBeUndefined()
			const filePath = path.join(testDir, "d1.json")
			await expect(fs.stat(filePath)).rejects.toThrow()
		})

		it("should not throw when deleting non-existent", async () => {
			await expect(store.delete("non-existent")).resolves.toBeUndefined()
		})
	})

	describe("constructor", () => {
		it("should use default dir when no options provided", () => {
			const s = new ProfileStore()
			expect(s).toBeInstanceOf(ProfileStore)
		})
	})
})
