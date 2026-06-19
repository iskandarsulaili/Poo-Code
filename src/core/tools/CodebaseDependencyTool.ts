/**
 * Tool for querying the codebase dependency graph.
 * Fixes 3, 5, 6: result limiting, exact path match, sensitivity filtering.
 */
import * as vscode from "vscode"
import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { CodebaseMappingManager } from "../../services/codebase-mapping"

interface CodebaseDependencyParams {
	action: "reverse_deps" | "forward_deps" | "file_info" | "dead_symbols" | "module_map" | "cycles"
	target: string | null
	module: string | null
	limit?: number | null  // Fix 3: Optional result limit
}

// Fix 6: Paths to exclude from dependency output (config, generated, vendor)
const SENSITIVE_PATH_PATTERNS = [
	"/node_modules/", "/.git/", "/dist/", "/build/", "/.next/",
	"/coverage/", "/.vscode/", "/__pycache__/", "/.venv/",
	"package-lock.json", "yarn.lock", "pnpm-lock.yaml",
	".min.js", ".bundle.js",
]

function isSensitivePath(path: string): boolean {
	const lower = path.toLowerCase()
	for (const pat of SENSITIVE_PATH_PATTERNS) {
		if (lower.includes(pat)) return true
	}
	return false
}

export class CodebaseDependencyTool extends BaseTool<"codebase_dependency"> {
	readonly name = "codebase_dependency" as const

	async execute(params: CodebaseDependencyParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks
		const { action, target, module: modulePath, limit } = params
		try {
			const context = task.providerRef.deref()?.context
			if (!context) { pushToolResult("Extension context not available."); return }
			const service = CodebaseMappingManager.getInstance(context, task.cwd)
			if (!service) {
				pushToolResult("Codebase mapping not available. Ensure the codebase mapping scan has completed.")
				return
			}
			const graph = await service.getDependencyGraph()
			// Fix 3: Check if scan is still in progress
			const scanStatus = (service as any)._scanStatus || "unknown"
			if (scanStatus === "scanning") {
				pushToolResult("Codebase mapping is still scanning. The dependency graph may be incomplete. Please wait for the scan to complete.\n\nMeanwhile, you can use codebase_search (semantic search) for code exploration.")
				return
			}
			const allSymbols = await service.getSymbols()
			const deadCode = await service.getDeadCode()
			const maxResults = limit ?? 30  // Fix 3: Default limit = 30
			let result: string
			switch (action) {
				case "reverse_deps": result = this.queryReverseDeps(graph, target, maxResults); break
				case "forward_deps": result = await this.queryForwardDeps(graph, target, maxResults); break
				case "file_info": result = await this.queryFileInfo(graph, allSymbols, target); break
				case "dead_symbols": result = this.queryDeadSymbols(deadCode, maxResults); break
				case "module_map":
				if (!modulePath && modulePath !== null) {
					result = "Error: 'module' parameter is required for module_map action. Example: codebase_dependency(action=\"module_map\", module=\"src/feature\")"
				} else {
					result = this.queryModuleMap(graph, modulePath, maxResults)
				}
				break
				case "cycles": result = this.queryCycles(graph); break
				default: result = "Unknown action: " + action
			}
			pushToolResult(result)
		} catch (error) { await handleError("querying codebase dependency graph", error as Error) }
	}

	// Fix 3: Truncation helper
	private truncate(items: string[], max: number, label: string): string[] {
		if (items.length <= max) return items
		return [...items.slice(0, max), "... and " + (items.length - max) + " more " + label]
	}

	// Fix 6: Filter sensitive paths
	private filterPaths(items: string[]): string[] {
		return items.filter(p => !isSensitivePath(p))
	}

	// Fix 6: Filter graph edges/files for sensitive paths
	private filterGraph(files: Map<string, any>): Map<string, any> {
		const filtered = new Map<string, any>()
		for (const [key, fn] of files) {
			if (!isSensitivePath(key)) filtered.set(key, fn)
		}
		return filtered
	}

