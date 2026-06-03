import crypto from "crypto"
import type { PoolSlot } from "./types"
import { PoolExhaustedError, DEFAULT_POOL_SIZE } from "./types"

/**
 * A queue item representing a pending acquire request.
 * Resolved when a slot becomes available or rejected on pool disposal.
 */
interface AcquireRequest {
	resolve: (slot: PoolSlot) => void
	reject: (error: Error) => void
}

/**
 * SubagentPool — concurrent pool manager using a semaphore-like pattern.
 *
 * Controls how many subagents can run simultaneously. When all slots are busy,
 * callers wait in a FIFO queue until a slot is released.
 *
 * @example
 * ```ts
 * const pool = new SubagentPool({ maxSize: 3 })
 * const slot = await pool.acquire()
 * try {
 *   // execute subagent work ...
 * } finally {
 *   pool.release(slot)
 * }
 * ```
 */
export class SubagentPool {
	private readonly maxSize: number
	private activeCount = 0
	private disposed = false
	private readonly queue: AcquireRequest[] = []
	private readonly acquiredSlots = new Set<string>()

	/**
	 * @param options.maxSize - Maximum concurrent subagents (default: 3)
	 */
	constructor(options: { maxSize?: number } = {}) {
		this.maxSize = options.maxSize ?? DEFAULT_POOL_SIZE

		if (this.maxSize < 1) {
			throw new RangeError("SubagentPool maxSize must be at least 1")
		}
	}

	/**
	 * Acquire a pool slot. If all slots are busy, the caller's promise will
	 * wait in a FIFO queue until a slot is released.
	 *
	 * If the pool has been disposed, the returned promise rejects immediately.
	 */
	async acquire(): Promise<PoolSlot> {
		if (this.disposed) {
			throw new PoolExhaustedError(this.maxSize)
		}

		if (this.activeCount < this.maxSize) {
			return this.createSlot()
		}

		// All slots busy — queue this request
		return new Promise<PoolSlot>((resolve, reject) => {
			this.queue.push({ resolve, reject })
		})
	}

	/**
	 * Release a previously acquired slot back to the pool.
	 * If there are pending acquire requests, the next one is immediately
	 * resolved with the freed slot.
	 *
	 * @throws Error if the slot was not acquired from this pool or was already released.
	 */
	release(slot: PoolSlot): void {
		if (!this.acquiredSlots.has(slot.id)) {
			throw new Error(`Slot ${slot.id} was not acquired from this pool or has already been released`)
		}

		this.acquiredSlots.delete(slot.id)
		this.activeCount--

		// Fulfill the next waiting request if any
		const next = this.queue.shift()
		if (next) {
			const newSlot = this.createSlot()
			next.resolve(newSlot)
		}
	}

	/**
	 * Returns the number of currently available (free) slots.
	 */
	getAvailableSlots(): number {
		return Math.max(0, this.maxSize - this.activeCount)
	}

	/**
	 * Returns the number of currently active (acquired) slots.
	 */
	getActiveCount(): number {
		return this.activeCount
	}

	/**
	 * Returns the maximum pool size.
	 */
	getMaxSize(): number {
		return this.maxSize
	}

	/**
	 * Returns the number of requests waiting in the acquisition queue.
	 */
	getQueueLength(): number {
		return this.queue.length
	}

	/**
	 * Dispose the pool. All pending acquire requests are rejected, and the
	 * pool can no longer be used. Existing active slots remain valid but
	 * no new slots can be acquired.
	 */
	dispose(): void {
		this.disposed = true

		// Reject all pending requests
		const pending = this.queue.splice(0)
		const error = new PoolExhaustedError(this.maxSize)
		for (const req of pending) {
			req.reject(error)
		}
	}

	/**
	 * Create a new pool slot and track it.
	 */
	private createSlot(): PoolSlot {
		const slot: PoolSlot = {
			id: crypto.randomUUID(),
			slotIndex: this.activeCount,
			acquiredAt: Date.now(),
		}
		this.acquiredSlots.add(slot.id)
		this.activeCount++
		return slot
	}
}
