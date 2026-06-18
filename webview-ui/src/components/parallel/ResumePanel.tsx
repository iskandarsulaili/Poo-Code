import React from "react"
import { useTranslation } from "react-i18next"

interface SavedDAG {
	correlationId: string
	status: string
	totalNodes: number
	completedNodes: number
	failedNodes: number
	timestamp: string
}

interface ResumePanelProps {
	savedDAGs: SavedDAG[]
	onResumeDAG: (correlationId: string) => void
	onDismissDAG: (correlationId: string) => void
}

const ResumePanel: React.FC<ResumePanelProps> = ({ savedDAGs, onResumeDAG, onDismissDAG }) => {
	const { t } = useTranslation()
	if (savedDAGs.length === 0) {
		return null
	}

	return (
		<div
			style={{
				border: "1px solid var(--vscode-editorWarning-foreground, #cca700)",
				borderRadius: "6px",
				padding: "12px",
				marginBottom: "12px",
				background: "var(--vscode-inputValidation-warningBackground, #352a05)",
			}}>
			<h3
				style={{
					margin: "0 0 8px 0",
					fontSize: "13px",
					color: "var(--vscode-editorWarning-foreground, #cca700)",
				}}>
				{t("parallel.resume_panel.title")}
			</h3>
			<p style={{ fontSize: "11px", color: "var(--vscode-foreground, #ccc)", margin: "0 0 8px 0" }}>
				{t("parallel.resume_panel.description")}
			</p>
			{savedDAGs.map((dag) => (
				<div
					key={dag.correlationId}
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						padding: "6px 8px",
						marginBottom: "4px",
						borderRadius: "4px",
						background: "var(--vscode-sideBar-background, #252526)",
					}}>
					<div style={{ fontSize: "11px", color: "var(--vscode-foreground, #ccc)" }}>
						<strong>{dag.correlationId}</strong> —{" "}
						{t("parallel.resume_panel.tasks_count", {
							total: dag.totalNodes,
							completed: dag.completedNodes,
							failed: dag.failedNodes,
						})}
						<br />
						<span style={{ color: "var(--vscode-descriptionForeground, #888)" }}>
							{t("parallel.resume_panel.status_prefix")} {dag.status} |{" "}
							{new Date(dag.timestamp).toLocaleString()}
						</span>
					</div>
					<div style={{ display: "flex", gap: "4px" }}>
						<button
							onClick={() => onResumeDAG(dag.correlationId)}
							style={{
								padding: "3px 10px",
								fontSize: "11px",
								background: "var(--vscode-button-background, #0e639c)",
								color: "var(--vscode-button-foreground, #fff)",
								border: "none",
								borderRadius: "3px",
								cursor: "pointer",
							}}>
							{t("parallel.resume_panel.resume_button")}
						</button>
						<button
							onClick={() => onDismissDAG(dag.correlationId)}
							style={{
								padding: "3px 10px",
								fontSize: "11px",
								background: "var(--vscode-button-secondaryBackground, #3c3c3c)",
								color: "var(--vscode-button-secondaryForeground, #ccc)",
								border: "none",
								borderRadius: "3px",
								cursor: "pointer",
							}}>
							{t("parallel.resume_panel.dismiss_button")}
						</button>
					</div>
				</div>
			))}
		</div>
	)
}

export default ResumePanel
