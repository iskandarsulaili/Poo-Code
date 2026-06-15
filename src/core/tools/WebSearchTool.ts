import type { Page } from "playwright-core"
import { launch } from "cloakbrowser"

import { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type WebSearchParams = NativeToolArgs["web_search"]

/**
 * WebSearchTool — Search the web using a search engine
 *
 * Uses Cloak browser to navigate to a search engine, perform the query,
 * and extract result links/titles/snippets.
 */
export class WebSearchTool extends BaseTool<"web_search"> {
	readonly name = "web_search" as const

	async execute(params: WebSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		if (!params.query) {
			task.consecutiveMistakeCount++
			task.recordToolError("web_search")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("web_search", "query"))
			return
		}

		const count = Math.min(params.count ?? 10, 20)
		const engine = params.engine ?? "google"
		let browser: Awaited<ReturnType<typeof launch>> | null = null

		try {
			browser = await launch({
				headless: true,
				humanize: true,
			})

			const page = await browser.newPage()
			const searchUrl = buildSearchUrl(engine, params.query)
			await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30_000 })

			// Wait a moment for results to render
			await new Promise((resolve) => setTimeout(resolve, 2000))

			const results = await extractResults(page, engine, count)

			await browser.close()
			browser = null

			const resultText = results
				.map(
					(r, i) =>
						`${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet ?? ""}`,
				)
				.join("\n\n")

			pushToolResult(
				`[web_search] Results for "${params.query}" (${engine})\n\n${resultText}`,
			)
		} catch (error) {
			if (browser) {
				try {
					await browser.close()
				} catch {
					// Best-effort cleanup
				}
			}
			await handleError(`searching for "${params.query}"`, error instanceof Error ? error : new Error(String(error)))
		}
	}
}

interface SearchResult {
	title: string
	url: string
	snippet?: string
}

function buildSearchUrl(engine: string, query: string): string {
	const encoded = encodeURIComponent(query)
	switch (engine) {
		case "bing":
			return `https://www.bing.com/search?q=${encoded}`
		case "duckduckgo":
			return `https://duckduckgo.com/?q=${encoded}`
		case "google":
		default:
			return `https://www.google.com/search?q=${encoded}`
	}
}

async function extractResults(page: Page, engine: string, count: number): Promise<SearchResult[]> {
	const results: SearchResult[] = []

	switch (engine) {
		case "google": {
			const items = await page.$$("div.g")
			for (const item of items.slice(0, count)) {
				try {
					const titleEl = await item.$("h3")
					const linkEl = await item.$("a")
					const snippetEl = await item.$("div[data-sncf], div.VwiC3b, span.aCOpRe")
					const title = titleEl ? await page.evaluate((el) => el.textContent || "", titleEl) : ""
					const url = linkEl ? await page.evaluate((el) => (el as HTMLAnchorElement).href || "", linkEl) : ""
					const snippet = snippetEl
						? await page.evaluate((el) => el.textContent || "", snippetEl)
						: ""
					if (title && url) {
						results.push({ title, url, snippet })
					}
				} catch {
					// Skip malformed results
				}
			}
			break
		}
		case "bing": {
			const items = await page.$$("li.b_algo")
			for (const item of items.slice(0, count)) {
				try {
					const titleEl = await item.$("h2 a")
					const snippetEl = await item.$("p.b_lineclamp2, div.b_caption p")
					const title = titleEl ? await page.evaluate((el) => el.textContent || "", titleEl) : ""
					const url = titleEl ? await page.evaluate((el) => (el as HTMLAnchorElement).href || "", titleEl) : ""
					const snippet = snippetEl
						? await page.evaluate((el) => el.textContent || "", snippetEl)
						: ""
					if (title && url) {
						results.push({ title, url, snippet })
					}
				} catch {
					// Skip malformed results
				}
			}
			break
		}
		case "duckduckgo": {
			const items = await page.$$("article[data-testid='result'], li[data-layout='organic']")
			for (const item of items.slice(0, count)) {
				try {
					const titleEl = await item.$("h2 a")
					const snippetEl = await item.$("span[data-testid='result-snippet']")
					const title = titleEl ? await page.evaluate((el) => el.textContent || "", titleEl) : ""
					const url = titleEl ? await page.evaluate((el) => (el as HTMLAnchorElement).href || "", titleEl) : ""
					const snippet = snippetEl
						? await page.evaluate((el) => el.textContent || "", snippetEl)
						: ""
					if (title && url) {
						results.push({ title, url, snippet })
					}
				} catch {
					// Skip malformed results
				}
			}
			break
		}
	}

	return results
}

export const webSearchTool = new WebSearchTool()