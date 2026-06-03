/**
 * ProfileStore — Storage for profile configs with file-system persistence.
 *
 * Stores profiles as JSON files under the configured base directory.
 * Supports CRUD operations and pruning.
 */
import type { ProfileConfig, ProfileStoreOptions } from "./types"
import { ProfileError } from "./types"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

export class ProfileStore {
	private readonly baseDir: string
	private cache: Map<string, ProfileConfig> = new Map()
	private loaded = false

	constructor(options: ProfileStoreOptions = {}) {
		this.baseDir = options.baseDir?.replace(/^~/, os.homedir()) ?? path.join(os.homedir(), ".zoo", "profiles")
	}

	/**
	 * Initialize the store (create dir, load existing profiles).
	 */
	async initialize(): Promise<void> {
		if (this.loaded) return
		await fs.mkdir(this.baseDir, { recursive: true })
		await this.loadAll()
		this.loaded = true
		if (process.env.NODE_ENV !== "test") {
			console.log(`[ProfileStore] Initialized at ${this.baseDir}`)
		}
	}

	/**
	 * Get a profile by ID.
	 */
	async get(profileId: string): Promise<ProfileConfig | undefined> {
		await this.ensureLoaded()
		return this.cache.get(profileId)
	}

	/**
	 * Get all profiles.
	 */
	async getAll(): Promise<ProfileConfig[]> {
		await this.ensureLoaded()
		return Array.from(this.cache.values())
	}

	/**
	 * Save a profile (create or update).
	 */
	async save(profile: ProfileConfig): Promise<void> {
		await this.ensureLoaded()
		const now = Date.now()
		const existing = this.cache.get(profile.id)

		const updated: ProfileConfig = {
			...profile,
			createdAt: existing?.createdAt ?? profile.createdAt ?? now,
			updatedAt: now,
		}

		this.cache.set(profile.id, updated)
		await this.persist(updated)
	}

	/**
	 * Delete a profile by ID.
	 */
	async delete(profileId: string): Promise<void> {
		await this.ensureLoaded()
		this.cache.delete(profileId)
		const filePath = this.profilePath(profileId)
		try {
			await fs.unlink(filePath)
		} catch {
			// File may not exist
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (!this.loaded) {
			await this.initialize()
		}
	}

	private async loadAll(): Promise<void> {
		try {
			const files = await fs.readdir(this.baseDir)
			for (const file of files) {
				if (file.endsWith(".json")) {
					const content = await fs.readFile(path.join(this.baseDir, file), "utf-8")
					const profile = JSON.parse(content) as ProfileConfig
					this.cache.set(profile.id, profile)
				}
			}
		} catch {
			// Directory may not exist yet
		}
	}

	private async persist(profile: ProfileConfig): Promise<void> {
		const filePath = this.profilePath(profile.id)
		await fs.writeFile(filePath, JSON.stringify(profile, null, 2), "utf-8")
	}

	private profilePath(id: string): string {
		return path.join(this.baseDir, `${id}.json`)
	}
}
