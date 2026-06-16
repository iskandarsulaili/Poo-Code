/**
 * Blackboard — shared state mechanism (.roosync) for cross-subtask communication.
 *
 * Follows a topic-based Pub/Sub model with deterministic conflict resolution.
 * Topics are stored as JSON files under `.roo/.roosync/topics/{topic}.json`.
 * Supports 8 built-in topics with configurable conflict strategies.
 *
 * @module
 */

import * as fs from "fs"
import * as path from "path"

import type { BlackboardEntry, BlackboardTopic, ConflictRecord, ConflictStrategy, PublishResult } from "@roo-code/types"

import { LockManager } from "./LockManager"

// ============================================================================
// Constants
// ============================================================================

/** Directory for topic files. */
const TOPICS_DIR = path.join(".roo", ".roosync", "topics")

/** Directory for subscription tracking. */
const SUBSCRIPTIONS_FILE = path.join(".roo", ".roosync", "subscriptions.json")

/** Default conflict strategy. */
const DEFAULT_CONFLICT_STRATEGY: ConflictStrategy = "last-writer-wins"

// ============================================================================
// Built-in Topic Definitions
// ============================================================================

/**
 * Definition of a built-in blackboard topic.
 */
interface TopicDefinition {
	name: string
	description: string
	conflictStrategy: ConflictStrategy
	requiresApproval: boolean
}

/**
 * Registry of all built-in topics.
 */
const BUILTIN_TOPICS: TopicDefinition[] = [
	{
		name: "db-schema-changes",
		description: "Database schema modifications",
		conflictStrategy: "merge",
		requiresApproval: true,
	},
	{
		name: "api-spec",
		description: "API endpoint definitions",
		conflictStrategy: "supervisor",
		requiresApproval: true,
	},
	{
		name: "shared-types",
		description: "Shared type definitions",
		conflictStrategy: "last-writer-wins",
		requiresApproval: false,
	},
	{
		name: "naming-conventions",
		description: "Naming decisions",
		conflictStrategy: "last-writer-wins",
		requiresApproval: false,
	},
	{
		name: "architecture-decisions",
		description: "ADRs and design choices",
		conflictStrategy: "supervisor",
		requiresApproval: true,
	},
	{
		name: "file-ownership",
		description: "Which subtask owns which files",
		conflictStrategy: "last-writer-wins",
		requiresApproval: false,
	},
	{
		name: "error-protocol",
		description: "Error codes and handling patterns",
		conflictStrategy: "merge",
		requiresApproval: false,
	},
	{
		name: "test-strategy",
		description: "Testing approach decisions",
		conflictStrategy: "last-writer-wins",
		requiresApproval: false,
	},
]

// ============================================================================
// Blackboard
// ============================================================================

/**
 * Shared blackboard for cross-subtask communication via topic-based Pub/Sub.
 *
 * Topics are stored as individual JSON files under `.roo/.roosync/topics/`.
 * Subscriptions are tracked in `.roo/.roosync/subscriptions.json`.
 * Conflict resolution follows per-topic strategies.
 */
export class Blackboard {
	private lockManager: LockManager
	private topicsDir: string
	private subscriptionsFile: string
	private subscriptions: Map<string, string[]> = new Map() // subtaskId → topic[]
	private topicVersions: Map<string, number> = new Map() // topic → current version

	/**
	 * @param lockManager - LockManager instance for implicit lock acquisition
	 * @param topicsDir - Directory for topic files (default: `.roo/.roosync/topics`)
	 */
	constructor(lockManager: LockManager, topicsDir?: string) {
		this.lockManager = lockManager
		this.topicsDir = topicsDir ?? TOPICS_DIR
		this.subscriptionsFile = path.join(path.dirname(this.topicsDir), "subscriptions.json")

		// Ensure directories exist
		fs.mkdirSync(this.topicsDir, { recursive: true })

		// Load existing subscriptions
		this.loadSubscriptions()
	}

