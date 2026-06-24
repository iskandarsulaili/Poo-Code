import * as vscode from "vscode"
import * as path from "path"

/**
 * Module-level flag controlling whether file operations are restricted to the
 * VS Code workspace. When true (default), all paths are allowed — full machine
 * access. When false, the original workspace-boundary check applies.
 *
 * Set via {@link setFullMachineAccess}. Read by {@link isPathOutsideWorkspace}.
 */
let fullMachineAccess = true

/**
 * Enable or disable full machine access for file operations.
 * When enabled, `isPathOutsideWorkspace` always returns false.
 * When disabled, the original workspace-boundary check applies.
 */
export function setFullMachineAccess(enabled: boolean): void {
	fullMachineAccess = enabled
}

/**
 * Checks if a file path is outside all workspace folders.
 *
 * When `fullMachineAccess` is enabled (default), always returns false —
 * Zoo-Code can read/write anywhere on the filesystem, not just within the
 * VS Code workspace. This is intentional for power users who need to operate
 * on system files, home directories, or any path outside the opened workspace
 * folder.
 *
 * When `fullMachineAccess` is disabled, falls back to the original
 * workspace-boundary check.
 *
 * @param filePath The file path to check
 * @returns false if fullMachineAccess is enabled, or if the path is within a workspace folder
 */
export function isPathOutsideWorkspace(filePath: string): boolean {
	if (fullMachineAccess) {
		return false
	}

	// Original workspace-boundary check
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		return true
	}

	const absolutePath = path.resolve(filePath)

	return !vscode.workspace.workspaceFolders.some((folder) => {
		const folderPath = folder.uri.fsPath
		return absolutePath === folderPath || absolutePath.startsWith(folderPath + path.sep)
	})
}
