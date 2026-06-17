import React, { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

interface AgentThoughtStreamProps {
	thoughts: Array<{ subtaskId: string; token: string }>
	maxHeight?: string
}

const AgentThoughtStream: React.FC<AgentThoughtStreamProps> = ({ thoughts, maxHeight = "200px" }) => {
	const { t } = useTranslation()
	const containerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight
		}
	}, [thoughts])

	if (thoughts.length === 0) {
		return (
			<div
				style={{
					color: "var(--vscode-descriptionForeground, #888)",
					fontStyle: "italic",
					padding: "8px",
					fontSize: "12px",
				}}>
				{t("parallel.dashboard.no_thoughts")}
			</div>
		)
	}

	// Group thoughts by subtaskId
	const grouped = new Map<string, string[]>()
	for (const t of thoughts) {
		const existing = grouped.get(t.subtaskId) || []
		existing.push(t.token)
		grouped.set(t.subtaskId, existing)
	}

	return (
		<div
			ref={containerRef}
			style={{
				maxHeight,
				overflowY: "auto",
				fontFamily: "var(--vscode-editor-font-family, monospace)",
				fontSize: "12px",
				lineHeight: "1.5",
				background: "var(--vscode-terminal-background, #1e1e1e)",
				color: "var(--vscode-terminal-foreground, #ccc)",
				borderRadius: "4px",
				padding: "8px",
			}}>
			{[...grouped.entries()].map(([subtaskId, tokens]) => (
				<div key={subtaskId} style={{ marginBottom: "8px" }}>
					<div
						style={{
							fontWeight: "bold",
							fontSize: "11px",
							color: "var(--vscode-textLink-foreground, #3794ff)",
							marginBottom: "2px",
						}}>
						[{subtaskId}]
					</div>
					<div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{tokens.join("")}</div>
				</div>
			))}
		</div>
	)
}

export default AgentThoughtStream
