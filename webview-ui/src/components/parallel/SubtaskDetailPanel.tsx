import React from "react"
import { useTranslation } from "react-i18next"
import _SubtaskCard from "./SubtaskCard"
import type { SubtaskNode } from "@roo-code/types"

interface SubtaskDetailPanelProps {
	subtask: SubtaskNode | null
	onClose: () => void
}

const SubtaskDetailPanel: React.FC<SubtaskDetailPanelProps> = ({ subtask, onClose }) => {
	const { t } = useTranslation()
	if (!subtask) {
		return (
			<div
				style={{
					padding: "16px",
					color: "var(--vscode-descriptionForeground, #888)",
					fontStyle: "italic",
					textAlign: "center",
				}}>
				{t("parallel.detail_panel.select_hint")}
			</div>
		)
	}

	return (
		<div
			style={{
				border: "1px solid var(--vscode-panel-border, #333)",
				borderRadius: "6px",
				padding: "12px",
				background: "var(--vscode-sideBar-background, #252526)",
			}}>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "12px",
				}}>
				<h3 style={{ margin: 0, fontSize: "14px", color: "var(--vscode-foreground, #ccc)" }}>
					{subtask.name} ({subtask.id})
				</h3>
				<button
					onClick={onClose}
					style={{
						background: "none",
						border: "none",
						color: "var(--vscode-foreground, #ccc)",
						cursor: "pointer",
						fontSize: "16px",
					}}>
					✕
				</button>
			</div>

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "1fr 1fr",
					gap: "8px",
					fontSize: "12px",
					marginBottom: "12px",
				}}>
				<div>
					<span style={{ color: "var(--vscode-descriptionForeground, #888)" }}>
						{t("parallel.detail_panel.mode_label")}{" "}
					</span>
					<span style={{ color: "var(--vscode-foreground, #ccc)" }}>{subtask.mode}</span>
				</div>
				<div>
					<span style={{ color: "var(--vscode-descriptionForeground, #888)" }}>
						{t("parallel.detail_panel.status_label")}{" "}
					</span>
					<span style={{ color: "var(--vscode-foreground, #ccc)" }}>{subtask.status}</span>
				</div>
				<div>
					<span style={{ color: "var(--vscode-descriptionForeground, #888)" }}>
						{t("parallel.detail_panel.deps_label")}{" "}
					</span>
					<span style={{ color: "var(--vscode-foreground, #ccc)" }}>
						{subtask.deps.join(", ") || t("parallel.detail_panel.no_deps")}
					</span>
				</div>
				<div>
					<span style={{ color: "var(--vscode-descriptionForeground, #888)" }}>
						{t("parallel.detail_panel.tokens_label")}{" "}
					</span>
					<span style={{ color: "var(--vscode-foreground, #ccc)" }}>{subtask.estimatedTokens}</span>
				</div>
			</div>

			<div style={{ marginBottom: "12px" }}>
				<h4
					style={{
						margin: "0 0 4px 0",
						fontSize: "12px",
						color: "var(--vscode-descriptionForeground, #888)",
					}}>
					{t("parallel.detail_panel.prompt_label")}
				</h4>
				<div
					style={{
						fontSize: "11px",
						color: "var(--vscode-foreground, #ccc)",
						background: "var(--vscode-terminal-background, #1e1e1e)",
						padding: "8px",
						borderRadius: "4px",
						maxHeight: "120px",
						overflowY: "auto",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
					}}>
					{subtask.prompt}
				</div>
			</div>

			{subtask.metadata.error && (
				<div style={{ marginBottom: "12px" }}>
					<h4
						style={{
							margin: "0 0 4px 0",
							fontSize: "12px",
							color: "var(--vscode-errorForeground, #f48771)",
						}}>
						{t("parallel.detail_panel.error_label")}
					</h4>
					<div
						style={{
							fontSize: "11px",
							color: "var(--vscode-errorForeground, #f48771)",
							background: "var(--vscode-inputValidation-errorBackground, #5a1d1d)",
							padding: "8px",
							borderRadius: "4px",
						}}>
						{subtask.metadata.error}
					</div>
				</div>
			)}

			<div
				style={{
					display: "flex",
					gap: "8px",
					fontSize: "11px",
					color: "var(--vscode-descriptionForeground, #888)",
				}}>
				{subtask.inputFiles.length > 0 && (
					<span>
						{t("parallel.detail_panel.inputs_label")} {subtask.inputFiles.join(", ")}
					</span>
				)}
				{subtask.outputFiles.length > 0 && (
					<span>
						{t("parallel.detail_panel.outputs_label")} {subtask.outputFiles.join(", ")}
					</span>
				)}
			</div>
		</div>
	)
}

export default SubtaskDetailPanel
