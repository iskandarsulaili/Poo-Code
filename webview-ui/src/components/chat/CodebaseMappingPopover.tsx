import React, { useState, useEffect, useMemo } from "react"
import { GitBranch, RefreshCw, FileText, Share2 } from "lucide-react"

import type { CodebaseMappingStatus } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Popover, PopoverContent, StandardTooltip, Button } from "@src/components/ui"
import { useRooPortal } from "@src/components/ui/hooks/useRooPortal"

interface CodebaseMappingPopoverProps {
	children: React.ReactNode
	mappingStatus: CodebaseMappingStatus
}

export const CodebaseMappingPopover: React.FC<CodebaseMappingPopoverProps> = ({
	children,
	mappingStatus: externalMappingStatus,
}) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [mappingStatus, setMappingStatus] = useState<CodebaseMappingStatus>(externalMappingStatus)

	// Sync external status
	useEffect(() => {
		setMappingStatus(externalMappingStatus)
	}, [externalMappingStatus])

	// Request status when popover opens
	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestCodebaseMappingStatus" })
		}
	}, [open])

	// Listen for status updates
	useEffect(() => {
		const handleMessage = (event: MessageEvent<any>) => {
			if (event.data.type === "codebaseMappingStatusUpdate") {
				setMappingStatus(event.data.values)
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const portalContainer = useRooPortal("roo-portal")

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

	const handleRefresh = () => {
		vscode.postMessage({ type: "refreshCodebaseMap" })
	}

	const handleShow = () => {
		vscode.postMessage({ type: "showCodebaseMap" })
	}

	const handleExport = () => {
		vscode.postMessage({ type: "exportCodebaseMap" })
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			{children}
			<PopoverContent
				className="w-[calc(100vw-32px)] max-w-[400px] max-h-[80vh] overflow-y-auto p-0"
				align="end"
				alignOffset={0}
				side="bottom"
				sideOffset={5}
				collisionPadding={16}
				avoidCollisions={true}
				container={portalContainer}>
				<div className="p-3 border-b border-vscode-dropdown-border cursor-default">
					<div className="flex flex-row items-center gap-1 p-0 mt-0 mb-1 w-full">
						<h4 className="m-0 pb-2 flex-1">Codebase Mapping</h4>
					</div>
					<p className="my-0 pr-4 text-sm w-full text-vscode-descriptionForeground">
						AST-based dependency graph, symbol extraction, and dead code detection.
					</p>
				</div>

				<div className="p-4">
					{/* Status Section */}
					<div className="space-y-2 mb-4">
						<h4 className="text-sm font-medium">Status</h4>
						<div className="text-sm text-vscode-descriptionForeground">
							<span className={`inline-block w-3 h-3 rounded-full mr-2 ${statusColorClass}`} />
							{mappingStatus.status === "idle" && "Idle"}
							{mappingStatus.status === "scanning" && "Scanning..."}
							{mappingStatus.status === "ready" && "Ready"}
							{mappingStatus.status === "error" &&
								`Error${mappingStatus.message ? `: ${mappingStatus.message}` : ""}`}
							{mappingStatus.message && mappingStatus.status !== "error"
								? ` - ${mappingStatus.message}`
								: ""}
						</div>
						{/* Progress bar: visible when scanning and totalFileCount is known */}
						{mappingStatus.status === "scanning" &&
							mappingStatus.totalFileCount != null &&
							mappingStatus.totalFileCount > 0 && (
								<div className="w-full h-1.5 bg-vscode-dropdown-border rounded-full overflow-hidden mt-1">
									<div
										className="h-full bg-vscode-statusBarItem-prominentForeground rounded-full transition-all duration-300 ease-out"
										style={{
											width: `${Math.min(
												100,
												Math.round(
													(mappingStatus.fileCount / mappingStatus.totalFileCount) * 100,
												),
											)}%`,
										}}
									/>
								</div>
							)}
					</div>

					{/* Stats Section */}
					<div className="space-y-2 mb-4">
						<h4 className="text-sm font-medium">Stats</h4>
						<div className="grid grid-cols-2 gap-2 text-sm">
							<div className="flex items-center gap-2">
								<FileText className="w-4 h-4 text-vscode-descriptionForeground" />
								<span>Files: {mappingStatus.fileCount}</span>
							</div>
							<div className="flex items-center gap-2">
								<GitBranch className="w-4 h-4 text-vscode-descriptionForeground" />
								<span>Edges: {mappingStatus.edgeCount}</span>
							</div>
							<div className="flex items-center gap-2 col-span-2">
								<span className="text-vscode-descriptionForeground">
									Dead symbols: {mappingStatus.deadSymbolCount}
								</span>
							</div>
							<div className="flex items-center gap-2 col-span-2">
								<span className="text-vscode-descriptionForeground">
									Cache hit rate: {(mappingStatus.cacheHitRate * 100).toFixed(1)}%
								</span>
							</div>
						</div>
					</div>

					{/* Actions */}
					<div className="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={handleRefresh}
							disabled={mappingStatus.status === "scanning"}
							className="flex items-center gap-1">
							<RefreshCw
								className={`w-3.5 h-3.5 ${mappingStatus.status === "scanning" ? "animate-spin" : ""}`}
							/>
							Refresh
						</Button>
						<Button variant="secondary" size="sm" onClick={handleShow} className="flex items-center gap-1">
							<FileText className="w-3.5 h-3.5" />
							Show
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={handleExport}
							className="flex items-center gap-1">
							<Share2 className="w-3.5 h-3.5" />
							Export
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