	private queryReverseDeps(graph: any, target: string | null, maxResults: number): string {
		if (!target) return "Error: 'target' is required for reverse_deps query."
		const tl = target.toLowerCase()
		const rev: Array<{ from: string; kind: string }> = []
		const files = this.filterGraph(graph.files)
		for (const edge of graph.edges || []) {
			if ((edge.to || "").toLowerCase().includes(tl)) rev.push({ from: edge.from, kind: edge.kind })
		}
		for (const [, fn] of files) {
			const fp = fn.filePath || fn.path || ""
			if (isSensitivePath(fp)) continue
			for (const imp of (fn.imports || [])) {
				if (imp.toLowerCase().includes(tl)) rev.push({ from: fp, kind: "import" })
			}
		}
		const unique = new Map<string, string>()
		for (const e of rev) unique.set(e.from, e.kind)
		const all = [...unique.entries()].sort((a, b) => a[0].localeCompare(b[0]))
		const truncated = all.length > maxResults ? all.slice(0, maxResults) : all
		if (unique.size === 0) return "## Reverse Dependencies for \"" + target + "\"\n\nNo files depend on this target. It may be dead code."
		const lines = ["## Reverse Dependencies for \"" + target + "\"", "", "Found " + unique.size + " file(s):" + (all.length > truncated.length ? " (showing " + truncated.length + ")" : ""), ""]
		for (const [from, kind] of truncated) lines.push("- `" + from + "` (" + kind + ")")
		if (all.length > truncated.length) lines.push("... and " + (all.length - truncated.length) + " more")
		return lines.join("\n")
	}

	private async queryForwardDeps(graph: any, target: string | null, maxResults: number): Promise<string> {
		if (!target) return "Error: 'target' is required for forward_deps query."
		const tl = target.toLowerCase()
		let fn: any = null
		for (const [, f] of graph.files) {
			const fp = (f.filePath || f.path || "").toLowerCase()
			if (fp === tl || fp.endsWith("/" + tl)) { fn = f; break }
		}
		if (!fn) return "## Forward Dependencies for \"" + target + "\"\n\nFile not found in the dependency graph."
		const imps = this.filterPaths(fn.imports || [])
		const exps = fn.exports || []
		const syms = fn.symbols || []
		const lines = ["## Forward Dependencies for `" + (fn.filePath || target) + "`", ""]
		if (syms.length > 0) {
			lines.push("**Symbols defined here:** " + syms.length)
			lines.push(syms.map((s: any) => s.name || s).slice(0, maxResults).join(", "))
			lines.push("")
		}
		if (imps.length > 0) {
			lines.push("**Imports (" + imps.length + "):**")
			const uniqueImps = [...new Set(imps)]  // Fix 7: deduplicate
			for (const imp of uniqueImps.slice(0, maxResults)) lines.push("- `" + imp + "`")
			if (imps.length > maxResults) lines.push("... and " + (imps.length - maxResults) + " more")
			lines.push("")
		}
		if (exps.length > 0) {
			lines.push("**Exports (" + exps.length + "):**")
			for (const exp of exps.slice(0, maxResults)) lines.push("- `" + exp + "`")
			if (exps.length > maxResults) lines.push("... and " + (exps.length - maxResults) + " more")
		}
		if (imps.length === 0 && exps.length === 0) lines.push("No imports or exports recorded for this file.")
		return lines.join("\n")
	}

