import { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type WebFetchParams = NativeToolArgs["web_fetch"]

/**
 * WebFetchTool — Fetch a URL and return its content
 *
 * Uses Cloak browser with stealth protection for anti-bot evasion.
 * Supports text extraction, full HTML, or screenshot capture.
 *
 * NOTE: cloakbrowser/playwright-core are dynamically imported at execution time
 * because the VSIX is packaged with --no-dependencies and these modules are
 * externalized from the esbuild bundle. A static top-level import would crash
 * extension activation.
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

		try {
			// Dynamic import: cloakbrowser lazily resolved so extension can activate
			// without it installed. Users must separately ensure the dep exists.
			const { launch } = await import("cloakbrowser" as string)
			const browser = await launch({
				headless: true,
				humanize: true,
			})

			try {
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

				pushToolResult(
					`[web_fetch] Fetched ${params.url} (mode: ${extractMode})\n\n${content.slice(0, 100_000)}`,
				)
			} finally {
				await browser.close().catch(() => {})
			}
		} catch (error) {
			await handleError(`fetching ${params.url}`, error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const webFetchTool = new WebFetchTool()