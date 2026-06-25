import type { Page } from "playwright-core"

import { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type BrowserParams = NativeToolArgs["browser"]

/**
 * BrowserTool — Interact with a web browser using Cloak browser.
 *
 * Supports navigate, click, type, snapshot, scroll, press, evaluate, screenshot.
 *
 * NOTE: cloakbrowser/playwright-core are dynamically imported at execution time
 * because the VSIX is packaged with --no-dependencies and these modules are
 * externalized from the esbuild bundle. A static top-level import would crash
 * extension activation.
 */
export class BrowserTool extends BaseTool<"browser"> {
	readonly name = "browser" as const
	private browserInstance: any = null
	private page: Page | null = null

	async execute(params: BrowserParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		if (!params.action) {
			task.consecutiveMistakeCount++
			task.recordToolError("browser")
			pushToolResult("Error: action is required")
			return
		}

		try {
			switch (params.action) {
				case "navigate":
					await this.navigate(params, pushToolResult)
					break
				case "click":
					await this.click(params, pushToolResult)
					break
				case "type":
					await this.typeText(params, pushToolResult)
					break
				case "snapshot":
					await this.snapshot(pushToolResult)
					break
				case "scroll":
					await this.scroll(params, pushToolResult)
					break
				case "press":
					await this.press(params, pushToolResult)
					break
				case "evaluate":
					await this.evaluate(params, pushToolResult)
					break
				case "screenshot":
					await this.screenshot(pushToolResult)
					break
				case "close":
					await this.closeBrowser(pushToolResult)
					break
				case "back":
					await this.goBack(pushToolResult)
					break
				case "forward":
					await this.goForward(pushToolResult)
					break
				case "hover":
					await this.hover(params, pushToolResult)
					break
				case "waitForSelector":
					await this.waitForSelector(params, pushToolResult)
					break
			}
		} catch (error) {
			await handleError(`browser ${params.action}`, error instanceof Error ? error : new Error(String(error)))
		}
	}

	private async ensureBrowser(): Promise<Page> {
		if (this.page) return this.page
		const { launch } = await import("cloakbrowser" as string)
		this.browserInstance = await launch({
			headless: true,
			humanize: true,
		})
		this.page = await this.browserInstance.newPage()
		return this.page!
	}

	private async navigate(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.url) {
			pushToolResult("Error: url is required for navigate")
			return
		}
		const page = await this.ensureBrowser()
		await page.goto(params.url, { waitUntil: "networkidle", timeout: 30_000 })
		const title = await page.title()
		const text = await page.evaluate(() => document.body.innerText)
		const truncated = text.length > 5000 ? "\n\n_(content truncated, use snapshot for interactive elements)_" : ""
		pushToolResult(`**Navigated to:** ${params.url}\n**Title:** ${title}\n\n${text.substring(0, 5000)}${truncated}`)
	}

	private async click(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.selector) {
			pushToolResult("Error: selector is required for click")
			return
		}
		const page = await this.ensureBrowser()
		await page.click(params.selector)
		await new Promise((r) => setTimeout(r, 1000))
		pushToolResult(`Clicked: ${params.selector}`)
	}

	private async typeText(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.selector || !params.text) {
			pushToolResult("Error: selector and text are required for type")
			return
		}
		const page = await this.ensureBrowser()
		await page.fill(params.selector, params.text)
		pushToolResult(`Typed into: ${params.selector}`)
	}

	private async snapshot(pushToolResult: (content: string) => void): Promise<void> {
		const page = await this.ensureBrowser()
		const title = await page.title()
		const url = page.url()

		const elements = await page.evaluate(() => {
			const tags = ["a", "button", "input", "textarea", "select", "[tabindex]", "[role=button]", "[role=link]"]
			const items: Array<{ tag: string; text: string; href?: string; type?: string; placeholder?: string }> = []
			const seen = new Set<string>()
			for (const tag of tags) {
				const els = document.querySelectorAll(tag)
				els.forEach((el, i) => {
					const key = tag + "-" + i
					if (seen.has(key)) return
					seen.add(key)
					const a = el as HTMLElement
					items.push({
						tag: el.tagName.toLowerCase(),
						text: (a.textContent || "").trim().substring(0, 80),
						href: (el as HTMLAnchorElement).href,
						type: (el as HTMLInputElement).type,
						placeholder: (el as HTMLInputElement).placeholder,
					})
				})
			}
			return items
		})

		const formatted = elements
			.map((e, i) => {
				let s = `[${i + 1}] <${e.tag}>`
				if (e.text) s += " " + e.text
				if (e.href) s += " -> " + e.href
				if (e.type) s += " type=" + e.type
				if (e.placeholder) s += ' placeholder="' + e.placeholder + '"'
				return s
			})
			.join("\n")

		pushToolResult(
			`**Page:** ${title}\n**URL:** ${url}\n**Interactive elements (${elements.length}):**\n\n${formatted.substring(0, 8000)}`,
		)
	}

	private async scroll(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.direction) {
			pushToolResult("Error: direction is required for scroll (up/down)")
			return
		}
		const page = await this.ensureBrowser()
		await page.evaluate((dir: string) => {
			const amount = window.innerHeight * 0.8
			window.scrollBy(0, dir === "down" ? amount : -amount)
		}, params.direction)
		await new Promise((r) => setTimeout(r, 500))
		pushToolResult(`Scrolled ${params.direction}`)
	}

	private async press(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.key) {
			pushToolResult("Error: key is required for press")
			return
		}
		const page = await this.ensureBrowser()
		await page.keyboard.press(params.key)
		pushToolResult(`Pressed: ${params.key}`)
	}

	private async evaluate(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.text) {
			pushToolResult("Error: text (JavaScript code) is required for evaluate")
			return
		}
		const page = await this.ensureBrowser()
		const result = await page.evaluate((code: string) => {
			try {
				return JSON.stringify(eval(code), null, 2)
			} catch (e: any) {
				return "Error: " + e.message
			}
		}, params.text)
		pushToolResult(`**Result:**\n\n${result}`)
	}

	private async screenshot(pushToolResult: (content: string) => void): Promise<void> {
		const page = await this.ensureBrowser()
		const buffer = await page.screenshot({ type: "png", fullPage: true })
		const b64 = buffer.toString("base64")
		pushToolResult(`data:image/png;base64,${b64}`)
	}

	private async closeBrowser(pushToolResult: (content: string) => void): Promise<void> {
		if (this.browserInstance) {
			await this.browserInstance.close().catch(() => {})
			this.browserInstance = null
			this.page = null
			pushToolResult("Browser closed.")
		} else {
			pushToolResult("No browser session to close.")
		}
	}

	private async goBack(pushToolResult: (content: string) => void): Promise<void> {
		const page = await this.ensureBrowser()
		await page.goBack({ waitUntil: "networkidle" })
		pushToolResult("Navigated back.")
	}

	private async goForward(pushToolResult: (content: string) => void): Promise<void> {
		const page = await this.ensureBrowser()
		await page.goForward({ waitUntil: "networkidle" })
		pushToolResult("Navigated forward.")
	}

	private async hover(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.selector) {
			pushToolResult("Error: selector is required for hover")
			return
		}
		const page = await this.ensureBrowser()
		await page.hover(params.selector)
		pushToolResult(`Hovered: ${params.selector}`)
	}

	private async waitForSelector(params: BrowserParams, pushToolResult: (content: string) => void): Promise<void> {
		if (!params.selector) {
			pushToolResult("Error: selector is required for waitForSelector")
			return
		}
		const page = await this.ensureBrowser()
		await page.waitForSelector(params.selector, { timeout: params.timeout || 30000 })
		pushToolResult(`Selector appeared: ${params.selector}`)
	}
}

export const browserTool = new BrowserTool()
