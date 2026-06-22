import * as vscode from "vscode"
import * as path from "path"
import type { Experiments } from "@roo-code/types"

import { type ModeConfig, type PromptComponent, type CustomModePrompts, type TodoItem } from "@roo-code/types"

import { Mode, modes, defaultModeSlug, getModeBySlug, getGroupName, getModeSelection } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { formatLanguage } from "../../shared/language"
import { isEmpty } from "../../utils/object"

import { McpHub } from "../../services/mcp/McpHub"
import { CodeIndexManager } from "../../services/code-index/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"
import { SelfImprovingManager, type PromptContext } from "../../services/self-improving"
import { CodebaseMappingManager } from "../../services/codebase-mapping"
import { MemoryBankManager } from "../../services/memory-bank"

import type { SystemPromptSettings } from "./types"
import {
	getRulesSection,
	getSystemInfoSection,
	getObjectiveSection,
	getSharedToolUseSection,
	getToolUseGuidelinesSection,
	getCapabilitiesSection,
	getModesSection,
	addCustomInstructions,
	markdownFormattingSection,
	getSkillsSection,
} from "./sections"


/**
 * Build a compact project architecture summary from codebase mapping data.
 * Injected into the system prompt so the agent understands the project structure
 * before making any file changes.
 */
async function getCodebaseMappingSection(cwd: string, extContext: vscode.ExtensionContext, experiments?: Partial<Experiments>): Promise<string> {
	// Fix 5: Return empty if user explicitly disabled codebase dependency
	if (experiments?.disableCodebaseDependency) return ""

	try {
		const service = CodebaseMappingManager.getInstance(extContext, cwd)
		if (!service) return ""
		
		const graph = await service.getDependencyGraph()
		if (!graph || graph.files.size === 0) {
			// Fix 4: Suggest how to enable the dependency graph
			return `
====

CODEBASE ARCHITECTURE — NOT AVAILABLE

The codebase dependency graph is empty. To enable it:
1. Run the VS Code command "Zoo-Code: Refresh Codebase Map"
   (or \`zoo-code.refreshCodebaseMap\`)
2. Or complete a code indexing run (the mapping scan triggers automatically after indexing)

Once the graph is populated, the \`codebase_dependency\` tool will be available for:
- Finding what depends on a file before refactoring
- Detecting circular dependencies
- Identifying dead/unreferenced code
- Module-level architecture analysis`
		}
		
		const totalFiles = graph.files.size
		const totalEdges = graph.edges.length
		
		// Fix 3 + 6: Check scan status and error count
		const scanStatus = (service as any)._scanStatus || "unknown"
		const errorCount = (service as any)._lastScanErrors || 0
		const statusNote = scanStatus === "scanning"
			? "\n⚠ Codebase mapping scan is still in progress. Results may be incomplete."
			: errorCount > 0
				? `\n⚠ ${errorCount} file(s) had parse errors during the last scan. The dependency graph may be incomplete.`
				: ""
		
		// Fix 4: Lightweight — just one line pointing to the tool, no full duplication
		// The codebase_dependency tool provides the full query interface
		return `
====

CODEBASE ARCHITECTURE

This project has ${totalFiles} files with ${totalEdges} dependency edges.${statusNote}
Use the \`codebase_dependency\` tool to query the dependency graph before refactoring:
- \`codebase_dependency(action="reverse_deps", target="src/file.ts")\` — find what depends on a file
- \`codebase_dependency(action="forward_deps", target="src/file.ts")\` — find what a file imports
- \`codebase_dependency(action="file_info", target="src/file.ts")\` — detailed file analysis
- \`codebase_dependency(action="module_map", module="src/feature")\` — module overview
- \`codebase_dependency(action="dead_symbols")\` — find unreferenced code
- \`codebase_dependency(action="cycles")\` — detect circular dependencies
\`codebase_mapping_query(action="schema")\` — codebase mapping types/schema
\`codebase_mapping_query(action="formats")\` — export formats
\`codebase_mapping_query(action="stats")\` — scan stats and cache info`
	} catch {
		return ""
	}
}

/**
 * Build a memory bank context section from the project's memory-bank/ directory.
 * Injected into the system prompt so the agent has immediate awareness of
 * project goals, decisions, and progress across sessions.
 */
async function getMemoryBankSection(cwd: string, experiments?: Partial<Experiments>, settings?: SystemPromptSettings): Promise<string> {
	// Return empty if user explicitly disabled memory bank
	if (experiments?.disableMemoryBank) return ""

	try {
		const manager = MemoryBankManager.getInstance(cwd)
		const exists = await manager.exists()
		if (!exists) return ""

		// Register init notification (fires once when templates are first created)
		manager.onInit(() => {
			const initMsg = `Memory bank initialized at ${path.join(cwd, "memory-bank")}/`
			try {
				// Only show VS Code notification if we have access to the API
				const vscode = require("vscode") as typeof import("vscode")
				vscode.window.showInformationMessage(initMsg)
			} catch {
				console.log(`[MemoryBank] ${initMsg}`)
			}
		})

		// Refresh ignore files on every session start (recreates if deleted externally)
		manager.refreshIgnoreFiles().catch(() => {})

		// Adaptive context limit: use at most 10% of the model's context window (default 128K tokens)
		const contextWindow = settings?.contextWindow ?? 128_000
		const maxContextBytes = Math.floor((contextWindow) * 10 / 100) // 10% of context window in ~tokens
		// Rough estimate: 1 token ~ 4 bytes for markdown
		const maxContentBytes = maxContextBytes * 4

		const context = await manager.getMemoryBankContext(maxContentBytes)
		if (!context) return ""

		// Append change summary if available
		const changeSummary = await manager.getChangeSummary()

		// Build final section with status prefix instruction
		const prefixLine = "Start every response with `[MEMORY BANK: ACTIVE]` to indicate context is loaded."
		return `\n${context}\n\n${prefixLine}\n${changeSummary}`
	} catch {
		return ""
	}
}

