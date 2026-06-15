import { launch } from "cloakbrowser"

import { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type WebFetchParams = NativeToolArgs["web_fetch"]

/**
 * WebFetchTool — Fetch a URL and return its content
 *
 * Uses Cloak browser with stealth protection for anti-bot evasion.
 * Supports text extraction, full HTML, or screenshot capture.
 */
export class WebFetchTool extends BaseTool<"web_fetch"> {
	readonly name = "web_fetch" as const

	async execute(params: WebFetchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		if (!params.url) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_fetch")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("web_fetch", "url"))
			return
		}

		const extractMode = params.extractMode ?? "text"
		const timeout = params.timeout ?? 30_000
		let browser: Awaited<ReturnType<typeof launch>> | null = null

		try {
			browser = await launch({
				headless: true,
				humanize: true,
			})

			const page = await browser.newPage()
			await page.goto(params.url, { waitUntil: "networkidle", timeout })

			if (params.waitForSelector) {
				await page.waitForSelector(params.waitForSelector, { timeout })
			}

			let content: string

			switch (extractMode) {
				case "html":
					content = await page.content()
					break
				case "screenshot": {
					const screenshotBuffer = await page.screenshot({ type: "png", fullPage: true })
					content = `data:image/png;base64,${screenshotBuffer.toString("base64")}`
					break
				}
				case "text":
				default:
					content = await page.evaluate(() => document.body.innerText)
					break
			}

			await browser.close()
			browser = null

			pushToolResult(
				`[web_fetch] Fetched ${params.url} (mode: ${extractMode})\n\n${content.slice(0, 100_000)}`,
			)
		} catch (error) {
			if (browser) {
				try {
					await browser.close()
				} catch {
					// Best-effort cleanup
				}
			}
			await handleError(`fetching ${params.url}`, error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const webFetchTool = new WebFetchTool()