	/**
	 * Publish data to a topic.
	 * Automatically acquires a write lock on the topic via LockManager.
	 *
	 * @param topic - Topic name
	 * @param data - Data to publish
	 * @param subtaskId - Publishing subtask ID
	 * @returns PublishResult indicating acceptance, conflict, or error
	 */
	async publish(topic: string, data: unknown, subtaskId: string): Promise<PublishResult> {
		console.log(`[Blackboard] publish: topic="${topic}" subtask="${subtaskId}"`)

		// Acquire write lock on topic
		const lock = await this.lockManager.acquire({
			level: "roosync",
			target: `topic:${topic}`,
			type: "write",
			subtaskId,
			timeoutMs: 10_000,
		})

		if (!lock) {
			return { status: "error", reason: `Could not acquire lock on topic "${topic}"` }
		}

		try {
			// Check for conflicts
			const existing = await this.readTopicFile(topic)
			const conflict = await this.detectConflict(topic, data, subtaskId)

			if (conflict) {
				// Resolve conflict based on strategy
				const strategy = this.getTopicStrategy(topic)
				await this.resolveConflict(conflict, strategy)

				if (strategy === "last-writer-wins") {
					// Our write wins — proceed
				} else if (strategy === "merge") {
					// Merge existing and new data
					data = this.mergeData(topic, existing?.data, data)
				} else if (strategy === "supervisor") {
					// Escalate to supervisor — for now, fall back to last-writer-wins
					console.warn(
						`[Blackboard] Supervisor strategy not implemented for topic "${topic}", falling back to last-writer-wins`,
					)
				}
			}

			// Write topic file
			const version = (existing?.version ?? 0) + 1
			const entry: BlackboardEntry = {
				topic,
				data,
				version,
				timestamp: new Date().toISOString(),
				subtaskId,
			}

			await this.writeTopicFile(topic, entry)
			this.topicVersions.set(topic, version)

			console.log(`[Blackboard] published: topic="${topic}" version=${version} subtask="${subtaskId}"`)

			return { status: "accepted", version }
		} finally {
			this.lockManager.release(lock.lockId)
		}
	}

	/**
	 * Subscribe a subtask to one or more topics.
	 *
	 * @param subtaskId - Subtask ID
	 * @param topics - Topics to subscribe to
	 */
	subscribe(subtaskId: string, topics: string[]): void {
		const existing = this.subscriptions.get(subtaskId) ?? []
		const uniqueTopics = new Set([...existing, ...topics])
		this.subscriptions.set(subtaskId, [...uniqueTopics])
		this.saveSubscriptions()
		console.log(`[Blackboard] subscribe: subtask="${subtaskId}" topics=[${topics.join(", ")}]`)
	}

	/**
	 * Unsubscribe a subtask from topics.
	 *
	 * @param subtaskId - Subtask ID
	 * @param topics - Topics to unsubscribe from (all if not specified)
	 */
	unsubscribe(subtaskId: string, topics?: string[]): void {
		if (!topics) {
			this.subscriptions.delete(subtaskId)
		} else {
			const existing = this.subscriptions.get(subtaskId)
			if (existing) {
				const remaining = existing.filter((t) => !topics.includes(t))
				if (remaining.length > 0) {
					this.subscriptions.set(subtaskId, remaining)
				} else {
					this.subscriptions.delete(subtaskId)
				}
			}
		}
		this.saveSubscriptions()
		console.log(`[Blackboard] unsubscribe: subtask="${subtaskId}"`)
	}

	/**
	 * Read the current data for a topic.
	 *
	 * @param topic - Topic name
	 * @returns BlackboardEntry or null if topic doesn't exist
	 */
	async getTopic(topic: string): Promise<BlackboardEntry | null> {
		return this.readTopicFile(topic)
	}

	/**
	 * Get all topics a subtask is subscribed to.
	 *
	 * @param subtaskId - Subtask ID
	 * @returns Array of topic names
	 */
	getSubscribedTopics(subtaskId: string): string[] {
		return this.subscriptions.get(subtaskId) ?? []
	}

	/**
	 * Detect a conflict when publishing to a topic.
	 *
	 * @param topic - Topic name
	 * @param _newData - New data being published
	 * @param subtaskId - Publishing subtask ID
	 * @returns ConflictRecord if conflict detected, null otherwise
	 */
	async detectConflict(topic: string, _newData: unknown, subtaskId: string): Promise<ConflictRecord | null> {
		const existing = await this.readTopicFile(topic)
		if (!existing) {
			return null
		}

		// If the existing entry was written by a different subtask at the same version,
		// we have a conflict
		if (existing.subtaskId !== subtaskId) {
			return {
				topic,
				versionA: existing.version,
				versionB: existing.version + 1,
				subtaskIdA: subtaskId,
				subtaskIdB: existing.subtaskId,
				strategy: this.getTopicStrategy(topic),
				resolved: false,
			}
		}

		return null
	}

