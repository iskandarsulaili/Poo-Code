import React from "react"
import { useTranslation } from "react-i18next"
import type { SubtaskNode } from "@roo-code/types"

interface DAGVisualizationProps {
	nodes: Map<string, SubtaskNode>
	waves: SubtaskNode[][]
	selectedId: string | null
	onSelectNode: (id: string) => void
}

const statusColors: Record<string, string> = {
	pending: "#888",
	ready: "#3794ff",
	running: "#3794ff",
	completed: "#89d185",
	failed: "#f48771",
	blocked: "#cca700",
	skipped: "#888",
	timed_out: "#f48771",
}

const DAGVisualization: React.FC<DAGVisualizationProps> = ({ nodes: _nodes, waves, selectedId, onSelectNode }) => {
	const { t } = useTranslation()
	if (waves.length === 0) {
		return (
			<div
				style={{
					padding: "16px",
					color: "var(--vscode-descriptionForeground, #888)",
					fontStyle: "italic",
					textAlign: "center",
				}}>
				{t("parallel.dashboard.no_dag_data")}
			</div>
		)
	}

	return (
		<div
			style={{
				overflowX: "auto",
				padding: "12px",
				background: "var(--vscode-terminal-background, #1e1e1e)",
				borderRadius: "6px",
			}}>
			<div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: "400px" }}>
				{waves.map((wave, waveIdx) => (
					<div key={waveIdx}>
						<div
							style={{
								fontSize: "11px",
								fontWeight: 600,
								color: "var(--vscode-descriptionForeground, #888)",
								marginBottom: "6px",
								textTransform: "uppercase",
								letterSpacing: "0.5px",
							}}>
							{t("parallel.dag.wave_label", { number: waveIdx + 1 })}
						</div>
						<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
							{wave.map((node) => {
								const isSelected = selectedId === node.id
								const color = statusColors[node.status] || statusColors.pending

								return (
									<div
										key={node.id}
										onClick={() => onSelectNode(node.id)}
										style={{
											display: "flex",
											flexDirection: "column",
											alignItems: "center",
											gap: "4px",
											cursor: "pointer",
											padding: "8px 12px",
											borderRadius: "6px",
											border: `2px solid ${isSelected ? "var(--vscode-focusBorder, #007fd4)" : "transparent"}`,
											background: isSelected
												? "var(--vscode-list-activeSelectionBackground, #094771)"
												: "var(--vscode-sideBar-background, #252526)",
											transition: "all 0.15s",
											minWidth: "80px",
										}}>
										<div
											style={{
												width: "32px",
												height: "32px",
												borderRadius: "50%",
												background: color,
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												color: "#fff",
												fontSize: "14px",
												fontWeight: "bold",
												opacity: node.status === "pending" ? 0.5 : 1,
											}}>
											{node.id.charAt(0).toUpperCase()}
										</div>
										<div
											style={{
												fontSize: "10px",
												color: "var(--vscode-foreground, #ccc)",
												textAlign: "center",
												maxWidth: "80px",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
											}}>
											{node.name || node.id}
										</div>
										<div style={{ fontSize: "9px", color, fontWeight: 600 }}>{node.status}</div>
									</div>
								)
							})}
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

export default DAGVisualization
