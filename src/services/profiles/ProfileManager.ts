/**
 * ProfileManager — Central manager for profile switching, activation, isolation.
 *
 * Handles:
 * - Profile CRUD (via ProfileStore)
 * - Profile switching with isolation boundary enforcement
 * - Profile version migration (via ProfileMigrator)
 */
import { ProfileStore } from "./ProfileStore"
import { ProfileMigrator } from "./ProfileMigrator"
import type { ProfileConfig, ProfileScope, IsolationBoundary } from "./types"
import { ProfileError } from "./types"

export class ProfileManager {
	private store: ProfileStore
	private migrator: ProfileMigrator
	private activeProfile: ProfileConfig | null = null

	constructor(options: { store?: ProfileStore } = {}) {
		this.store = options.store ?? new ProfileStore({ baseDir: "~/.zoo/profiles" })
		this.migrator = new ProfileMigrator(this.store)

		if (process.env.NODE_ENV !== "test") {
			console.log("[ProfileManager] Initialized")
		}
	}

	/**
	 * Activate a profile by ID.
	 */
	async activate(profileId: string): Promise<ProfileConfig> {
		let profile = await this.store.get(profileId)
		if (!profile) {
			throw new ProfileError(`Profile ${profileId} not found`, "PROFILE_NOT_FOUND")
		}

		// Run migrations if needed
		profile = await this.migrator.migrateIfNeeded(profile)

		this.activeProfile = profile

		if (process.env.NODE_ENV !== "test") {
			console.log(`[ProfileManager] Activated: ${profile.name} (${profile.id})`)
		}

		return profile
	}

	/**
	 * Deactivate the current profile.
	 */
	async deactivate(): Promise<void> {
		this.activeProfile = null
		if (process.env.NODE_ENV !== "test") {
			console.log("[ProfileManager] Deactivated")
		}
	}

	/**
	 * Get the currently active profile.
	 */
	getActive(): ProfileConfig | null {
		return this.activeProfile
	}

	/**
	 * Get isolation boundaries for the active profile.
	 */
	getActiveBoundaries(): IsolationBoundary[] {
		if (!this.activeProfile) return []

		const boundaries: IsolationBoundary[] = []

		if (this.activeProfile.allowedPaths || this.activeProfile.deniedPaths) {
			boundaries.push({
				type: "filesystem",
				rules: [
					...(this.activeProfile.allowedPaths?.map((p) => ({
						kind: "allow" as const,
						pattern: p,
						reason: "Profile-defined allowed path",
					})) ?? []),
					...(this.activeProfile.deniedPaths?.map((p) => ({
						kind: "deny" as const,
						pattern: p,
						reason: "Profile-defined denied path",
					})) ?? []),
				],
			})
		}

		if (this.activeProfile.envVars) {
			boundaries.push({
				type: "env",
				rules: Object.entries(this.activeProfile.envVars).map(([key]) => ({
					kind: "deny" as const,
					pattern: key,
					reason: "Env var managed by profile",
				})),
			})
		}

		if (this.activeProfile.maxToolIterations) {
			boundaries.push({
				type: "tools",
				rules: [
					{
						kind: "deny" as const,
						pattern: "tool_loop",
						reason: `Max iterations set to ${this.activeProfile.maxToolIterations}`,
					},
				],
			})
		}

		return boundaries
	}

	/**
	 * Check if an operation is permitted under active profile isolation.
	 */
	checkIsolation(type: string, value: string): boolean {
		if (!this.activeProfile) return true

		const boundaries = this.getActiveBoundaries()
		for (const boundary of boundaries) {
			if (boundary.type !== type) continue

			for (const rule of boundary.rules) {
				if (rule.kind === "deny" && this.matchGlob(rule.pattern, value)) {
					if (process.env.NODE_ENV !== "test") {
						console.log(`[ProfileManager] Isolation block: ${type}:${value} violates ${rule.pattern}`)
					}
					return false
				}
			}
		}

		return true
	}

	private matchGlob(pattern: string, value: string): boolean {
		const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
		return regex.test(value)
	}
}
