import { ProfileManager } from "../ProfileManager"
import { ProfileStore } from "../ProfileStore"
import { ProfileError, type ProfileConfig } from "../types"

describe("ProfileManager", () => {
	let store: ProfileStore
	let manager: ProfileManager

	beforeEach(() => {
		store = new ProfileStore({ baseDir: "/tmp/test-profiles" })
		manager = new ProfileManager({ store })
	})

	describe("constructor", () => {
		it("should create store and migrator automatically when not provided", () => {
			const m = new ProfileManager()
			expect(m.getActive()).toBeNull()
		})
	})

	describe("activate()", () => {
		it("should throw if profile not found", async () => {
			await expect(manager.activate("non-existent")).rejects.toThrow(ProfileError)
		})

		it("should activate an existing profile", async () => {
			const profile: ProfileConfig = {
				id: "test-1",
				name: "Test Profile",
				scope: "workspace",
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}
			await store.save(profile)
			const result = await manager.activate("test-1")
			expect(result.id).toBe("test-1")
			expect(manager.getActive()?.id).toBe("test-1")
		})

		it("should overwrite previous active profile", async () => {
			const p1: ProfileConfig = { id: "p1", name: "P1", scope: "global", version: 1, createdAt: 1, updatedAt: 1 }
			const p2: ProfileConfig = { id: "p2", name: "P2", scope: "global", version: 1, createdAt: 2, updatedAt: 2 }
			await store.save(p1)
			await store.save(p2)

			await manager.activate("p1")
			expect(manager.getActive()?.id).toBe("p1")

			await manager.activate("p2")
			expect(manager.getActive()?.id).toBe("p2")
		})
	})

	describe("deactivate()", () => {
		it("should set active profile to null", async () => {
			const profile: ProfileConfig = {
				id: "t",
				name: "T",
				scope: "workspace",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			}
			await store.save(profile)
			await manager.activate("t")
			expect(manager.getActive()).not.toBeNull()

			await manager.deactivate()
			expect(manager.getActive()).toBeNull()
		})
	})

	describe("getActiveBoundaries()", () => {
		it("should return empty array when no active profile", () => {
			expect(manager.getActiveBoundaries()).toEqual([])
		})

		it("should include filesystem boundaries from allowed/denied paths", async () => {
			const profile: ProfileConfig = {
				id: "b",
				name: "B",
				scope: "global",
				version: 1,
				allowedPaths: ["/home/user/allowed/**"],
				deniedPaths: ["/home/user/denied/**"],
				createdAt: 1,
				updatedAt: 1,
			}
			await store.save(profile)
			await manager.activate("b")

			const boundaries = manager.getActiveBoundaries()
			expect(boundaries.some((b) => b.type === "filesystem")).toBe(true)
		})

		it("should include env boundaries when envVars present", async () => {
			const profile: ProfileConfig = {
				id: "e",
				name: "E",
				scope: "global",
				version: 1,
				envVars: { API_KEY: "secret" },
				createdAt: 1,
				updatedAt: 1,
			}
			await store.save(profile)
			await manager.activate("e")

			const boundaries = manager.getActiveBoundaries()
			expect(boundaries.some((b) => b.type === "env")).toBe(true)
		})

		it("should include tools boundaries when maxToolIterations set", async () => {
			const profile: ProfileConfig = {
				id: "t",
				name: "T",
				scope: "global",
				version: 1,
				maxToolIterations: 100,
				createdAt: 1,
				updatedAt: 1,
			}
			await store.save(profile)
			await manager.activate("t")

			const boundaries = manager.getActiveBoundaries()
			expect(boundaries.some((b) => b.type === "tools")).toBe(true)
		})
	})

	describe("checkIsolation()", () => {
		it("should return true when no active profile", () => {
			expect(manager.checkIsolation("filesystem", "/any/path")).toBe(true)
		})

		it("should block denied paths", async () => {
			const profile: ProfileConfig = {
				id: "d",
				name: "D",
				scope: "global",
				version: 1,
				deniedPaths: ["/secret/**"],
				createdAt: 1,
				updatedAt: 1,
			}
			await store.save(profile)
			await manager.activate("d")

			expect(manager.checkIsolation("filesystem", "/secret/data.txt")).toBe(false)
			expect(manager.checkIsolation("filesystem", "/public/data.txt")).toBe(true)
		})

		it("should block via env boundary", async () => {
			const profile: ProfileConfig = {
				id: "ev",
				name: "EV",
				scope: "global",
				version: 1,
				envVars: { DB_PASS: "secret" },
				createdAt: 1,
				updatedAt: 1,
			}
			await store.save(profile)
			await manager.activate("ev")

			expect(manager.checkIsolation("env", "DB_PASS")).toBe(false)
		})
	})
})
