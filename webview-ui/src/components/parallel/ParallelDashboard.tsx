import React, { useCallback, useRef, useState } from "react"
import { useEvent } from "react-use"
import { useTranslation } from "react-i18next"
import type { ExtensionMessage, SubtaskNode, SubtaskDAG } from "@roo-code/types"

import { vscode } from "../../utils/vscode"
import DAGVisualization from "./DAGVisualization"
import SubtaskCard from "./SubtaskCard"
import SubtaskDetailPanel from "./SubtaskDetailPanel"
import LogStream from "./LogStream"
import AgentThoughtStream from "./AgentThoughtStream"
import InterventionControls from "./InterventionControls"
import ResumePanel from "./ResumePanel"

// ============================================================================
// Types
// ============================================================================

interface LogEntry {
	subtaskId: string
	level: "debug" | "info" | "warn" | "error"
	message: string
	timestamp: string
}

interface ThoughtEntry {
	subtaskId: string
	token: string
	sourceType?: "reasoning" | "metadata"
}

interface SavedDAG {
	correlationId: string
	status: string
	totalNodes: number
	completedNodes: number
	failedNodes: number
	timestamp: string
}

type DashboardTab = "subtasks" | "child-tasks" | "dag" | "logs"

// ============================================================================
// ParallelDashboard
// ============================================================================

