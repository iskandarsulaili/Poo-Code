import * as fs from "fs/promises"
import * as path from "path"

/**
 * Memory Bank — structured markdown files for persistent project context.
 *
 * Inspired by the roo-code-memory-bank methodology:
 * 5 files in memory-bank/ folder at project root, read at session start,
 * updated by the agent during the session via update_memory_bank tool.
 *
 * Files:
 *   productContext.md    — Project goal, high-level architecture, key features
 *   activeContext.md     — Current focus, recent changes, open questions
 *   decisionLog.md       — Architectural decisions with rationale (append-only)
 *   systemPatterns.md    — Coding patterns, conventions, architecture decisions
 *   progress.md          — Task tracking: completed, current, next steps (append-only)
 */

export const MEMORY_BANK_DIR = "memory-bank"
export const MEMORY_BANK_FILES = [
  "productContext.md",
  "activeContext.md",
  "decisionLog.md",
  "systemPatterns.md",
  "progress.md",
] as const

export type MemoryBankFile = typeof MEMORY_BANK_FILES[number]

interface MemoryBankFileMeta {
  /** Short label for tool display */
  label: string
  /** Whether to append new content (true) or replace (false) */
  appendMode: boolean
  /** Template content for first initialization */
  template: string
}

const FILE_META: Record<MemoryBankFile, MemoryBankFileMeta> = {
  "productContext.md": {
    label: "Product Context",
    appendMode: false,
    template: `# Product Context

## Project Goal
<!-- What is this project trying to achieve? Who is it for? -->

## Key Features
<!-- List the main features and capabilities -->

## Overall Architecture
<!-- High-level architecture diagram/description -->

## Technology Stack
<!-- Languages, frameworks, databases, infrastructure -->
`,
  },
  "activeContext.md": {
    label: "Active Context",
    appendMode: false,
    template: `# Active Context

## Current Focus
<!-- What is being worked on right now? -->

## Recent Changes
<!-- Summary of recent changes and their impact -->

## Open Questions / Issues
<!-- Any unresolved questions, blockers, or decisions pending -->
`,
  },
  "decisionLog.md": {
    label: "Decision Log",
    appendMode: true,
    template: `# Decision Log

## Format
Each entry: | Date | Decision | Rationale | Implementation Details |
`,
  },
  "systemPatterns.md": {
    label: "System Patterns",
    appendMode: false,
    template: `# System Patterns

## Coding Patterns
<!-- Coding conventions, naming conventions, file structure -->

## Architectural Patterns
<!-- Design patterns, layers, modules, dependencies -->
`,
  },
  "progress.md": {
    label: "Progress",
    appendMode: true,
    template: `# Progress

## Completed Tasks
<!-- Tasks that have been finished -->

## Current Tasks
<!-- Tasks currently being worked on -->

## Next Steps
<!-- Planned future work -->
`,
  },
}

export class MemoryBankManager {
  private cwd: string
  private memoryBankDir: string
  private _initialized: boolean = false
  private _contentCache: Map<MemoryBankFile, string> = new Map()

  constructor(cwd: string) {
    this.cwd = cwd
    this.memoryBankDir = path.join(cwd, MEMORY_BANK_DIR)
  }

  /**
   * Initialize memory bank: create directory + template files if missing.
   * Safe to call multiple times — skips existing files.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return

    try {
      await fs.mkdir(this.memoryBankDir, { recursive: true })

      for (const filename of MEMORY_BANK_FILES) {
        const filePath = path.join(this.memoryBankDir, filename)
        try {
          await fs.access(filePath)
        } catch {
          // File doesn't exist — create with template
          await fs.writeFile(filePath, FILE_META[filename].template, "utf-8")
        }
      }

      this._initialized = true
    } catch (err) {
      console.error("[MemoryBankManager] Initialization failed:", err)
    }
  }

  /**
   * Check if memory-bank directory exists and has files
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.memoryBankDir)
      for (const filename of MEMORY_BANK_FILES) {
        await fs.access(path.join(this.memoryBankDir, filename))
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Read a single memory bank file.
   */
  async readFile(filename: MemoryBankFile): Promise<string> {
    const filePath = path.join(this.memoryBankDir, filename)
    try {
      const content = await fs.readFile(filePath, "utf-8")
      this._contentCache.set(filename, content)
      return content
    } catch {
      return ""
    }
  }

  /**
   * Update a memory bank file.
   * If appendMode is true and content is not a full replacement, appends with timestamp.
   * Otherwise replaces the entire file.
   */
  async updateFile(
    filename: MemoryBankFile,
    content: string,
    append?: boolean,
  ): Promise<void> {
    const filePath = path.join(this.memoryBankDir, filename)
    const meta = FILE_META[filename]
    const shouldAppend = append ?? meta.appendMode

    // Ensure directory exists
    await fs.mkdir(this.memoryBankDir, { recursive: true })

    if (shouldAppend && !content.startsWith("#")) {
      // Append mode: read existing content and add new section with timestamp
      const existing = await this.readFile(filename)
      const timestamp = new Date().toISOString().replace("T", " ").substring(0, 16)
      const separator = existing.endsWith("\n") ? "" : "\n"
      await fs.writeFile(
        filePath,
        `${existing}${separator}\n---\n*Updated ${timestamp}*\n\n${content}\n`,
        "utf-8",
      )
    } else {
      // Replace mode or content is a full document (starts with #)
      await fs.writeFile(filePath, content, "utf-8")
    }

    this._contentCache.set(filename, content)
  }

  /**
   * Read ALL memory bank files and return a formatted context block
   * suitable for injection into the system prompt.
   */
  async getMemoryBankContext(): Promise<string> {
    await this.initialize()
    const sections: string[] = []

    for (const filename of MEMORY_BANK_FILES) {
      const content = await this.readFile(filename)
      if (content && content.trim()) {
        const meta = FILE_META[filename]
        sections.push(`=== ${meta.label} (${filename}) ===\n${content.trim()}`)
      }
    }

    if (sections.length === 0) return ""

    return `====\n\nMEMORY BANK — PERSISTENT PROJECT CONTEXT\n\nThe memory bank stores structured knowledge about this project across sessions.\nIt is loaded at the start of every session so you have immediate awareness of\nproject goals, architecture, decisions, and progress.\n\nUpdate it with the \`update_memory_bank\` tool whenever you:\n- Make an architectural decision (→ decisionLog.md)\n- Discover a reusable pattern (→ systemPatterns.md)\n- Complete a task or start a new one (→ progress.md)\n- Change the project's focus or direction (→ activeContext.md)\n- Change core product understanding (→ productContext.md)\n\n${sections.join("\n\n")}`
  }

  /** Cached initialized status */
  get initialized(): boolean {
    return this._initialized
  }
}
