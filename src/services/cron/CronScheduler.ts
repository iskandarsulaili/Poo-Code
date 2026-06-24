import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import crypto from "crypto"

export interface CronJob {
	id: string
	name?: string
	schedule: string
	prompt: string
	paused: boolean
	createdAt: number
	lastRunAt?: number
}

/**
 * Simple cron scheduler that persists jobs to disk and runs them on interval.
 * Supports duration-based schedules ("30m", "2h", "90s") and ISO timestamps.
 * For production use, integrate with systemd timers or an external scheduler.
 */
export class CronScheduler {
	private static instance: CronScheduler
	private jobs: Map<string, CronJob> = new Map()
	private timers: Map<string, NodeJS.Timeout> = new Map()
	private storagePath: string
	private initialized = false

	private constructor() {
		this.storagePath = path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".roo"), "cron", "jobs.json")
	}

	static getInstance(): CronScheduler {
		if (!CronScheduler.instance) {
			CronScheduler.instance = new CronScheduler()
		}
		return CronScheduler.instance
	}

	async initialize(): Promise<void> {
		if (this.initialized) return
		try {
			const data = await fs.readFile(this.storagePath, "utf-8")
			const jobs: CronJob[] = JSON.parse(data)
			for (const job of jobs) {
				this.jobs.set(job.id, job)
				if (!job.paused) this.scheduleTimer(job)
			}
		} catch {
			// No existing jobs
		}
		this.initialized = true
	}

	private async persist(): Promise<void> {
		await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
		await fs.writeFile(this.storagePath, JSON.stringify(Array.from(this.jobs.values()), null, 2))
	}

	async createJob(params: { schedule: string; prompt: string; name?: string }): Promise<CronJob> {
		const job: CronJob = {
			id: crypto.randomUUID().slice(0, 8),
			name: params.name,
			schedule: params.schedule,
			prompt: params.prompt,
			paused: false,
			createdAt: Date.now(),
		}
		this.jobs.set(job.id, job)
		await this.persist()
		this.scheduleTimer(job)
		return job
	}

	async listJobs(): Promise<CronJob[]> {
		return Array.from(this.jobs.values())
	}

	async updateJob(id: string, params: Partial<CronJob>): Promise<void> {
		const job = this.jobs.get(id)
		if (!job) throw new Error(`Cron job ${id} not found`)
		Object.assign(job, params)
		await this.persist()
		this.clearTimer(id)
		if (!job.paused) this.scheduleTimer(job)
	}

	async pauseJob(id: string): Promise<void> {
		const job = this.jobs.get(id)
		if (!job) throw new Error(`Cron job ${id} not found`)
		job.paused = true
		this.clearTimer(id)
		await this.persist()
	}

	async resumeJob(id: string): Promise<void> {
		const job = this.jobs.get(id)
		if (!job) throw new Error(`Cron job ${id} not found`)
		job.paused = false
		await this.persist()
		this.scheduleTimer(job)
	}

	async removeJob(id: string): Promise<void> {
		this.jobs.delete(id)
		this.clearTimer(id)
		await this.persist()
	}

	async runJob(id: string): Promise<string> {
		const job = this.jobs.get(id)
		if (!job) throw new Error(`Cron job ${id} not found`)
		job.lastRunAt = Date.now()
		await this.persist()
		return `Job "${job.name || job.id}" triggered. Prompt: ${job.prompt.substring(0, 100)}...`
	}

	private scheduleTimer(job: CronJob): void {
		if (job.paused) return
		const intervalMs = this.parseSchedule(job.schedule)
		if (intervalMs <= 0) return
		const timer = setInterval(() => {
			this.runJob(job.id).catch((err) => console.error(`[CronScheduler] Job ${job.id} failed:`, err))
		}, intervalMs)
		timer.unref()
		this.timers.set(job.id, timer)
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id)
		if (timer) {
			clearInterval(timer)
			this.timers.delete(id)
		}
	}

	private parseSchedule(schedule: string): number {
		// Duration format: "30m", "2h", "90s"
		const durationMatch = schedule.match(/^(\d+)\s*(s|m|h)$/)
		if (durationMatch) {
			const num = parseInt(durationMatch[1], 10)
			const unit = durationMatch[2]
			switch (unit) {
				case "s":
					return num * 1000
				case "m":
					return num * 60 * 1000
				case "h":
					return num * 3600 * 1000
			}
		}
		// "every" phrase: "every 2h", "every 30m", "every monday 9am"
		const everyMatch = schedule.match(/^every\s+(\d+)\s*(s|m|h)$/i)
		if (everyMatch) {
			const num = parseInt(everyMatch[1], 10)
			const unit = everyMatch[2].toLowerCase()
			switch (unit) {
				case "s":
					return num * 1000
				case "m":
					return num * 60 * 1000
				case "h":
					return num * 3600 * 1000
			}
		}
		// ISO timestamp: run once at that time
		const ts = Date.parse(schedule)
		if (!isNaN(ts)) {
			const delay = ts - Date.now()
			return delay > 0 ? delay : 0
		}
		// Default: 1 hour
		return 3600000
	}

	dispose(): void {
		for (const [id, timer] of this.timers) {
			clearInterval(timer)
		}
		this.timers.clear()
	}
}

export default CronScheduler
