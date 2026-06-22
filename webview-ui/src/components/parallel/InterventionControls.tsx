import React from "react"
import { useTranslation } from "react-i18next"

interface InterventionControlsProps {
	subtaskId: string
	status: string
	onPause: (id: string) => void
	onResume: (id: string) => void
	onCancel: (id: string) => void
	onRetry: (id: string) => void
	onSkip: (id: string) => void
}

const buttonStyle: React.CSSProperties = {
	padding: "2px 8px",
	fontSize: "11px",
	border: "1px solid var(--vscode-button-border, transparent)",
	borderRadius: "3px",
	cursor: "pointer",
	marginRight: "4px",
}

const InterventionControls: React.FC<InterventionControlsProps> = ({
	subtaskId,
	status,
	onPause,
	onResume,
	onCancel,
	onRetry,
	onSkip,
}) => {
	const { t } = useTranslation()
	const isRunning = status === "running"
	const isPending = status === "pending" || status === "ready"
	const isFailed = status === "failed" || status === "timed_out"
	const isSkipped = status === "skipped" || status === "blocked"

	return (
		<div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
			{isRunning && (
				<button
					style={{
						...buttonStyle,
						background: "var(--vscode-button-secondaryBackground, #3c3c3c)",
						color: "var(--vscode-button-secondaryForeground, #ccc)",
					}}
					onClick={() => onPause(subtaskId)}
					title={t("parallel.intervention.pause_title")}>
					⏸ {t("parallel.intervention.pause")}
				</button>
			)}
			{(isPending || isSkipped) && (
				<button
					style={{
						...buttonStyle,
						background: "var(--vscode-button-background, #0e639c)",
						color: "var(--vscode-button-foreground, #fff)",
					}}
					onClick={() => onResume(subtaskId)}
					title={t("parallel.intervention.resume_title")}>
					▶ {t("parallel.intervention.resume")}
				</button>
			)}
			{(isRunning || isPending) && (
				<button
					style={{ ...buttonStyle, background: "#c72e2e", color: "#fff" }}
					onClick={() => onCancel(subtaskId)}
					title={t("parallel.intervention.cancel_title")}>
					✕ {t("parallel.intervention.cancel")}
				</button>
			)}
			{isFailed && (
				<button
					style={{ ...buttonStyle, background: "#d4a017", color: "#fff" }}
					onClick={() => onRetry(subtaskId)}
					title={t("parallel.intervention.retry_title")}>
					↻ {t("parallel.intervention.retry")}
				</button>
			)}
			{(isPending || isFailed) && (
				<button
					style={{
						...buttonStyle,
						background: "var(--vscode-button-secondaryBackground, #3c3c3c)",
						color: "var(--vscode-button-secondaryForeground, #ccc)",
					}}
					onClick={() => onSkip(subtaskId)}
					title={t("parallel.intervention.skip_title")}>
					⏭ {t("parallel.intervention.skip")}
				</button>
			)}
		</div>
	)
}

export default InterventionControls
