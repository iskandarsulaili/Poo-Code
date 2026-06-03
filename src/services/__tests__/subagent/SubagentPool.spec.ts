// Run: cd Zoo-Code/src && pnpm vitest run services/__tests__/subagent/SubagentPool.spec.ts

import { SubagentPool } from "../../subagent/SubagentPool"
import { PoolExhaustedError } from "../../subagent/types"

describe("SubagentPool", () => {
	describe("acquire", () => {
		it("should return a slot immediately when available", async () => {
			const pool = new SubagentPool({ maxSize: 3 })
			const slot = await pool.acquire()

			expect(slot).toBeDefined()
			expect(slot.id).toBeDefined()
			expect(typeof slot.id).toBe("string")
			expect(pool.getActiveCount()).toBe(1)
		})

		it("should wait when pool is full until a slot is released", async () => {
			const pool = new SubagentPool({ maxSize: 1 })
			const slot1 = await pool.acquire()

			let acquired = false
			const acquirePromise = pool.acquire().then((slot) => {
				acquired = true
				return slot
			})

			// Should not resolve yet since pool is full
			await expect(
				Promise.race([acquirePromise, new Promise<undefined>((r) => setTimeout(() => r(undefined), 100))]),
			).resolves.toBeUndefined()
			expect(acquired).toBe(false)

			// Release a slot — the waiter should acquire it
			pool.release(slot1)
			const slot2 = await acquirePromise
			expect(slot2).toBeDefined()
			pool.release(slot2)
		})
	})

	describe("release", () => {
		it("should increase available slots when a slot is released (and no waiters)", async () => {
			const pool = new SubagentPool({ maxSize: 3 })
			expect(pool.getAvailableSlots()).toBe(3)

			const slot = await pool.acquire()
			expect(pool.getAvailableSlots()).toBe(2)

			pool.release(slot)
			expect(pool.getAvailableSlots()).toBe(3)
		})

		it("should throw when releasing a slot not acquired from this pool", () => {
			const pool = new SubagentPool({ maxSize: 3 })
			const fakeSlot = { id: "fake-id", slotIndex: 0, acquiredAt: 0 }
			expect(() => pool.release(fakeSlot)).toThrow()
		})
	})

	describe("max pool size", () => {
		it("should default to 3", () => {
			const pool = new SubagentPool()
			expect(pool.getMaxSize()).toBe(3)
		})

		it("should throw RangeError when maxSize is less than 1", () => {
			expect(() => new SubagentPool({ maxSize: 0 })).toThrow(RangeError)
			expect(() => new SubagentPool({ maxSize: -1 })).toThrow(RangeError)
		})
	})

	describe("concurrent acquires", () => {
		it("should queue extra acquires beyond maxSize", async () => {
			const pool = new SubagentPool({ maxSize: 3 })
			const slots = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()])

			expect(slots).toHaveLength(3)
			expect(pool.getActiveCount()).toBe(3)
			expect(pool.getAvailableSlots()).toBe(0)
			expect(pool.getQueueLength()).toBe(0)

			// A 4th acquire should queue
			const fourthAcquire = pool.acquire()
			expect(pool.getQueueLength()).toBe(1)

			// Release one — the queued acquire gets fulfilled immediately
			pool.release(slots[0])
			const slot4 = await fourthAcquire
			expect(slot4).toBeDefined()
			expect(pool.getActiveCount()).toBe(3) // 2 active + 1 new from queue

			// Release remaining
			pool.release(slots[1])
			pool.release(slots[2])
			pool.release(slot4)
			expect(pool.getActiveCount()).toBe(0)
		})
	})

	describe("dispose", () => {
		it("should reject pending acquires after disposal", async () => {
			const pool = new SubagentPool({ maxSize: 1 })
			await pool.acquire()

			const acquirePromise = pool.acquire()
			pool.dispose()

			await expect(acquirePromise).rejects.toThrow(PoolExhaustedError)
		})

		it("should reject future acquires after disposal", async () => {
			const pool = new SubagentPool({ maxSize: 3 })
			pool.dispose()
			await expect(pool.acquire()).rejects.toThrow(PoolExhaustedError)
		})
	})
})
