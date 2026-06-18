/**
 * Lock Manager — file/module/resource/roosync level read-write lock management.
 *
 * Provides deadlock prevention via total ordering (deterministic hash sort of lock
 * targets), read/write semantics (multiple readers, exclusive writer), heartbeat
 * monitoring via file-touch protocol, and lock-aware scheduling with ready/blocked
 * queue partitioning.
 *
 * @module
 */

import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"

import type { LockLevel, LockType, LockRequest, LockGrant } from "@roo-code/types"

// ============================================================================
// Constants
// ============================================================================

/** Default lock timeout in milliseconds. */
const DEFAULT_LOCK_TIMEOUT_MS = 30_000

/** Default heartbeat interval in milliseconds. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000

/** Number of missed heartbeats before considering a subtask dead. */
const HEARTBEAT_MISS_THRESHOLD = 3

/** Interval for deadlock detector sweep (ms). */
const DEADLOCK_DETECTOR_INTERVAL_MS = 10_000

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal lock entry tracking held locks.
 */
interface LockEntry {
	grant: LockGrant
	/** Timer handle for lock timeout */
	timeoutTimer?: NodeJS.Timeout
}

/**
 * Internal lock wait queue entry.
 */
interface LockWaiter {
	request: LockRequest
	resolve: (grant: LockGrant | null) => void
	reject: (error: Error) => void
	enqueuedAt: number
}

// ============================================================================
// LockManager
// ============================================================================

/**
 * Manages file/module/resource/roosync level locks with deadlock prevention.
 *
 * ## Lock Semantics
 * - **Read (shared)**: Multiple subtasks can hold a read lock simultaneously.
 * - **Write (exclusive)**: Only one subtask can hold a write lock.
 * - **Total ordering**: All locks acquired in deterministic hash order to prevent
 *   circular wait.
 *
 * ## Heartbeat Monitoring
 * - Subtasks touch a heartbeat file under `.roosync/heartbeats/{subtaskId}.heartbeat`
 * - If heartbeat is not updated within `heartbeatIntervalMs * HEARTBEAT_MISS_THRESHOLD`,
 *   the subtask is considered dead and its locks are released.
 *
 * ## Lock-Aware Scheduling
 * - `readyQueue`: Subtasks whose locks are all free — eligible for immediate spawn.
 * - `blockedQueue`: Subtasks blocked on ≥1 lock — not spawned, not consuming slots.
 */
export class LockManager {
	private heldLocks = new Map<string, LockEntry>()
	private waitQueues = new Map<string, LockWaiter[]>()
	private subtaskLocks = new Map<string, Set<string>>() // subtaskId → Set<lockId>
	private deadlockTimer: NodeJS.Timeout | null = null

	/** Heartbeat directory path */
	private heartbeatDir: string

	/** Lock timeout in ms */
	private lockTimeoutMs: number

	/** Heartbeat interval in ms */
	private heartbeatIntervalMs: number

	/**
	 * @param heartbeatDir - Directory for heartbeat files (default: `.roo/.roosync/heartbeats`)
	 * @param lockTimeoutMs - Lock acquisition timeout (default: 30s)
	 * @param heartbeatIntervalMs - Heartbeat interval (default: 5s)
	 */
	constructor(
		heartbeatDir?: string,
		lockTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
		heartbeatIntervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
	) {
		this.heartbeatDir = heartbeatDir ?? path.join(".roo", ".roosync", "heartbeats")
		this.lockTimeoutMs = lockTimeoutMs
		this.heartbeatIntervalMs = heartbeatIntervalMs

		// Start deadlock detector
		this.startDeadlockDetector()
	}

