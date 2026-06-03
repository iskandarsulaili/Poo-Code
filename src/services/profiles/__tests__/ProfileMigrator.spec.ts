import { ProfileMigrator } from "../ProfileMigrator"
import { ProfileStore } from "../ProfileStore"
import type { ProfileConfig } from "../types"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"

describe("ProfileMigrator", () => {
	const testDir = path.join(os.tmpdir(), "zoo-profiles-test", `migrator-${Date.now()}`)
	let store: ProfileStore
	let migrator: ProfileMigrator

	beforeEach(async () => {
		store = new ProfileStore({ baseDir: testDir })
		await store.initialize()
		migrator = new ProfileMigrator(store)
	})

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true })
	})

	const makeProfile = (version: number, overrides: Partial<ProfileConfig> = {}): ProfileConfig => ({
		id: "test-profile",
		name: "Test",
		scope: "global",
		version,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	})

	describe("getLatestVersion()", () => {
		it("should return the latest registered migration version", () => {
			expect(migrator.getLatestVersion()).toBeGreaterThanOrEqual(3)
		})
	})

	describe("registerMigration()", () => {
		it("should register a new migration step", () => {
			migrator.registerMigration({
				fromVersion: 3,
				toVersion: 4,
				up: (p) => ({ ...p, newField: true }) as ProfileConfig,
				down: (p) => {
					const { newField: _, ...rest } = p as any
					return rest as ProfileConfig
				},
			})
			expect(migrator.getLatestVersion()).toBe(4)
		})
	})

	describe("migrateIfNeeded()", () => {
		it("should not migrate if version is current", async () => {
			const profile = makeProfile(3)
			const result = await migrator.migrateIfNeeded(profile)
			expect(result.version).toBe(3)
		})

		it("should migrate v1 → latest, adding default fields", async () => {
			const profile = makeProfile(1, { maxToolIterations: undefined })
			const result = await migrator.migrateIfNeeded(profile)
			expect(result.version).toBeGreaterThanOrEqual(3)
			expect(result.maxToolIterations).toBe(100)
			expect(result.autoApproveTools).toEqual([])
			expect(result.promptAdditions).toEqual([])
			expect(result.envVars).toEqual({})
		})

		it("should migrate v2 → v3, adding env vars", async () => {
			const profile = makeProfile(2, {
				maxToolIterations: 50,
				autoApproveTools: ["write_to_file"],
				promptAdditions: [],
			})
			const result = await migrator.migrateIfNeeded(profile)
			expect(result.version).toBe(3)
			expect(result.envVars).toEqual({})
			expect(result.maxToolIterations).toBe(50)
		})

		it("should preserve existing fields during migration", async () => {
			const profile = makeProfile(1, {
				id: "preserve-test",
				name: "Original Name",
				scope: "workspace",
			})
			const result = await migrator.migrateIfNeeded(profile)
			expect(result.name).toBe("Original Name")
			expect(result.scope).toBe("workspace")
		})
	})

	describe("getHistory()", () => {
		it("should start empty", () => {
			expect(migrator.getHistory()).toEqual([])
		})

		it("should record migration history", async () => {
			const profile = makeProfile(1)
			await migrator.migrateIfNeeded(profile)
			const history = migrator.getHistory()
			expect(history.length).toBeGreaterThan(0)
			expect(history[0].success).toBe(true)
			expect(history[0].profileId).toBe("test-profile")
		})
	})
})