	// Fix 5: Exact path match — no substring includes
	private async queryFileInfo(graph: any, allSymbols: any[], target: string | null): Promise<string> {
		if (!target) return "Error: 'target' is required for file_info query."
		const tl = target.toLowerCase()
		let fn: any = null; let fk = ""
		for (const [key, f] of graph.files) {
			const fp = (f.filePath || f.path || key || "").toLowerCase()
			if (fp === tl || fp.endsWith("/" + tl)) { fn = f; fk = f.filePath || f.path || key; break }
		}
		if (!fn) return "## File Info: \"" + target + "\"\n\nFile not found in the dependency graph."
		// Fix 5: Exact path match — only symbols from THIS file
		const fileSymbols = allSymbols.filter((s: any) => {
			const sp = (s.filePath || "").toLowerCase()
			return sp === tl || sp === fk.toLowerCase()
		})
		const dead = fileSymbols.filter((s: any) => s.referenceCount === 0 && !s.isExported)
		const lines = ["## File Info: `" + fk + "`", "", "**Language:** " + (fn.language || "unknown"), "**Size:** " + (fn.size || "?") + " bytes", "**Symbols:** " + (fn.symbols || []).length + " defined, " + fileSymbols.length + " extracted", "**Imports:** " + (fn.imports || []).length, "**Exports:** " + (fn.exports || []).length, "**Page Rank:** " + (fn.pageRank ?? "N/A"), ""]
		if (fileSymbols.length > 0) {
			lines.push("**Symbols:**")
			for (const sym of fileSymbols.slice(0, 30)) {
				const dm = sym.referenceCount === 0 && !sym.isExported ? " (unused)" : ""
				const ex = sym.isExported ? " [exported]" : ""
				lines.push("- `" + sym.name + "` (" + sym.kind + ")" + ex + dm)
			}
			if (fileSymbols.length > 30) lines.push("... and " + (fileSymbols.length - 30) + " more symbols")
			lines.push("")
		}
		if ((fn.imports || []).length > 0) {
			lines.push("**Imports:**")
			for (const imp of (fn.imports || []).slice(0, 20)) lines.push("- `" + imp + "`")
			if ((fn.imports || []).length > 20) lines.push("... and " + (fn.imports.length - 20) + " more")
			lines.push("")
		}
		if (dead.length > 0) {
			lines.push("**" + dead.length + " potentially dead symbol(s):**")
			for (const sym of dead.slice(0, 10)) lines.push("- `" + sym.name + "` (" + sym.kind + ") - zero references")
		}
		return lines.join("\n")
	}

	private queryDeadSymbols(deadCode: any[], maxResults: number): string {
		if (!deadCode || deadCode.length === 0) return "## Dead Code Analysis\n\nNo dead symbols detected."
		const byFile = new Map<string, any[]>()
		for (const d of deadCode) {
			const fp = d.filePath || "unknown"
			if (isSensitivePath(fp)) continue  // Fix 6
			if (!byFile.has(fp)) byFile.set(fp, [])
			byFile.get(fp)!.push(d)
		}
		let totalShown = 0
		const lines = ["## Dead Code Analysis", "", "**" + deadCode.length + " potentially dead symbol(s) found.**" + (deadCode.length > maxResults ? " (showing " + maxResults + ")" : ""), ""]
		for (const [fp, syms] of byFile) {
			if (totalShown >= maxResults) break
			lines.push("### `" + fp + "`")
			for (const sym of syms.slice(0, Math.min(10, maxResults - totalShown))) {
				lines.push("- `" + sym.name + "` (" + sym.kind + ")")
				totalShown++
			}
			if (totalShown >= maxResults && syms.length > totalShown - (totalShown - syms.slice(0, Math.min(10, maxResults - totalShown)).length)) {
				lines.push("  ... and more")
			}
			lines.push("")
		}
		return lines.join("\n")
	}

