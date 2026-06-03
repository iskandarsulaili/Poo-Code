/**
 * ProfileMigrator — Migrates profiles between config versions.
 *
 * Handles schema evolution of ProfileConfig objects. Each version
 * step has an up() and down() migration function.
 */
import type { ProfileConfig, MigrationRecord } from "./types"
import { ProfileStore } from "./ProfileStore"
import { ProfileError } from "./types"

type MigrationFn = (profile: ProfileConfig) => ProfileConfig

interface MigrationStep {
	fromVersion: number
	toVersion: number
	up: MigrationFn
	down: MigrationFn
}

export class ProfileMigrator {
	private readonly store: ProfileStore
	private migrations: MigrationStep[] = []
	private history: MigrationRecord[] = []

	constructor(store: ProfileStore) {
		this.store = store
		this.registerDefaultMigrations()
	}

	/**
	 * Run migrations if the profile version is out of date.
	 */
	async migrateIfNeeded(profile: ProfileConfig): Promise<ProfileConfig> {
		const latestVersion = this.getLatestVersion()
		if (profile.version >= latestVersion) return profile

		if (process.env.NODE_ENV !== "test") {
			console.log(`[ProfileMigrator] Migrating ${profile.id} from v${profile.version} to v${latestVersion}`)
		}

		let current = { ...profile }

		for (const migration of this.migrations) {
			if (current.version === migration.fromVersion) {
				try {
					current = migration.up(current)
					current.version = migration.toVersion
					current.updatedAt = Date.now()

					await this.store.save(current)

					this.history.push({
						fromVersion: migration.fromVersion,
						toVersion: migration.toVersion,
						migratedAt: Date.now(),
						profileId: profile.id,
						success: true,
					})
				} catch (error) {
					this.history.push({
						fromVersion: migration.fromVersion,
						toVersion: migration.toVersion,
						migratedAt: Date.now(),
						profileId: profile.id,
						success: false,
						error: error instanceof Error ? error.message : String(error),
					})
					throw new ProfileError(
						`Migration v${migration.fromVersion} → v${migration.toVersion} failed: ${error}`,
						"MIGRATION_FAILED",
					)
				}
			}
		}

		return current
	}

	/**
	 * Register a custom migration step.
	 */
	registerMigration(step: MigrationStep): void {
		this.migrations.push(step)
		this.migrations.sort((a, b) => a.fromVersion - b.fromVersion)
	}

	/**
	 * Get migration history.
	 */
	getHistory(): MigrationRecord[] {
		return [...this.history]
	}

	/**
	 * Get the latest supported version.
	 */
	getLatestVersion(): number {
		if (this.migrations.length === 0) return 1
		return this.migrations[this.migrations.length - 1].toVersion
	}

	private registerDefaultMigrations(): void {
		// v1 → v2: Add default fields
		this.registerMigration({
			fromVersion: 1,
			toVersion: 2,
			up: (p) => ({
				...p,
				maxToolIterations: p.maxToolIterations ?? 100,
				autoApproveTools: p.autoApproveTools ?? [],
				promptAdditions: p.promptAdditions ?? [],
			}),
			down: (p) => {
				const { maxToolIterations: _, autoApproveTools: __, promptAdditions: ___, ...rest } = p
				return rest
			},
		})

		// v2 → v3: Add env vars
		this.registerMigration({
			fromVersion: 2,
			toVersion: 3,
			up: (p) => ({
				...p,
				envVars: p.envVars ?? {},
			}),
			down: (p) => {
				const { envVars: _, ...rest } = p
				return rest
			},
		})
	}
}