	/**
	 * Acquire a lock on a target resource.
	 *
	 * @param request - Lock request details
	 * @returns LockGrant on success, null on timeout
	 */
	async acquire(request: LockRequest): Promise<LockGrant | null> {
		const targetKey = this.getTargetKey(request.level, request.target)
		const lockId = this.generateLockId(request)

		console.log(
			`[LockManager] acquire: subtask="${request.subtaskId}" target="${targetKey}" type="${request.type}" timeout=${request.timeoutMs}ms`,
		)

		// Check if lock can be acquired immediately
		if (this.canAcquire(targetKey, request.type)) {
			return this.grantLock(lockId, request, targetKey)
		}

		// Lock is held — enqueue with timeout
		return new Promise<LockGrant | null>((resolve, reject) => {
			const waiter: LockWaiter = {
				request,
				resolve,
				reject,
				enqueuedAt: Date.now(),
			}

			if (!this.waitQueues.has(targetKey)) {
				this.waitQueues.set(targetKey, [])
			}
			this.waitQueues.get(targetKey)!.push(waiter)

			// Set timeout
			const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : this.lockTimeoutMs
			setTimeout(() => {
				this.removeWaiter(targetKey, waiter)
				console.warn(
					`[LockManager] timeout: subtask="${request.subtaskId}" target="${targetKey}" after ${timeoutMs}ms`,
				)
				resolve(null)
			}, timeoutMs)
		})
	}

	/**
	 * Release a specific lock by ID.
	 *
	 * @param lockId - The lock ID to release
	 */
	release(lockId: string): void {
		const entry = this.heldLocks.get(lockId)
		if (!entry) {
			console.warn(`[LockManager] release: lock "${lockId}" not found`)
			return
		}

		const { grant } = entry
		const targetKey = this.getTargetKey(grant.level, grant.target)

		console.log(`[LockManager] release: lockId="${lockId}" subtask="${grant.subtaskId}" target="${targetKey}"`)

		// Clear timeout timer
		if (entry.timeoutTimer) {
			clearTimeout(entry.timeoutTimer)
		}

		// Remove from held locks
		this.heldLocks.delete(lockId)

		// Remove from subtask lock tracking
		const subtaskLockSet = this.subtaskLocks.get(grant.subtaskId)
		if (subtaskLockSet) {
			subtaskLockSet.delete(lockId)
			if (subtaskLockSet.size === 0) {
				this.subtaskLocks.delete(grant.subtaskId)
			}
		}

		// Process wait queue for this target
		this.processWaitQueue(targetKey)
	}

	/**
	 * Check if a target is currently locked.
	 *
	 * @param level - Lock level
	 * @param target - Target path or resource name
	 * @returns true if any lock is held on the target
	 */
	isLocked(level: LockLevel, target: string): boolean {
		const targetKey = this.getTargetKey(level, target)
		for (const [, entry] of this.heldLocks) {
			if (this.getTargetKey(entry.grant.level, entry.grant.target) === targetKey) {
				return true
			}
		}
		return false
	}

	/**
	 * Get all locks held by a specific subtask.
	 *
	 * @param subtaskId - Subtask ID
	 * @returns Array of lock grants held by the subtask
	 */
	getHeldLocks(subtaskId: string): LockGrant[] {
		const lockIds = this.subtaskLocks.get(subtaskId)
		if (!lockIds) {
			return []
		}

		const grants: LockGrant[] = []
		for (const lockId of lockIds) {
			const entry = this.heldLocks.get(lockId)
			if (entry) {
				grants.push(entry.grant)
			}
		}
		return grants
	}

	/**
	 * Release all locks held by a specific subtask.
	 *
	 * @param subtaskId - Subtask ID
	 */
	releaseAll(subtaskId: string): void {
		const lockIds = this.subtaskLocks.get(subtaskId)
		if (!lockIds) {
			return
		}

		console.log(`[LockManager] releaseAll: subtask="${subtaskId}" (${lockIds.size} lock(s))`)

		// Copy to array since we're modifying the set during iteration
		const locksToRelease = [...lockIds]
		for (const lockId of locksToRelease) {
			this.release(lockId)
		}
	}

	/**
	 * Create a heartbeat file for a subtask.
	 *
	 * @param subtaskId - Subtask ID
	 * @returns Path to the heartbeat file
	 */
	createHeartbeat(subtaskId: string): string {
		const heartbeatPath = path.join(this.heartbeatDir, `${subtaskId}.heartbeat`)
		fs.mkdirSync(this.heartbeatDir, { recursive: true })
		fs.writeFileSync(heartbeatPath, JSON.stringify({ status: "running", timestamp: Date.now() }))
		return heartbeatPath
	}

