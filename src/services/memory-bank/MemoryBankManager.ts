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

/** Max size for append-only files (decisionLog.md, progress.md) before auto-compression */
export const MAX_APPEND_FILE_SIZE_BYTES = 200 * 1024 // 200 KB — critical threshold

/** Lines to retain from the start when compressing (the header/template) */
const COMPRESS_RETAIN_HEADER_LINES = 10

/** After compression: max entries to preserve in detail */
const COMPRESS_KEEP_ENTRIES = 20

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
   * Bypasses cache when forceRefresh is true (for detecting manual edits).
   */
  async readFile(filename: MemoryBankFile, forceRefresh?: boolean): Promise<string> {
    const filePath = path.join(this.memoryBankDir, filename)
    try {
      // If cached and no force refresh, return cached
      if (!forceRefresh && this._contentCache.has(filename)) {
        return this._contentCache.get(filename)!
      }
      const content = await fs.readFile(filePath, "utf-8")
      this._contentCache.set(filename, content)
      return content
    } catch {
      return ""
    }
  }

  /**
   * Invalidate the content cache for a file (or all files).
   * Call after external/human edits to ensure fresh reads.
   */
  invalidateCache(filename?: MemoryBankFile): void {
    if (filename) {
      this._contentCache.delete(filename)
    } else {
      this._contentCache.clear()
    }
  }

  /**
   * Re-read a file from disk, bypassing cache.
   * Use after detecting external edits.
   */
  async refreshFile(filename: MemoryBankFile): Promise<string> {
    return this.readFile(filename, true)
  }

  /**
   * Update a memory bank file.
   * If appendMode is true and content is not a full replacement, appends with timestamp.
   * Compresses append-only files (decisionLog.md, progress.md) only when they exceed CRITICAL size.
   * Compression preserves all entries but condenses old ones to summary format.
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

      // Compress append-only files ONLY if they exceed critical size threshold
      if (meta.appendMode) {
        existing = await this._compressIfNeeded(filename, existing)
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

    // Invalidate cache so next read is fresh
    this._contentCache.delete(filename)
  }

  /**
   * Compress an append-only file ONLY if it exceeds the critical size threshold.
   * Does NOT delete entries — compresses OLD entries into a concise summary format,
   * preserving the most recent COMPRESS_KEEP_ENTRIES in full detail.
   */
  private async _compressIfNeeded(filename: MemoryBankFile, content: string): Promise<string> {
    const filePath = path.join(this.memoryBankDir, filename)
    try {
      const stat = await fs.stat(filePath)
      if (stat.size <= MAX_APPEND_FILE_SIZE_BYTES) return content

      console.warn(
        `[MemoryBankManager] ${filename} is ${stat.size} bytes (>${Math.round(MAX_APPEND_FILE_SIZE_BYTES / 1024)}KB), compressing old entries`
      )

      const lines = content.split("\n")
      const header = lines.slice(0, COMPRESS_RETAIN_HEADER_LINES).join("\n")
      const body = lines.slice(COMPRESS_RETAIN_HEADER_LINES)

      // Split body into entries: each `---` line is a separator between entries
      // or each `###` / `*Updated` is an entry start
      const entries: string[] = []
      let currentEntry: string[] = []
      for (const line of body) {
        if (line.trim() === "---" || line.startsWith("### ")) {
          if (currentEntry.length > 0) {
            entries.push(currentEntry.join("\n"))
          }
          currentEntry = [line]
        } else {
          currentEntry.push(line)
        }
      }
      if (currentEntry.length > 0) {
        entries.push(currentEntry.join("\n"))
      }

      // Keep recent entries in full, compress old ones
      const recentEntries = entries.slice(-COMPRESS_KEEP_ENTRIES)
      const oldEntries = entries.slice(0, -COMPRESS_KEEP_ENTRIES)

      // Compress old entries: count them and extract key info (timestamps + first lines)
      const compressedOld: string[] = []
      let totalOldEntries = 0
      for (const entry of oldEntries) {
        totalOldEntries++
        const entryLines = entry.split("\n").filter(l => l.trim())
        // Extract timestamp from *Updated lines
        const timestampLine = entryLines.find(l => l.includes("*Updated"))
        const firstContent = entryLines.find(l => !l.startsWith("---") && !l.startsWith("*Updated") && l.trim())
        const dateStr = timestampLine
          ? timestampLine.replace(/\*Updated |\*/g, "").trim()
          : "unknown date"
        const summary = firstContent
          ? firstContent.trim().substring(0, 100)
          : "(no content)"
        compressedOld.push(`- ${dateStr}: ${summary}`)
      }

      // Build compressed file: header + summary of old entries + recent entries in full
      let compressed = header

      if (totalOldEntries > 0) {
        const label = filename === "decisionLog.md" ? "Decisions" : "Tasks"
        compressed += `\n\n<!-- Older ${label} (${totalOldEntries}) — compressed: -->\n`
        for (const summary of compressedOld) {
          compressed += `${summary}\n`
        }
        compressed += `\n<!-- ${recentEntries.length} most recent ${label.toLowerCase()} in full detail below -->\n`
      }

      for (const entry of recentEntries) {
        compressed += `\n${entry}\n`
      }

      // Write compressed version
      await fs.writeFile(filePath, compressed, "utf-8")
      return compressed
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