const ParallelDashboard: React.FC = () => {
	const { t } = useTranslation()
	const [activeTab, setActiveTab] = useState<DashboardTab>("subtasks")
	const [dag, setDag] = useState<SubtaskDAG | null>(null)
	const [selectedSubtaskId, setSelectedSubtaskId] = useState<string | null>(null)
	const [logs, setLogs] = useState<LogEntry[]>([])
	const [thoughts, setThoughts] = useState<ThoughtEntry[]>([])
	const [savedDAGs, setSavedDAGs] = useState<SavedDAG[]>([])
	const [_progress, setProgress] = useState<{ subtaskId: string; tokenPercent: number; filesModified: number } | null>(
		null,
	)

	const logsRef = useRef<LogEntry[]>([])
	logsRef.current = logs

	const thoughtsRef = useRef<ThoughtEntry[]>([])
	thoughtsRef.current = thoughts

	// ========================================================================
	// Message handler
	// ========================================================================

	const onMessage = useCallback((e: MessageEvent) => {
		const message: ExtensionMessage = e.data

		switch (message.type) {
			case "parallelSubtaskStatus": {
				const raw = message.payload as any
				if (raw && typeof raw === "object") {
					// Convert serialized plain objects back to Maps
					// (JSON.stringify loses Map entries, so extension sends plain objects)
					const nodes = new Map<string, SubtaskNode>(
						Object.entries(raw.nodes || {}).map(([k, v]) => [k, v as SubtaskNode]),
					)
					const edges = new Map<string, Set<string>>(
						Object.entries(raw.edges || {}).map(([k, v]) => [k, new Set(v as string[])]),
					)
					setDag({
						nodes,
						edges,
						waves: raw.waves || [],
						status: raw.status || "pending",
					})
				}
				break
			}
			case "parallelSubtaskLog": {
				const entry = message.payload as LogEntry
				if (entry) {
					setLogs((prev) => [...prev, entry])
				}
				break
			}
			case "parallelSubtaskThought": {
				const thought = message.payload as ThoughtEntry
				if (thought) {
					setThoughts((prev) => [...prev, thought])
				}
				break
			}
			case "parallelSubtaskProgress": {
				const prog = message.payload as { subtaskId: string; tokenPercent: number; filesModified: number }
				setProgress(prog)
				break
			}
			case "parallelSubtaskSavedDAGs": {
				const dags = message.payload as SavedDAG[]
				setSavedDAGs(dags || [])
				break
			}
		}
	}, [])

	useEvent("message", onMessage)

	// ========================================================================
	// Actions
	// ========================================================================

	const handlePause = useCallback((id: string) => {
		vscode.postMessage({ type: "parallelSubtaskPause", text: id })
	}, [])

	const handleResume = useCallback((id: string) => {
		vscode.postMessage({ type: "parallelSubtaskResume", text: id })
	}, [])

	const handleCancel = useCallback((id: string) => {
		vscode.postMessage({ type: "parallelSubtaskCancel", text: id })
	}, [])

	const handleRetry = useCallback((id: string) => {
		vscode.postMessage({ type: "parallelSubtaskRetry", text: id })
	}, [])

	const handleSkip = useCallback((id: string) => {
		vscode.postMessage({ type: "parallelSubtaskSkip", text: id })
	}, [])

	const handleResumeDAG = useCallback((correlationId: string) => {
		vscode.postMessage({ type: "parallelSubtaskResumeDAG", text: correlationId })
	}, [])

	const handleDismissDAG = useCallback((correlationId: string) => {
		setSavedDAGs((prev) => prev.filter((d) => d.correlationId !== correlationId))
	}, [])

	// ========================================================================
	// Derived data
	// ========================================================================

	const nodes = dag?.nodes ?? new Map<string, SubtaskNode>()
	const waves = dag?.waves ?? []
	const nodeList = [...nodes.values()]
	// Fix 5: Filter by source tool — subtask tab vs child-tasks tab
	const subtaskNodes = nodeList.filter((n) => n.source === "execute_parallel_subtask" || !n.source)
	const childTaskNodes = nodeList.filter((n) => n.source === "execute_parallel_child_task")
	const selectedNode = selectedSubtaskId ? (nodes.get(selectedSubtaskId) ?? null) : null

	const completedCount = nodeList.filter((n) => n.status === "completed").length
	const failedCount = nodeList.filter((n) => n.status === "failed" || n.status === "timed_out").length
	const runningCount = nodeList.filter((n) => n.status === "running").length
	const totalCount = nodeList.length

	// ========================================================================
	// Render
	// ========================================================================

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100%",
				background: "var(--vscode-sideBar-background, #252526)",
				color: "var(--vscode-foreground, #ccc)",
				fontSize: "13px",
			}}>
			{/* Header */}
			<div
				style={{
					padding: "8px 12px",
					borderBottom: "1px solid var(--vscode-panel-border, #333)",
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
				}}>
				<h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>{t("parallel.dashboard.title")}</h2>
				<div style={{ display: "flex", gap: "8px", fontSize: "11px" }}>
					<span style={{ color: "#89d185" }}>✓ {completedCount}</span>
					<span style={{ color: "#3794ff" }}>⟳ {runningCount}</span>
					<span style={{ color: "#f48771" }}>✗ {failedCount}</span>
					<span style={{ color: "var(--vscode-descriptionForeground, #888)" }}>○ {totalCount}</span>
				</div>
			</div>

			{/* Resume Panel */}
			<ResumePanel savedDAGs={savedDAGs} onResumeDAG={handleResumeDAG} onDismissDAG={handleDismissDAG} />

			{/* Tab Bar */}
			<div
				style={{
					display: "flex",
					borderBottom: "1px solid var(--vscode-panel-border, #333)",
					padding: "0 8px",
				}}>
				{(["subtasks", "child-tasks", "dag", "logs"] as const).map((tab) => (
					<button
						key={tab}
						onClick={() => setActiveTab(tab)}
						style={{
							padding: "6px 12px",
							fontSize: "12px",
							background: "none",
							border: "none",
							borderBottom:
								activeTab === tab
									? "2px solid var(--vscode-focusBorder, #007fd4)"
									: "2px solid transparent",
							color:
								activeTab === tab
									? "var(--vscode-foreground, #ccc)"
									: "var(--vscode-descriptionForeground, #888)",
							cursor: "pointer",
							fontWeight: activeTab === tab ? 600 : 400,
						}}>
						{tab === "subtasks"
							? t("parallel.dashboard.tab_subtasks")
							: tab === "child-tasks"
								? t("parallel.dashboard.tab_child_tasks")
								: tab === "dag"
									? t("parallel.dashboard.tab_dag")
									: t("parallel.dashboard.tab_logs")}
					</button>
				))}
			</div>

			{/* Content */}
			<div style={{ flex: 1, overflow: "auto", padding: "8px" }}>
				{/* Subtasks Tab (Fix 5: filtered to subtask nodes) */}
				{activeTab === "subtasks" && (
					<div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
						{subtaskNodes.length === 0 && (
							<div
								style={{
									padding: "16px",
									textAlign: "center",
									color: "var(--vscode-descriptionForeground, #888)",
									fontStyle: "italic",
								}}>
								{t("parallel.dashboard.no_subtasks")}
							</div>
						)}
						{subtaskNodes.map((node) => (
							<div key={node.id}>
								<SubtaskCard
									id={node.id}
									name={node.name || node.id}
									status={node.status}
									mode={node.mode}
									error={node.metadata?.error}
									startedAt={node.metadata?.startedAt}
									completedAt={node.metadata?.completedAt}
									deps={node.deps}
									onSelect={setSelectedSubtaskId}
									isSelected={selectedSubtaskId === node.id}
								/>
								{selectedSubtaskId === node.id && (
									<div style={{ marginTop: "4px", marginLeft: "12px" }}>
										<InterventionControls
											subtaskId={node.id}
											status={node.status}
											onPause={handlePause}
											onResume={handleResume}
											onCancel={handleCancel}
											onRetry={handleRetry}
											onSkip={handleSkip}
										/>
									</div>
								)}
							</div>
						))}
					</div>
				)}

				{/* Child Tasks Tab (Fix 5: filtered to child task nodes) */}
				{activeTab === "child-tasks" && (
					<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
						{childTaskNodes.length === 0 && (
							<div
								style={{
									padding: "16px",
									textAlign: "center",
									color: "var(--vscode-descriptionForeground, #888)",
									fontStyle: "italic",
								}}>
								{t("parallel.dashboard.no_child_tasks")}
							</div>
						)}
						{childTaskNodes.map((node) => (
							<div key={node.id}>
								<SubtaskCard
									id={node.id}
									name={node.name || node.id}
									status={node.status}
									mode={node.mode}
									error={node.metadata?.error}
									startedAt={node.metadata?.startedAt}
									completedAt={node.metadata?.completedAt}
									deps={node.deps}
									onSelect={setSelectedSubtaskId}
									isSelected={selectedSubtaskId === node.id}
								/>
								{selectedSubtaskId === node.id && (
									<div style={{ marginTop: "8px" }}>
										<SubtaskDetailPanel
											subtask={selectedNode}
											onClose={() => setSelectedSubtaskId(null)}
										/>
									</div>
								)}
							</div>
						))}
					</div>
				)}

				{/* DAG Tab */}
				{activeTab === "dag" && (
					<div>
						<DAGVisualization
							nodes={nodes}
							waves={waves}
							selectedId={selectedSubtaskId}
							onSelectNode={setSelectedSubtaskId}
						/>
						{selectedNode && (
							<div style={{ marginTop: "8px" }}>
								<SubtaskDetailPanel subtask={selectedNode} onClose={() => setSelectedSubtaskId(null)} />
							</div>
						)}
					</div>
				)}

				{/* Logs Tab */}
				{activeTab === "logs" && (
					<div>
						<div style={{ marginBottom: "8px" }}>
							<h3
								style={{
									margin: "0 0 4px 0",
									fontSize: "12px",
									color: "var(--vscode-descriptionForeground, #888)",
								}}>
								{t("parallel.dashboard.agent_thoughts")}
							</h3>
							<AgentThoughtStream thoughts={thoughts} maxHeight="150px" />
						</div>
						<div>
							<h3
								style={{
									margin: "0 0 4px 0",
									fontSize: "12px",
									color: "var(--vscode-descriptionForeground, #888)",
								}}>
								{t("parallel.dashboard.system_logs")}
							</h3>
							<LogStream logs={logs} maxHeight="400px" />
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

export default ParallelDashboard
