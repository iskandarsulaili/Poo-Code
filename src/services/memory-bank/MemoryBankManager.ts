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

/** Max size for append-only files (decisionLog.md, progress.md) before auto-truncation */
export const MAX_APPEND_FILE_SIZE_BYTES = 100 * 1024 // 100 KB

/** Lines to retain from the start when truncating (the header/template) */
const TRUNCATE_RETAIN_HEADER_LINES = 10

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

## Key Features

## Overall Architecture

## Technology Stack
`,
  },
  "activeContext.md": {
    label: "Active Context",
    appendMode: false,
    template: `# Active Context

## Current Focus

## Recent Changes

## Open Questions / Issues
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

## Architectural Patterns
`,
  },
  "progress.md": {
    label: "Progress",
    appendMode: true,
    template: `# Progress

## Completed Tasks

## Current Tasks

## Next Steps
`,
  },
}

export class MemoryBankManager {
  private cwd: string
  private memoryBankDir: string
  private _initialized: boolean = false
  private _contentCache: Map<MemoryBankFile, string> = new Map()

  /** Singleton instances keyed by workspace path */
  private static instances = new Map<string, MemoryBankManager>()

  constructor(cwd: string) {
    this.cwd = cwd
    this.memoryBankDir = path.join(cwd, MEMORY_BANK_DIR)
  }

  /**
   * Get or create a MemoryBankManager for the given workspace path.
   */
  static getInstance(cwd: string): MemoryBankManager {
    let inst = MemoryBankManager.instances.get(cwd)
    if (!inst) {
      inst = new MemoryBankManager(cwd)
      MemoryBankManager.instances.set(cwd, inst)
    }
    return inst
  }

  /**
   * Reset the cached instance for a workspace path (for testing / workspace switch).
   */
  static resetInstance(cwd: string): void {
    MemoryBankManager.instances.delete(cwd)
  }

  /**
   * Initialize memory bank: create directory + template files if missing.
   * Also updates .gitignore with memory-bank/ entry if needed.
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

      // Ensure .gitignore has memory-bank/ entry
      await this._ensureGitignoreEntry()

      this._initialized = true
    } catch (err) {
      console.error("[MemoryBankManager] Initialization failed:", err)
    }
  }

  /**
   * Check if memory-bank directory exists and has files.
   * If not, auto-initialize (creates templates and .gitignore entry).
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.memoryBankDir)
      for (const filename of MEMORY_BANK_FILES) {
        await fs.access(path.join(this.memoryBankDir, filename))
      }
      return true
    } catch {
      // Auto-initialize on first check — creates templates if they don't exist
      await this.initialize()
      // Check again
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
   * Automatically truncates append-only files (decisionLog.md, progress.md) if they exceed MAX_APPEND_FILE_SIZE_BYTES.
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
      let existing = await this.readFile(filename)

      // Auto-truncate append-only files that exceed size limit
      if (meta.appendMode) {
        existing = await this._truncateIfNeeded(filename, existing)
      }

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
   * Truncate an append-only file if it exceeds the max size.
   * Keeps the first TRUNCATE_RETAIN_HEADER_LINES lines as header,
   * then keeps the most recent entries up to the limit.
   */
  private async _truncateIfNeeded(filename: MemoryBankFile, content: string): Promise<string> {
    const filePath = path.join(this.memoryBankDir, filename)
    try {
      const stat = await fs.stat(filePath)
      if (stat.size <= MAX_APPEND_FILE_SIZE_BYTES) return content

      console.warn(`[MemoryBankManager] ${filename} is ${stat.size} bytes, truncating to ${MAX_APPEND_FILE_SIZE_BYTES} bytes`)

      const lines = content.split("\n")
      const header = lines.slice(0, TRUNCATE_RETAIN_HEADER_LINES).join("\n")
      const body = lines.slice(TRUNCATE_RETAIN_HEADER_LINES)

      // Keep the newest entries (take from end, not start)
      // Estimate 200 bytes per entry, calculate how many to keep
      const maxBodySize = MAX_APPEND_FILE_SIZE_BYTES - header.length - 200 // 200 bytes safety margin
      let keptSize = 0
      const keptLines: string[] = []

      for (let i = body.length - 1; i >= 0; i--) {
        const lineCost = body[i].length + 1 // +1 for newline
        if (keptSize + lineCost > maxBodySize) break
        keptLines.unshift(body[i])
        keptSize += lineCost
      }

      const truncated = keptLines.length > 0
        ? `${header}\n\n<!-- Older entries truncated (file exceeded ${Math.round(MAX_APPEND_FILE_SIZE_BYTES / 1024)}KB limit) -->\n\n${keptLines.join("\n")}\n`
        : `${header}\n\n<!-- File truncated to header only (exceeded ${Math.round(MAX_APPEND_FILE_SIZE_BYTES / 1024)}KB limit) -->\n`

      // Write truncated version
      await fs.writeFile(filePath, truncated, "utf-8")
      return truncated
    } catch {
      return content
    }
  }

  /**
   * Ensure .gitignore has a memory-bank/ entry.
   * Creates .gitignore if it doesn't exist.
   */
  private async _ensureGitignoreEntry(): Promise<void> {
    const gitignorePath = path.join(this.cwd, ".gitignore")
    try {
      let content = ""
      try {
        content = await fs.readFile(gitignorePath, "utf-8")
      } catch {
        // .gitignore doesn't exist, we'll create it
      }

      const entry = `\n# Memory bank — per-session project context\n${MEMORY_BANK_DIR}/\n`
      if (!content.includes(MEMORY_BANK_DIR)) {
        await fs.writeFile(gitignorePath, content + entry, "utf-8")
      }
    } catch {
      // Non-blocking — .gitignore is optional
    }
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
        sections.push(`=== ${meta.label} (${filename}) ===
${content.trim()}`)
      }
    }

    if (sections.length === 0) return ""

    return `====

MEMORY BANK — PERSISTENT PROJECT CONTEXT

The memory bank stores structured knowledge about this project across sessions.
It is loaded at the start of every session so you have immediate awareness of
project goals, architecture, decisions, and progress.

Update it with the \`update_memory_bank\` tool whenever you:
- Make an architectural decision (→ decisionLog.md)
- Discover a reusable pattern (→ systemPatterns.md)
- Complete a task or start a new one (→ progress.md)
- Change the project's focus or direction (→ activeContext.md)
- Change core product understanding (→ productContext.md)

${sections.join("\n\n")}`
  }

  /**
   * Reset all cached instances (for workspace switch / shutdown).
   */
  static resetAllInstances(): void {
    MemoryBankManager.instances.clear()
  }

  /** Cached initialized status */
  get initialized(): boolean {
    return this._initialized
  }
}