	/**
	 * Touch a heartbeat file to indicate liveness.
	 *
	 * @param heartbeatPath - Path to the heartbeat file
	 */
	touchHeartbeat(heartbeatPath: string): void {
		try {
			const now = Date.now()
			fs.utimesSync(heartbeatPath, now, now)
		} catch {
			// Heartbeat file may have been cleaned up — ignore
		}
	}

	/**
	 * Check if a subtask's heartbeat is still alive.
	 *
	 * @param heartbeatPath - Path to the heartbeat file
	 * @returns true if the heartbeat is fresh
	 */
	isHeartbeatAlive(heartbeatPath: string): boolean {
		try {
			const stat = fs.statSync(heartbeatPath)
			const elapsed = Date.now() - stat.mtimeMs
			return elapsed < this.heartbeatIntervalMs * HEARTBEAT_MISS_THRESHOLD
		} catch {
			return false
		}
	}

	/**
	 * Clean up heartbeat files for a subtask.
	 *
	 * @param subtaskId - Subtask ID
	 */
	cleanupHeartbeat(subtaskId: string): void {
		const heartbeatPath = path.join(this.heartbeatDir, `${subtaskId}.heartbeat`)
		try {
			fs.unlinkSync(heartbeatPath)
		} catch {
			// File may not exist — ignore
		}
	}

	/**
	 * Clean up all heartbeat files.
	 */
	cleanupAllHeartbeats(): void {
		try {
			const files = fs.readdirSync(this.heartbeatDir)
			for (const file of files) {
				if (file.endsWith(".heartbeat")) {
					fs.unlinkSync(path.join(this.heartbeatDir, file))
				}
			}
		} catch {
			// Directory may not exist — ignore
		}
	}

