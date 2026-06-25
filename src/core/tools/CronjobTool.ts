import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "../../shared/tools"
import { CronScheduler } from "../../services/cron/CronScheduler"

type CronjobParams = NativeToolArgs["cronjob"]

export class CronjobTool extends BaseTool<"cronjob"> {
	readonly name = "cronjob" as const

	async execute(params: CronjobParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		try {
			const scheduler = CronScheduler.getInstance()

			switch (params.action) {
				case "create": {
					if (!params.schedule || !params.prompt) {
						pushToolResult("Error: schedule and prompt are required for create")
						return
					}
					const job = await scheduler.createJob({
						schedule: params.schedule,
						prompt: params.prompt,
						name: params.name,
					})
					pushToolResult(`Cron job created: ${job.id} (${job.name || "unnamed"})`)
					break
				}
				case "list": {
					const jobs = await scheduler.listJobs()
					if (jobs.length === 0) {
						pushToolResult("No cron jobs configured.")
						return
					}
					const formatted = jobs
						.map(
							(j) =>
								`- ${j.id}: ${j.name || "unnamed"} | schedule: ${j.schedule} | status: ${j.paused ? "paused" : "active"}`,
						)
						.join("\n")
					pushToolResult(`Cron jobs (${jobs.length}):\n${formatted}`)
					break
				}
				case "update": {
					if (!params.job_id) {
						pushToolResult("Error: job_id is required for update")
						return
					}
					await scheduler.updateJob(params.job_id, {
						schedule: params.schedule,
						prompt: params.prompt,
						name: params.name,
					})
					pushToolResult(`Cron job ${params.job_id} updated.`)
					break
				}
				case "pause": {
					if (!params.job_id) {
						pushToolResult("Error: job_id required")
						return
					}
					await scheduler.pauseJob(params.job_id)
					pushToolResult(`Cron job ${params.job_id} paused.`)
					break
				}
				case "resume": {
					if (!params.job_id) {
						pushToolResult("Error: job_id required")
						return
					}
					await scheduler.resumeJob(params.job_id)
					pushToolResult(`Cron job ${params.job_id} resumed.`)
					break
				}
				case "remove": {
					if (!params.job_id) {
						pushToolResult("Error: job_id required")
						return
					}
					await scheduler.removeJob(params.job_id)
					pushToolResult(`Cron job ${params.job_id} removed.`)
					break
				}
				case "run": {
					if (!params.job_id) {
						pushToolResult("Error: job_id required")
						return
					}
					const result = await scheduler.runJob(params.job_id)
					pushToolResult(`Cron job ${params.job_id} executed.\n${result}`)
					break
				}
			}
		} catch (error) {
			await handleError("managing cron job", error as Error)
		}
	}
}

export const cronjobTool = new CronjobTool()