	/**
	 * Resolve a conflict using the specified strategy.
	 *
	 * @param record - Conflict record
	 * @param strategy - Resolution strategy
	 */
	async resolveConflict(record: ConflictRecord, strategy: ConflictStrategy): Promise<void> {
		console.log(
			`[Blackboard] resolveConflict: topic="${record.topic}" strategy="${strategy}" ` +
				`versionA=${record.versionA} versionB=${record.versionB}`,
		)

		record.resolved = true
		// Conflict resolution is handled inline in publish()
	}

	/**
	 * Get all available topic definitions.
	 *
	 * @returns Array of topic definitions
	 */
	getTopics(): TopicDefinition[] {
		return [...BUILTIN_TOPICS]
	}

	/**
	 * Get all current subscriptions.
	 *
	 * @returns Map of subtaskId → topic[]
	 */
	getSubscriptions(): Map<string, string[]> {
		return new Map(this.subscriptions)
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Get the file path for a topic.
	 */
	private getTopicFilePath(topic: string): string {
		return path.join(this.topicsDir, `${topic}.json`)
	}

	/**
	 * Read a topic file from disk.
	 */
	private async readTopicFile(topic: string): Promise<BlackboardEntry | null> {
		const filePath = this.getTopicFilePath(topic)
		try {
			const content = await fs.promises.readFile(filePath, "utf-8")
			return JSON.parse(content) as BlackboardEntry
		} catch {
			return null
		}
	}

	/**
	 * Write a topic file to disk atomically.
	 */
	private async writeTopicFile(topic: string, entry: BlackboardEntry): Promise<void> {
		const filePath = this.getTopicFilePath(topic)
		const tmpPath = filePath + ".tmp"
		await fs.promises.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf-8")
		await fs.promises.rename(tmpPath, filePath)
	}

	/**
	 * Get the conflict strategy for a topic.
	 */
	private getTopicStrategy(topic: string): ConflictStrategy {
		const def = BUILTIN_TOPICS.find((t) => t.name === topic)
		return def?.conflictStrategy ?? DEFAULT_CONFLICT_STRATEGY
	}

	/**
	 * Merge existing and incoming data for merge-strategy topics.
	 */
	private mergeData(topic: string, existing: unknown, incoming: unknown): unknown {
		switch (topic) {
			case "db-schema-changes": {
				const existingSchema = existing as Record<string, unknown> | undefined
				const incomingSchema = incoming as Record<string, unknown>
				return {
					...incomingSchema,
					addedTables: [
						...new Set([
							...((existingSchema?.addedTables as string[]) ?? []),
							...((incomingSchema.addedTables as string[]) ?? []),
						]),
					],
					removedTables: [
						...new Set([
							...((existingSchema?.removedTables as string[]) ?? []),
							...((incomingSchema.removedTables as string[]) ?? []),
						]),
					],
				}
			}
			case "error-protocol": {
				const existingErrors = existing as Record<string, unknown> | undefined
				const incomingErrors = incoming as Record<string, unknown>
				return {
					...incomingErrors,
					errorCodes: {
						...(existingErrors?.errorCodes as Record<string, unknown>),
						...(incomingErrors.errorCodes as Record<string, unknown>),
					},
				}
			}
			default:
				// Last-writer-wins fallback
				return incoming
		}
	}

	/**
	 * Load subscriptions from disk.
	 */
	private loadSubscriptions(): void {
		try {
			const content = fs.readFileSync(this.subscriptionsFile, "utf-8")
			const data = JSON.parse(content) as Record<string, string[]>
			this.subscriptions = new Map(Object.entries(data))
		} catch {
			this.subscriptions = new Map()
		}
	}

	/**
	 * Save subscriptions to disk.
	 */
	private saveSubscriptions(): void {
		try {
			fs.mkdirSync(path.dirname(this.subscriptionsFile), { recursive: true })
			const data: Record<string, string[]> = {}
			for (const [key, value] of this.subscriptions) {
				data[key] = value
			}
			fs.writeFileSync(this.subscriptionsFile, JSON.stringify(data, null, 2), "utf-8")
		} catch (error) {
			console.error(`[Blackboard] Failed to save subscriptions: ${error}`)
		}
	}
}
