import React, { useState, useEffect, useMemo } from "react"
import { Network } from "lucide-react"

import type { CodebaseMappingStatus } from "@roo-code/types"

import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { PopoverTrigger, StandardTooltip, Button } from "@src/components/ui"

import { CodebaseMappingPopover } from "./CodebaseMappingPopover"

interface CodebaseMappingStatusBadgeProps {
	className?: string
}

export const CodebaseMappingStatusBadge: React.FC<CodebaseMappingStatusBadgeProps> = ({ className }) => {
	const { cwd } = useExtensionState()

	const [mappingStatus, setMappingStatus] = useState<CodebaseMappingStatus>({
		status: "idle",
		fileCount: 0,
		edgeCount: 0,
		deadSymbolCount: 0,
		cacheHitRate: 0,
	})

	useEffect(() => {
		// Request initial status
		vscode.postMessage({ type: "requestCodebaseMappingStatus" })

		// Listen for status updates
		const handleMessage = (event: MessageEvent<any>) => {
			if (event.data.type === "codebaseMappingStatusUpdate") {
				setMappingStatus(event.data.values)
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [cwd])

	const tooltipText = useMemo(() => {
		switch (mappingStatus.status) {
			case "idle":
				return "Codebase mapping: Idle"
			case "scanning":
				return "Codebase mapping: Scanning..."
			case "ready":
				return `Codebase mapping: ${mappingStatus.fileCount} files, ${mappingStatus.edgeCount} edges`
			case "error":
				return `Codebase mapping: Error${mappingStatus.message ? ` - ${mappingStatus.message}` : ""}`
			default:
				return "Codebase mapping"
		}
	}, [mappingStatus])

	const statusColorClass = useMemo(() => {
		switch (mappingStatus.status) {
			case "scanning":
				return "bg-yellow-500 animate-pulse"
			case "ready":
				return "bg-green-500"
			case "error":
				return "bg-red-500"
			default:
				return "bg-vscode-descriptionForeground/60"
		}
	}, [mappingStatus.status])

	return (
		<CodebaseMappingPopover mappingStatus={mappingStatus}>
			<StandardTooltip content={tooltipText}>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						aria-label={tooltipText}
						className={cn(
							"relative h-5 w-5 p-0",
							"text-vscode-foreground opacity-85",
							"hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)]",
							"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
							className,
						)}>
						<Network className="w-4 h-4" />
						<span
							className={cn(
								"absolute top-0 right-0 w-1.5 h-1.5 rounded-full transition-colors duration-200",
								statusColorClass,
							)}
						/>
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
		</CodebaseMappingPopover>
	)
}
