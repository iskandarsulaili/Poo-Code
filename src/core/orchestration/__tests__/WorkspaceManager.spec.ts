import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import path from "path"

// Must mock vscode BEFORE importing the SUT — constructor calls vscode APIs
// vi.mock factories are hoisted, so we use vi.hoisted() for shared variables
const mockOnDidChangeWorkspaceFolders = vi.hoisted(() => vi.fn())
const mockCreateFileSystemWatcher = vi.hoisted(() =>
	vi.fn(() => ({
		onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
		onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
		dispose: vi.fn(),
	})),
)
const mockWorkspaceFoldersInternal = vi.hoisted(() => ({
	current: [] as Array<{ uri: { fsPath: string }; name: string; index: number }>,
}))

vi.mock("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			return mockWorkspaceFoldersInternal.current
		},
		getWorkspaceFolder: vi.fn(() => null),
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
		})),
		onDidChangeWorkspaceFolders: mockOnDidChangeWorkspaceFolders,
		createFileSystemWatcher: mockCreateFileSystemWatcher,
	},
	window: {
		activeTextEditor: null,
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(() => Promise.resolve()),
		showWarningMessage: vi.fn(() => Promise.resolve()),
		showInformationMessage: vi.fn(() => Promise.resolve()),
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
		createTerminal: vi.fn(() => ({
			exitStatus: undefined,
			name: "test",
			processId: Promise.resolve(1),
			creationOptions: {},
			state: { isInteractedWith: true },
			dispose: vi.fn(),
			hide: vi.fn(),
			show: vi.fn(),
			sendText: vi.fn(),
		})),
		onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
	},
	commands: {
		registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
		executeCommand: vi.fn(() => Promise.resolve()),
	},
	languages: {
		createDiagnosticCollection: vi.fn(() => ({
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	extensions: {
		getExtension: vi.fn(() => null),
	},
	env: {
		openExternal: vi.fn(() => Promise.resolve()),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
		parse: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
	},
	EventEmitter: vi.fn(() => ({
		event: vi.fn(() => vi.fn()),
		fire: vi.fn(),
		dispose: vi.fn(),
	})),
	Disposable: { dispose: vi.fn() },
	ThemeIcon: class {
		constructor(public id: string) {}
	},
	FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
}))

// Import SUT after mock
import { WorkspaceManager } from "../WorkspaceManager"

describe("WorkspaceManager", () => {
	let mockContext: any

	beforeEach(() => {
		vi.clearAllMocks()
		WorkspaceManager.resetInstance()
		mockWorkspaceFoldersInternal.current = []

		mockContext = {
			subscriptions: [],
			extensionPath: "/test/extension",
			extensionUri: { fsPath: "/test/extension", path: "/test/extension", scheme: "file" },
			globalState: { get: vi.fn(), update: vi.fn() },
			workspaceState: { get: vi.fn(), update: vi.fn() },
		}

		// Ensure feature flag is enabled for most tests by re-importing
		// experiments module
	})

	afterEach(() => {
		WorkspaceManager.resetInstance()
	})

	describe("singleton", () => {
		it("should throw when getInstance() called without context on first invocation", () => {
			expect(() => WorkspaceManager.getInstance()).toThrow(
				"WorkspaceManager.getInstance() requires a context on first call",
			)
		})

		it("should return same instance on subsequent calls without context", () => {
			const instance1 = WorkspaceManager.getInstance(mockContext)
			const instance2 = WorkspaceManager.getInstance()
			expect(instance1).toBe(instance2)
		})

		it("should create new instance after resetInstance()", () => {
			const instance1 = WorkspaceManager.getInstance(mockContext)
			WorkspaceManager.resetInstance()
			const instance2 = WorkspaceManager.getInstance(mockContext)
			expect(instance1).not.toBe(instance2)
		})
	})

	describe("initialization", () => {
		it("should initialize from workspace folders", () => {
			mockWorkspaceFoldersInternal.current = [
				{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 },
				{ uri: { fsPath: "/root/b" }, name: "Root B", index: 1 },
			]

			const manager = WorkspaceManager.getInstance(mockContext)
			const roots = manager.getRoots()

			expect(roots).toHaveLength(2)
			expect(roots[0].name).toBe("Root A")
			expect(roots[1].name).toBe("Root B")
			expect(manager.isInitialized()).toBe(true)
		})

		it("should have empty roots when no workspace folders", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.getRoots()).toHaveLength(0)
		})

		it("should handle empty folders array", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			manager.initialize([])
			expect(manager.getRoots()).toHaveLength(0)
		})

		it("should handle duplicate folders gracefully", () => {
			mockWorkspaceFoldersInternal.current = [
				{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 },
				{ uri: { fsPath: "/root/a" }, name: "Root A", index: 1 },
			]

			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.getRoots()).toHaveLength(2)
		})
	})

	describe("getRoots / getPrimaryRoot", () => {
		it("should return all initialized roots", () => {
			mockWorkspaceFoldersInternal.current = [
				{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 },
				{ uri: { fsPath: "/root/b" }, name: "Root B", index: 1 },
			]

			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.getRoots()).toHaveLength(2)
		})

		it("getPrimaryRoot should return first root", () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]

			const manager = WorkspaceManager.getInstance(mockContext)
			const primary = manager.getPrimaryRoot()
			expect(primary).toBeDefined()
			expect(primary!.name).toBe("Root A")
		})

		it("getPrimaryRoot returns undefined when no roots", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.getPrimaryRoot()).toBeUndefined()
		})
	})

	describe("getRootForFile", () => {
		it("should find root for a file in the root path", () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			const root = manager.getRootForFile("/root/a/file.ts")
			expect(root).toBeDefined()
			expect(root!.name).toBe("Root A")
		})

		it("should prefer longest prefix match for nested roots", () => {
			mockWorkspaceFoldersInternal.current = [
				{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 },
				{ uri: { fsPath: "/root/a/b" }, name: "Root A/B", index: 1 },
			]
			const manager = WorkspaceManager.getInstance(mockContext)
			const root = manager.getRootForFile("/root/a/b/deep/file.ts")
			expect(root).toBeDefined()
			expect(root!.name).toBe("Root A/B")
		})

		it("should return undefined for file outside all roots", () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			const root = manager.getRootForFile("/other/path/file.ts")
			expect(root).toBeUndefined()
		})

		it("should return undefined for empty file path", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.getRootForFile("")).toBeUndefined()
		})
	})

	describe("resolvePath", () => {
		beforeEach(() => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
		})

		it("should pass through absolute paths as-is", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			const result = manager.resolvePath("/absolute/path/file.ts")
			expect(result).toBe(path.normalize("/absolute/path/file.ts"))
		})

		it("should resolve relative paths against primary root", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			const result = manager.resolvePath("relative/file.ts")
			expect(result).toBe(path.resolve("/root/a", "relative/file.ts"))
		})

		it("should resolve relative paths against contextCwd when provided", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			const result = manager.resolvePath("relative/file.ts", "/custom/cwd")
			expect(result).toBe(path.resolve("/custom/cwd", "relative/file.ts"))
		})

		it("should resolve with process.cwd when no primary root and no cwd", () => {
			WorkspaceManager.resetInstance()
			mockWorkspaceFoldersInternal.current = []
			const mgr2 = WorkspaceManager.getInstance(mockContext)
			const result = mgr2.resolvePath("relative/file.ts")
			expect(result).toBe(path.resolve("relative/file.ts"))
		})

		it("should return empty string for empty filePath", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.resolvePath("")).toBe("")
		})

		it("should normalize resolved paths", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			const result = manager.resolvePath("./foo/../bar/file.ts")
			expect(result).toBe(path.resolve("/root/a", "bar/file.ts"))
		})
	})

	describe("getWorkspaceFolders / getWorkspaceRootInfos", () => {
		it("getWorkspaceFolders should return roots", () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.getWorkspaceFolders()).toHaveLength(1)
		})

		it("getWorkspaceRootInfos should return serializable infos", () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			const infos = manager.getWorkspaceRootInfos()
			expect(infos).toHaveLength(1)
			expect(infos[0].name).toBe("Root A")
			expect(infos[0].fsPath).toBe("/root/a")
			expect(infos[0].index).toBe(0)
		})
	})

	describe("getCustomModesManager / getSkillsManager", () => {
		beforeEach(() => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
		})

		it("should return undefined for getCustomModesManager when dynamic import fails", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			const root = manager.getPrimaryRoot()!
			// Dynamic require of CustomModesManager will fail in test env → undefined
			const modesManager = manager.getCustomModesManager(root)
			expect(modesManager).toBeUndefined()
		})

		it("should return undefined for getSkillsManager when dynamic import fails", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			const root = manager.getPrimaryRoot()!
			const skillsManager = manager.getSkillsManager(root)
			expect(skillsManager).toBeUndefined()
		})
	})

	describe("dispose / isInitialized", () => {
		it("should be initialized when instance is created (even with no folders, init is called)", () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			// Constructor calls initialize() which sets initialized=true
			expect(manager.isInitialized()).toBe(true)
		})

		it("should clear initialized state on dispose", () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.isInitialized()).toBe(true)

			manager.dispose()
			expect(manager.isInitialized()).toBe(false)
			expect(manager.getRoots()).toHaveLength(0)
		})
	})

	describe("onDidChangeWorkspaceFolders", () => {
		it("should re-initialize from current folders on change event", () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			expect(manager.getRoots()).toHaveLength(1)

			mockWorkspaceFoldersInternal.current = [
				{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 },
				{ uri: { fsPath: "/root/b" }, name: "Root B", index: 1 },
			]

			const changeEvent = {
				added: [{ uri: { fsPath: "/root/b" }, name: "Root B", index: 1 }],
				removed: [],
			}
			manager.onDidChangeWorkspaceFolders(changeEvent as any)
			expect(manager.getRoots()).toHaveLength(2)
		})
	})

	describe("discoverAllRooDirectories / discoverSubfolderRooDirectories", () => {
		it("should return empty array when no roots", async () => {
			const manager = WorkspaceManager.getInstance(mockContext)
			const dirs = await manager.discoverAllRooDirectories()
			expect(dirs).toEqual([])
		})

		it("should return empty array when roots have no .roo dirs", async () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			const dirs = await manager.discoverAllRooDirectories()
			expect(dirs).toEqual([])
		})

		it("discoverSubfolderRooDirectories should work without root param", async () => {
			mockWorkspaceFoldersInternal.current = [{ uri: { fsPath: "/root/a" }, name: "Root A", index: 0 }]
			const manager = WorkspaceManager.getInstance(mockContext)
			const dirs = await manager.discoverSubfolderRooDirectories()
			expect(dirs).toEqual([])
		})
	})
})