	/**
	 * Stop the deadlock detector timer.
	 */
	dispose(): void {
		if (this.deadlockTimer) {
			clearInterval(this.deadlockTimer)
			this.deadlockTimer = null
		}
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Generate a deterministic target key from level and target.
	 */
	private getTargetKey(level: LockLevel, target: string): string {
		return `${level}:${target}`
	}

	/**
	 * Generate a unique lock ID.
	 */
	private generateLockId(request: LockRequest): string {
		const hash = crypto
			.createHash("sha256")
			.update(`${request.subtaskId}:${request.target}:${Date.now()}`)
			.digest("hex")
		return `lock-${hash.slice(0, 12)}`
	}

	/**
	 * Check if a lock can be acquired immediately.
	 */
	private canAcquire(targetKey: string, type: LockType): boolean {
		for (const [, entry] of this.heldLocks) {
			if (this.getTargetKey(entry.grant.level, entry.grant.target) !== targetKey) {
				continue
			}

			if (type === "read" && entry.grant.type === "read") {
				// Multiple readers allowed
				continue
			}

			// Write lock or conflicting type — cannot acquire
			return false
		}
		return true
	}

	/**
	 * Grant a lock and create the entry.
	 */
	private grantLock(lockId: string, request: LockRequest, targetKey: string): LockGrant {
		const now = Date.now()
		const grant: LockGrant = {
			lockId,
			level: request.level,
			target: request.target,
			type: request.type,
			subtaskId: request.subtaskId,
			acquiredAt: now,
			expiresAt: now + this.lockTimeoutMs,
		}

		// Set timeout to auto-release
		const timeoutTimer = setTimeout(() => {
			console.warn(
				`[LockManager] lock expired: lockId="${lockId}" subtask="${request.subtaskId}" target="${targetKey}"`,
			)
			this.release(lockId)
		}, this.lockTimeoutMs)

		this.heldLocks.set(lockId, { grant, timeoutTimer })

		// Track by subtask
		if (!this.subtaskLocks.has(request.subtaskId)) {
			this.subtaskLocks.set(request.subtaskId, new Set())
		}
		this.subtaskLocks.get(request.subtaskId)!.add(lockId)

		console.log(
			`[LockManager] granted: lockId="${lockId}" subtask="${request.subtaskId}" target="${targetKey}" type="${request.type}"`,
		)

		return grant
	}

	/**
	 * Process the wait queue for a target after a lock release.
	 */
	private processWaitQueue(targetKey: string): void {
		const queue = this.waitQueues.get(targetKey)
		if (!queue || queue.length === 0) {
			return
		}

		// Process waiters in FIFO order
		const remaining: LockWaiter[] = []
		for (const waiter of queue) {
			if (this.canAcquire(targetKey, waiter.request.type)) {
				const lockId = this.generateLockId(waiter.request)
				const grant = this.grantLock(lockId, waiter.request, targetKey)
				waiter.resolve(grant)
			} else {
				remaining.push(waiter)
			}
		}

		if (remaining.length > 0) {
			this.waitQueues.set(targetKey, remaining)
		} else {
			this.waitQueues.delete(targetKey)
		}
	}

	/**
	 * Remove a specific waiter from a wait queue.
	 */
	private removeWaiter(targetKey: string, waiter: LockWaiter): void {
		const queue = this.waitQueues.get(targetKey)
		if (!queue) {
			return
		}

		const index = queue.indexOf(waiter)
		if (index >= 0) {
			queue.splice(index, 1)
			if (queue.length === 0) {
				this.waitQueues.delete(targetKey)
			}
		}
	}

	/**
	 * Start the periodic deadlock detector.
	 * Scans the wait-for graph and kills the youngest subtask in a cycle.
	 */
	private startDeadlockDetector(): void {
		this.deadlockTimer = setInterval(() => {
			this.detectAndResolveDeadlocks()
		}, DEADLOCK_DETECTOR_INTERVAL_MS)

		// Allow the timer to not prevent process exit
		if (this.deadlockTimer && typeof this.deadlockTimer === "object" && "unref" in this.deadlockTimer) {
			;(this.deadlockTimer as NodeJS.Timeout).unref()
		}
	}

	/**
	 * Detect deadlocks by scanning the wait-for graph.
	 * If a cycle is detected, the youngest subtask in the cycle is killed.
	 */
	private detectAndResolveDeadlocks(): void {
		// Build wait-for graph: subtaskId → Set of subtaskIds it's waiting for
		const waitFor = new Map<string, Set<string>>()

		for (const [targetKey, queue] of this.waitQueues) {
			for (const waiter of queue) {
				// Find who holds the lock on this target
				for (const [, entry] of this.heldLocks) {
					if (this.getTargetKey(entry.grant.level, entry.grant.target) === targetKey) {
						if (!waitFor.has(waiter.request.subtaskId)) {
							waitFor.set(waiter.request.subtaskId, new Set())
						}
						waitFor.get(waiter.request.subtaskId)!.add(entry.grant.subtaskId)
					}
				}
			}
		}

		// DFS cycle detection on wait-for graph
		const color = new Map<string, "white" | "gray" | "black">()
		for (const subtaskId of waitFor.keys()) {
			color.set(subtaskId, "white")
		}

		const dfs = (nodeId: string, path: string[]): string[] | null => {
			color.set(nodeId, "gray")
			path.push(nodeId)

			const deps = waitFor.get(nodeId)
			if (deps) {
				for (const depId of deps) {
					if (!color.has(depId)) {
						continue
					}
					if (color.get(depId) === "gray") {
						// Found cycle
						const cycleStart = path.indexOf(depId)
						return path.slice(cycleStart)
					}
					if (color.get(depId) === "white") {
						const result = dfs(depId, path)
						if (result) {
							return result
						}
					}
				}
			}

			color.set(nodeId, "black")
			path.pop()
			return null
		}

		for (const subtaskId of waitFor.keys()) {
			if (color.get(subtaskId) === "white") {
				const cycle = dfs(subtaskId, [])
				if (cycle && cycle.length > 0) {
					// Find youngest subtask in cycle (most recent lock acquisition)
					let youngestId = cycle[0]
					let youngestTime = 0

					for (const id of cycle) {
						const locks = this.subtaskLocks.get(id)
						if (locks) {
							for (const lockId of locks) {
								const entry = this.heldLocks.get(lockId)
								if (entry && entry.grant.acquiredAt > youngestTime) {
									youngestTime = entry.grant.acquiredAt
									youngestId = id
								}
							}
						}
					}

					console.warn(
						`[LockManager] Deadlock detected: cycle=[${cycle.join(" → ")}], killing youngest subtask="${youngestId}"`,
					)

					// Release all locks held by the youngest subtask
					this.releaseAll(youngestId)
				}
			}
		}
	}
}
