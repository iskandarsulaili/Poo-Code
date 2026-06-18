import React from "react"
import { useTranslation } from "react-i18next"

interface SubtaskCardProps {
	id: string
	name: string
	status: string
	mode: string
	error?: string
	startedAt?: number
	completedAt?: number
	deps: string[]
	onSelect: (id: string) => void
	isSelected: boolean
}

const statusColors: Record<string, string> = {
	pending: "var(--vscode-descriptionForeground, #888)",
	ready: "var(--vscode-textLink-foreground, #3794ff)",
	running: "var(--vscode-editorInfo-foreground, #3794ff)",
	completed: "var(--vscode-testing-iconPassed, #89d185)",
	failed: "var(--vscode-testing-iconFailed, #f48771)",
	blocked: "var(--vscode-editorWarning-foreground, #cca700)",
	skipped: "var(--vscode-descriptionForeground, #888)",
	timed_out: "var(--vscode-testing-iconFailed, #f48771)",
}

const statusIcons: Record<string, string> = {
	pending: "○",
	ready: "◉",
	running: "⟳",
	completed: "✓",
	failed: "✗",
	blocked: "⊘",
	skipped: "⏭",
	timed_out: "✗",
}

const SubtaskCard: React.FC<SubtaskCardProps> = ({
	id,
	name,
	status,
	mode,
	error,
	startedAt,
	completedAt,
	deps,
	onSelect,
	isSelected,
}) => {
	const { t } = useTranslation()
	const duration =
		startedAt && completedAt
			? `${((completedAt - startedAt) / 1000).toFixed(1)}s`
			: startedAt
				? t("parallel.subtask_card.running")
				: t("parallel.subtask_card.no_duration")

	return (
		<div
			onClick={() => onSelect(id)}
			style={{
				border: `1px solid ${isSelected ? "var(--vscode-focusBorder, #007fd4)" : "var(--vscode-panel-border, #333)"}`,
				borderRadius: "6px",
				padding: "8px 12px",
				cursor: "pointer",
				background: isSelected
					? "var(--vscode-list-activeSelectionBackground, #094771)"
					: "var(--vscode-sideBar-background, #252526)",
				transition: "border-color 0.15s, background 0.15s",
			}}>
			<div
				style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
				<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
					<span style={{ color: statusColors[status] || statusColors.pending, fontSize: "14px" }}>
						{statusIcons[status] || "?"}
					</span>
					<span style={{ fontWeight: 600, fontSize: "13px", color: "var(--vscode-foreground, #ccc)" }}>
						{name}
					</span>
				</div>
				<span
					style={{
						fontSize: "10px",
						padding: "1px 6px",
						borderRadius: "3px",
						background: "var(--vscode-badge-background, #4d4d4d)",
						color: "var(--vscode-badge-foreground, #fff)",
					}}>
					{mode}
				</span>
			</div>
			<div
				style={{
					display: "flex",
					gap: "12px",
					fontSize: "11px",
					color: "var(--vscode-descriptionForeground, #888)",
				}}>
				<span>
					{t("parallel.subtask_card.status_label")}{" "}
					<strong style={{ color: statusColors[status] }}>{status}</strong>
				</span>
				<span>
					{t("parallel.subtask_card.duration_label")} {duration}
				</span>
				{deps.length > 0 && (
					<span>
						{t("parallel.subtask_card.deps_label")} {deps.join(", ")}
					</span>
				)}
			</div>
			{error && (
				<div
					style={{
						marginTop: "4px",
						fontSize: "11px",
						color: "var(--vscode-errorForeground, #f48771)",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}>
					{t("parallel.subtask_card.error_label")} {error}
				</div>
			)}
		</div>
	)
}

export default SubtaskCard