	private queryModuleMap(graph: any, modulePath: string | null, maxResults: number): string {
		if (!modulePath) return this.queryProjectSummary(graph)
		const ml = modulePath.toLowerCase()
		const mf: any[] = []
		for (const [, fn] of graph.files) {
			const fp = (fn.filePath || fn.path || "").toLowerCase()
			if (fp.startsWith(ml) && !isSensitivePath(fp)) mf.push(fn)  // Fix 6
		}
		if (mf.length === 0) return "## Module Map: `" + modulePath + "`\n\nNo files found in this module."
		const ts = mf.reduce((s, f) => s + (f.symbols || []).length, 0)
		const ti = mf.reduce((s, f) => s + (f.imports || []).length, 0)
		const te = mf.reduce((s, f) => s + (f.exports || []).length, 0)
		const shown = mf.slice(0, maxResults)
		const lines = ["## Module Map: `" + modulePath + "`", "", "**" + mf.length + " files** | " + ts + " symbols | " + ti + " imports | " + te + " exports" + (mf.length > shown.length ? " (showing " + shown.length + ")" : ""), "", "| File | Symbols | Imports | Exports |", "|------|---------|---------|---------|"]
		for (const f of shown) {
			const fp = f.filePath || f.path || f.id || ""
			const sn = fp.startsWith(ml) ? fp.slice(ml.length) : fp.split("/").pop()
			lines.push("| `" + sn + "` | " + (f.symbols || []).length + " | " + (f.imports || []).length + " | " + (f.exports || []).length + " |")
		}
		if (mf.length > shown.length) lines.push("| ... and " + (mf.length - shown.length) + " more files | | | |")
		return lines.join("\n")
	}

	private queryCycles(graph: any): string {
		const cycles = graph.cycles || []
		if (!cycles || cycles.length === 0) return "## Circular Dependencies\n\nNo circular dependencies detected."
		const lines = ["## Circular Dependencies", "", "**" + cycles.length + " cycle(s) detected.**", ""]
		for (let i = 0; i < cycles.length && i < 10; i++) {
			const c = cycles[i]
			if (Array.isArray(c)) {
				lines.push("### Cycle " + (i + 1))
				lines.push("```")
				for (const node of c) lines.push("  " + node)
				lines.push("```")
				lines.push("")
			}
		}
		return lines.join("\n")
	}

	// Fix 4: Lightweight summary only — no duplication with system prompt
	private queryProjectSummary(graph: any): string {
		const totalFiles = graph.files.size
		let ts = 0, ti = 0, te = 0
		const tops: Array<{ name: string; deps: number; exports: number }> = []
		for (const [, fn] of graph.files) {
			const fp = fn.filePath || fn.path || fn.id || ""
			if (isSensitivePath(fp)) continue  // Fix 6
			const ic = (fn.imports || []).length; const ec = (fn.exports || []).length
			ts += (fn.symbols || []).length; ti += ic; te += ec
			if (ec > 0 || ic > 0) tops.push({ name: fp, deps: ic, exports: ec })
		}
		tops.sort((a, b) => b.deps + b.exports - (a.deps + a.exports))
		let vc = 0
		for (const [, fn] of graph.files) {
			const fp = (fn.filePath || fn.path || "").toLowerCase()
			for (const imp of fn.imports || []) {
				const il = imp.toLowerCase()
				if (fp.includes("/infrastructure/") && (il.includes("/domain/") || il.includes("/core/"))) vc++
				else if (fp.includes("/application/") && (il.includes("/infrastructure/") || il.includes("/data/"))) vc++
			}
		}
		const lines = ["## Project Architecture Summary", "", "**" + totalFiles + " files** | " + ts + " symbols | " + ti + " imports | " + te + " exports", ""]
		if (tops.length > 0) {
			lines.push("**Most Connected Files (hubs):**")
			for (const f of tops.slice(0, 15)) lines.push("- `" + f.name + "` -> " + f.deps + " deps, " + f.exports + " exports")
			lines.push("")
		}
		lines.push(vc > 0 ? "**" + vc + " layered architecture violation(s) detected.**" : "**No layered architecture violations detected.**")
		return lines.join("\n")
	}
}

export const codebaseDependencyTool = new CodebaseDependencyTool()
