/**
 * Profile Isolation — Type Definitions
 *
 * Defines all types for F9: Profile Isolation feature.
 * Enables per-project profile configs, switching, scoping, and isolation boundaries.
 */

/**
 * A profile configuration.
 */
export interface ProfileConfig {
	/** Unique profile identifier */
	id: string
	/** Human-readable profile name */
	name: string
	/** Scope of this profile */
	scope: ProfileScope
	/** Profile version for migration support */
	version: number
	/** Mode assignments per tool or operation */
	modeOverrides?: Record<string, string>
	/** Environment variables to inject */
	envVars?: Record<string, string>
	/** Paths allowed for read/write (globs) */
	allowedPaths?: string[]
	/** Paths denied for read/write (globs) */
	deniedPaths?: string[]
	/** Maximum tool iterations before forced pause */
	maxToolIterations?: number
	/** Whether to auto-approve certain tools */
	autoApproveTools?: string[]
	/** Custom system prompt additions */
	promptAdditions?: string[]
	/** Timestamp of creation (epoch ms) */
	createdAt: number
	/** Timestamp of last update (epoch ms) */
	updatedAt: number
}

/**
 * Scope determines which projects a profile applies to.
 */
export type ProfileScope = "global" | "workspace" | "project" | "folder"

/**
 * An isolation boundary enforced by the profile manager.
 */
export interface IsolationBoundary {
	/** Type of isolation */
	type: "filesystem" | "env" | "tools" | "network"
	/** Rules for this boundary */
	rules: IsolationRule[]
}

/**
 * A single isolation rule.
 */
export interface IsolationRule {
	/** Whether this is an allow or deny rule */
	kind: "allow" | "deny"
	/** Pattern (glob, env key, tool name, host) */
	pattern: string
	/** Reason for this rule */
	reason: string
}

/**
 * Options for storing profiles.
 */
export interface ProfileStoreOptions {
	/** Base directory for profile store */
	baseDir?: string
}

/**
 * Migration record for upgrading profile configs between versions.
 */
export interface MigrationRecord {
	/** Source version */
	fromVersion: number
	/** Target version */
	toVersion: number
	/** Timestamp of migration (epoch ms) */
	migratedAt: number
	/** Profile ID that was migrated */
	profileId: string
	/** Whether migration succeeded */
	success: boolean
	/** Error on failure */
	error?: string
}

/**
 * Errors thrown by profile operations.
 */
export class ProfileError extends Error {
	constructor(
		message: string,
		public readonly code: ProfileErrorCode,
	) {
		super(message)
		this.name = "ProfileError"
	}
}

/**
 * Categorised error codes for profile operations.
 */
export type ProfileErrorCode =
	| "PROFILE_NOT_FOUND"
	| "INVALID_CONFIG"
	| "ISOLATION_VIOLATION"
	| "MIGRATION_FAILED"
	| "STORE_ERROR"
	| "DUPLICATE_PROFILE"
