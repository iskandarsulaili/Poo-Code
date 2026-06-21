import * as vscode from "vscode"
import * as path from "path"
import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { MemoryBankManager, MEMORY_BANK_FILES } from "../../services/memory-bank"
import type { MemoryBankFile } from "../../services/memory-bank"

interface UpdateMemoryBankParams {
  file: string
  content: string
  mode?: "append" | "replace"
}

export class UpdateMemoryBankTool extends BaseTool<"update_memory_bank"> {
  readonly name = "update_memory_bank" as const

  async execute(params: UpdateMemoryBankParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
    const { handleError, pushToolResult } = callbacks
    const { file, content, mode } = params

    // Validate file name
    if (!MEMORY_BANK_FILES.includes(file as MemoryBankFile)) {
      pushToolResult(`Invalid memory bank file: "${file}". Must be one of: ${MEMORY_BANK_FILES.join(", ")}`)
      return
    }

    try {
      const cwd = task.cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
      if (!cwd) {
        pushToolResult("No workspace directory available. Open a folder in VS Code first.")
        return
      }

      const manager = MemoryBankManager.getInstance(cwd)
      await manager.initialize()

      const filename = file as MemoryBankFile
      const shouldAppend = mode !== "replace" // default to append

      await manager.updateFile(filename, content, shouldAppend)

      const meta = { "productContext.md": "Product Context", "activeContext.md": "Active Context", "decisionLog.md": "Decision Log", "systemPatterns.md": "System Patterns", "progress.md": "Progress" }
      const label = meta[filename] || filename
      pushToolResult(`✅ Memory bank updated: ${label} (${filename})`)
    } catch (err) {
      handleError(`Failed to update memory bank: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export const updateMemoryBankTool = new UpdateMemoryBankTool()
