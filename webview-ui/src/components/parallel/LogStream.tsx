import React, { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

interface LogEntry {
	subtaskId: string
	level: "debug" | "info" | "warn" | "error"
	message: string
	timestamp: string
}

interface LogStreamProps {
	logs: LogEntry[]
	maxHeight?: string
}

const levelColors: Record<string, string> = {
	debug: "var(--vscode-textPreformat-foreground, #888)",
	info: "var(--vscode-terminal-foreground, #ccc)",
	warn: "var(--vscode-editorWarning-foreground, #cca700)",
	error: "var(--vscode-errorForeground, #f48771)",
}

const LogStream: React.FC<LogStreamProps> = ({ logs, maxHeight = "300px" }) => {
	const { t } = useTranslation()
	const containerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight
		}
	}, [logs])

	if (logs.length === 0) {
		return (
			<div
				style={{
					color: "var(--vscode-descriptionForeground, #888)",
					fontStyle: "italic",
					padding: "8px",
					fontSize: "12px",
				}}>
				{t("parallel.dashboard.no_logs")}
			</div>
		)
	}

	return (
		<div
			ref={containerRef}
			style={{
				maxHeight,
				overflowY: "auto",
				fontFamily: "var(--vscode-editor-font-family, monospace)",
				fontSize: "11px",
				lineHeight: "1.4",
				background: "var(--vscode-terminal-background, #1e1e1e)",
				color: "var(--vscode-terminal-foreground, #ccc)",
				borderRadius: "4px",
				padding: "4px 0",
			}}>
			{logs.map((entry, idx) => (
				<div
					key={idx}
					style={{
						padding: "1px 8px",
						color: levelColors[entry.level] || levelColors.info,
						whiteSpace: "pre-wrap",
						wordBreak: "break-all",
					}}>
					<span style={{ opacity: 0.6, marginRight: "8px" }}>
						{new Date(entry.timestamp).toLocaleTimeString()}
					</span>
					<span style={{ fontWeight: "bold", marginRight: "8px" }}>[{entry.subtaskId || "system"}]</span>
					<span>{entry.message}</span>
				</div>
			))}
		</div>
	)
}

export default LogStream
