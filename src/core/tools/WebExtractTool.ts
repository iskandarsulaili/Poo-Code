import type { ElementHandle, Page } from "playwright-core"
import { launch } from "cloakbrowser"

import { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type WebExtractParams = NativeToolArgs["web_extract"]

/**
 * WebExtractTool — Extract structured data from a URL
 *
 * Uses Cloak browser to navigate to a URL, apply CSS selectors,
 * and return structured JSON data.
 */
export class WebExtractTool extends BaseTool<"web_extract"> {
	readonly name = "web_extract" as const

	async execute(params: WebExtractParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		if (!params.url) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_extract")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("web_extract", "url"))
			return
		}

		if (!params.selectors || params.selectors.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_extract")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("web_extract", "selectors"))
			return
		}

		const extractAll = params.extractAll ?? false
		const timeout = 30_000
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

			// Wait a moment for dynamic content
			await new Promise((resolve) => setTimeout(resolve, 1000))

			const result = await extractData(page, params.selectors, extractAll)

			await browser.close()
			browser = null

			const resultJson = JSON.stringify(result, null, 2)
			pushToolResult(`[web_extract] Extracted data from ${params.url}\n\n${resultJson}`)
		} catch (error) {
			if (browser) {
				try {
					await browser.close()
				} catch {
					// Best-effort cleanup
				}
			}
			await handleError(`extracting from ${params.url}`, error instanceof Error ? error : new Error(String(error)))
		}
	}
}

async function extractTextFromElement(el: ElementHandle): Promise<string> {
	return el.evaluate((node: HTMLElement) => node.textContent || "")
}

async function extractAttributeFromElement(el: ElementHandle, attr: string): Promise<string | null> {
	return el.evaluate(
		(node: HTMLElement, attributeName: string) => node.getAttribute(attributeName),
		attr,
	)
}

async function extractData(
	page: Page,
	selectors: Array<{ name: string; selector: string; attribute?: string }>,
	extractAll: boolean,
): Promise<Record<string, unknown>> {
	const result: Record<string, unknown> = {}

	for (const sel of selectors) {
		if (extractAll) {
			const elements = await page.$$(sel.selector)
			const values: (string | null)[] = []
			for (const el of elements) {
				if (sel.attribute) {
					values.push(await extractAttributeFromElement(el, sel.attribute))
				} else {
					values.push(await extractTextFromElement(el))
				}
			}
			result[sel.name] = values
		} else {
			const el = await page.$(sel.selector)
			if (el) {
				if (sel.attribute) {
					result[sel.name] = await extractAttributeFromElement(el, sel.attribute)
				} else {
					result[sel.name] = await extractTextFromElement(el).then((t) => t.trim() || null)
				}
			} else {
				result[sel.name] = null
			}
		}
	}

	return result
}

export const webExtractTool = new WebExtractTool()