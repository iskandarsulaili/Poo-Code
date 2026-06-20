import React, { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

interface ThoughtEntry {
	subtaskId: string
	token: string
	sourceType?: "reasoning" | "metadata"
}

interface AgentThoughtStreamProps {
	thoughts: ThoughtEntry[]
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
	const grouped = new Map<string, ThoughtEntry[]>()
	for (const t of thoughts) {
		const existing = grouped.get(t.subtaskId) || []
		existing.push(t)
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
			{[...grouped.entries()].map(([subtaskId, entries]) => (
				<div key={subtaskId} style={{ marginBottom: "8px" }}>
					<div
						style={{
							fontWeight: "bold",
							fontSize: "11px",
							color: "var(--vscode-descriptionForeground, #888)",
							marginBottom: "4px",
						}}>
						[{subtaskId}]
					</div>
					{entries.map((entry, i) => {
						// Fix 2: Style metadata vs reasoning differently
						const isMetadata = entry.sourceType === "metadata" || entry.token.startsWith("Starting") || entry.token.startsWith("Completed") || entry.token.startsWith("Failed") || entry.token.startsWith("Executing")
						return (
							<div
								key={i}
								style={{
									color: isMetadata
										? "var(--vscode-descriptionForeground, #999)"
										: "var(--vscode-editor-foreground, #d4d4d4)",
									fontStyle: isMetadata ? "italic" : "normal",
									fontWeight: isMetadata ? 400 : 700,
									marginBottom: "2px",
									paddingLeft: "8px",
									borderLeft: isMetadata
										? "2px solid var(--vscode-descriptionForeground, #555)"
										: "2px solid var(--vscode-focusBorder, #007fd4)",
									fontSize: isMetadata ? "11px" : "12px",
								}}>
								{entry.token}
							</div>
						)
					})}
				</div>
			))}
		</div>
	)
}

export default AgentThoughtStream