// Helper function to get prompt component, filtering out empty objects
export function getPromptComponent(
	customModePrompts: CustomModePrompts | undefined,
	mode: string,
): PromptComponent | undefined {
	const component = customModePrompts?.[mode]
	// Return undefined if component is empty
	if (isEmpty(component)) {
		return undefined
	}
	return component
}

/**
 * Format structured PromptContext entries into a markdown string for prompt injection.
 * Groups entries by their pattern type (prompt enrichment, error avoidance, tool preference).
 */
function buildPatternContextString(ctx: PromptContext): string {
	const sections: string[] = []

	const enrichedInstructions = ctx.entries.filter((e) => e.type === "prompt").map((e) => `- ${e.summary}`)
	if (enrichedInstructions.length > 0) {
		sections.push("## Learned Guidance\n" + enrichedInstructions.join("\n"))
	}

	const errorAvoidanceRules = ctx.entries.filter((e) => e.type === "error").map((e) => `- ${e.summary}`)
	if (errorAvoidanceRules.length > 0) {
		sections.push("## Error Avoidance\n" + errorAvoidanceRules.join("\n"))
	}

	const toolPreferences = ctx.entries.filter((e) => e.type === "tool").map((e) => `- ${e.summary}`)
	if (toolPreferences.length > 0) {
		sections.push("## Tool Preferences\n" + toolPreferences.join("\n"))
	}

	return sections.length > 0 ? sections.join("\n\n") : ""
}

async function generatePrompt(
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mode: Mode,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	promptComponent?: PromptComponent,
	customModeConfigs?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Partial<Experiments>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
	selfImprovingManager?: SelfImprovingManager,
): Promise<string> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Get the full mode config to ensure we have the role definition (used for groups, etc.)
	const modeConfig = getModeBySlug(mode, customModeConfigs) || modes.find((m) => m.slug === mode) || modes[0]
	const { roleDefinition, baseInstructions } = getModeSelection(mode, promptComponent, customModeConfigs)

	// Check if MCP functionality should be included
	const hasMcpGroup = modeConfig.groups.some((groupEntry) => getGroupName(groupEntry) === "mcp")
	const hasMcpServers = mcpHub && mcpHub.getServers().length > 0
	const shouldIncludeMcp = hasMcpGroup && hasMcpServers

	const codeIndexManager = CodeIndexManager.getInstance(context, cwd)

	// Tool calling is native-only.
	const effectiveProtocol = "native"

	const [modesSection, skillsSection] = await Promise.all([
		getModesSection(context),
		getSkillsSection(skillsManager, mode as string),
	])

	// Inject learned guidance from self-improving system (experiment-gated)
	const learningContext = selfImprovingManager?.getPromptContextString() || ""
	const promptContext = selfImprovingManager?.getPromptContext()
	const patternContext = promptContext ? buildPatternContextString(promptContext) : ""
	const combinedLearningContext = [learningContext, patternContext].filter(Boolean).join("\n\n")

	// Tools catalog is not included in the system prompt.
	const toolsCatalog = ""

	const basePrompt = `${roleDefinition}

${markdownFormattingSection()}

${getSharedToolUseSection()}${toolsCatalog}

	${getToolUseGuidelinesSection()}

${getCapabilitiesSection(cwd, shouldIncludeMcp ? mcpHub : undefined)}

${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}${combinedLearningContext}
${await getCodebaseMappingSection(cwd, context, experiments)}
${await getMemoryBankSection(cwd, experiments, settings)}
${getRulesSection(cwd, settings)}

${getSystemInfoSection(cwd)}

${getObjectiveSection()}

${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, mode, {
	language: language ?? formatLanguage(vscode.env.language),
	rooIgnoreInstructions,
	settings,
})}`

	return basePrompt
}

export const SYSTEM_PROMPT = async (
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	mode: Mode = defaultModeSlug,
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Partial<Experiments>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
	selfImprovingManager?: SelfImprovingManager,
): Promise<string> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Check if it's a custom mode
	const promptComponent = getPromptComponent(customModePrompts, mode)

	// Get full mode config from custom modes or fall back to built-in modes
	const currentMode = getModeBySlug(mode, customModes) || modes.find((m) => m.slug === mode) || modes[0]

	return generatePrompt(
		context,
		cwd,
		supportsComputerUse,
		currentMode.slug,
		mcpHub,
		diffStrategy,
		promptComponent,
		customModes,
		globalCustomInstructions,
		experiments,
		language,
		rooIgnoreInstructions,
		settings,
		todoList,
		modelId,
		skillsManager,
		selfImprovingManager,
	)
}
