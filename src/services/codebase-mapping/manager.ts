import * as vscode from "vscode";
import { CodebaseMappingService } from "../../../packages/codebase-mapping/src/index.js";
import type { CodebaseMappingConfig, MappingEvent } from "../../../packages/codebase-mapping/src/types.js";
import { WorkspaceManager } from "../../core/orchestration/WorkspaceManager";
import { SubProjectDetector } from "../../core/orchestration/SubProjectDetector";
import type { SubProject, DependencyGraph as OrchestrationDependencyGraph } from "../../../packages/types/src/index.js";

// ============================================================
// Type Bridge: Convert codebase-mapping DependencyGraph to orchestration DependencyGraph
// ============================================================

/**
 * Converts codebase-mapping's file-level DependencyGraph to orchestration's project-level DependencyGraph.
 * This bridges the two type systems.
 */
export function bridgeToOrchestrationGraph(
  mappingGraph: import("../../../packages/codebase-mapping/src/types.js").DependencyGraph,
  subProjects: SubProject[]
): OrchestrationDependencyGraph {
  return {
    projects: subProjects,
    buildOrder: subProjects.map((p) => p.id),
    cycles: [],
    updatedAt: new Date(),
  };
}

// ============================================================
// CodebaseMappingManager (singleton-per-workspace)
// ============================================================

interface MappingManagerInstance {
  service: CodebaseMappingService;
  workspacePath: string;
  disposables: vscode.Disposable[];
}

export class CodebaseMappingManager {
  private static instances = new Map<string, MappingManagerInstance>();
  private static globalDisposables: vscode.Disposable[] = [];

  /**
   * Get or create a CodebaseMappingService for the given workspace path.
   */
  static getInstance(
    context: vscode.ExtensionContext,
    workspacePath?: string
  ): CodebaseMappingService | undefined {
    const path = workspacePath ?? WorkspaceManager.getInstance(context)?.getPrimaryRoot()?.fsPath;
    if (!path) return undefined;

    const existing = CodebaseMappingManager.instances.get(path);
    if (existing) return existing.service;

    return CodebaseMappingManager.createInstance(context, path);
  }

  /**
   * Get all workspace instances.
   */
  static getAllInstances(): CodebaseMappingService[] {
    return Array.from(CodebaseMappingManager.instances.values()).map((i) => i.service);
  }

  /**
   * Initialize mapping services for all workspace folders.
   */
  static async initializeAll(
    context: vscode.ExtensionContext,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<void> {
    for (const folder of workspaceFolders) {
      CodebaseMappingManager.getInstance(context, folder.uri.fsPath);
    }
  }

  /**
   * Create a new mapping service instance for a workspace path.
   */
  private static createInstance(
    context: vscode.ExtensionContext,
    workspacePath: string
  ): CodebaseMappingService | undefined {
    const disposables: vscode.Disposable[] = [];

    const config: Partial<CodebaseMappingConfig> = {
      workspaceRoots: [workspacePath],
      enableSecretMasking: true,
      enablePIIDetection: true,
      enableDeadCodeDetection: true,
      enableCrossLanguageResolution: true,
      enableImplicitFlowTracking: true,
      enableGitIntegration: true,
      enableDocGenerator: true,
      enableDeltaMapping: true,
      parallelism: {
        maxFileReads: 100,
        maxParses: 50,
      },
    };

    const service = new CodebaseMappingService();

    // Wire up event logging
    service.onEvent((event: MappingEvent) => {
      if (event.type === "error") {
        console.error(`[codebase-mapping:${workspacePath}]`, event.data);
      } else if (event.type === "secret_detected") {
        console.warn(`[codebase-mapping:${workspacePath}] Secret detected`, event.data);
      }
    });

    // Initialize and scan asynchronously (independent of code indexing — Fix 1)
    service.initialize(config).then(() => {
      // Trigger workspace scan immediately after initialization
      // This runs independently of code indexing, so the dependency graph
      // is available even when vector search is not configured.
      service.scanWorkspace().catch((scanErr: unknown) => {
        console.error(`[codebase-mapping:${workspacePath}] Scan failed`, scanErr);
      });
    }).catch((err: unknown) => {
      console.error(`[codebase-mapping:${workspacePath}] Initialization failed`, err);
    });

    // Register workspace folder change handler
    const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      service.scanWorkspace().catch((err: unknown) => {
        console.error(`[codebase-mapping:${workspacePath}] Re-scan failed`, err);
      });
    });
    disposables.push(folderWatcher);

    // Register file save handler for incremental updates
    const saveWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.fsPath.startsWith(workspacePath)) {
        service.scanWorkspace().catch(() => {});
      }
    });
    disposables.push(saveWatcher);

    const instance: MappingManagerInstance = {
      service,
      workspacePath,
      disposables,
    };

    CodebaseMappingManager.instances.set(workspacePath, instance);
    context.subscriptions.push({ dispose: () => CodebaseMappingManager.dispose(workspacePath) });

    return service;
  }

  /**
   * Bridge codebase-mapping graph to orchestration graph for use with DepGraphBuilder/DepGraphResolver.
   */
  static async getOrchestrationGraph(
    context: vscode.ExtensionContext,
    workspacePath?: string
  ): Promise<OrchestrationDependencyGraph | undefined> {
    const service = CodebaseMappingManager.getInstance(context, workspacePath);
    if (!service) return undefined;

    const mappingGraph = await service.getDependencyGraph();
    const workspaceMgr = WorkspaceManager.getInstance(context);
    if (!workspaceMgr) return undefined;

    const rootInfo = workspaceMgr.getWorkspaceRootInfos().find((r) => r.fsPath === (workspacePath ?? workspaceMgr.getPrimaryRoot()?.fsPath));
    if (!rootInfo) return undefined;

    const detector = new SubProjectDetector(workspaceMgr);
    const subProjects = await detector.detect(rootInfo);

    return bridgeToOrchestrationGraph(mappingGraph, subProjects);
  }

  /**
   * Dispose a specific workspace instance.
   */
  static dispose(workspacePath: string): void {
    const instance = CodebaseMappingManager.instances.get(workspacePath);
    if (!instance) return;

    for (const d of instance.disposables) {
      d.dispose();
    }
    instance.service.dispose();
    CodebaseMappingManager.instances.delete(workspacePath);
  }

  /**
   * Dispose all instances.
   */
  static disposeAll(): void {
    for (const [path] of CodebaseMappingManager.instances) {
      CodebaseMappingManager.dispose(path);
    }
    for (const d of CodebaseMappingManager.globalDisposables) {
      d.dispose();
    }
    CodebaseMappingManager.globalDisposables = [];
  }
}
