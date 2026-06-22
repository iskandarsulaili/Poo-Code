import React, { useState, useEffect, useMemo } from "react"
import { BookMarked } from "lucide-react"

import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"

import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, Button } from "@src/components/ui"

interface MemoryBankStatus {
	exists: boolean
	initializing?: boolean
	fileCount: number
	totalSizeKB: number
	lastUpdated: string | null
}

export const MemoryBankStatusBadge: React.FC<{ className?: string }> = ({ className }) => {
	const [open, setOpen] = useState(false)
	const [status, setStatus] = useState<MemoryBankStatus>({
		exists: false,
		initializing: true,
		fileCount: 0,
		totalSizeKB: 0,
		lastUpdated: null,
	})

	useEffect(() => {
		vscode.postMessage({ type: "requestMemoryBankStatus" })

		const handleMessage = (event: MessageEvent<any>) => {
			if (event.data.type === "memoryBankStatusUpdate") {
				setStatus(event.data.values)
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestMemoryBankStatus" })
		}
	}, [open])

	const statusColorClass = useMemo(() => {
		if (status.initializing && !status.exists) return "bg-yellow-500 animate-pulse"
		if (!status.exists) return "bg-vscode-descriptionForeground/60"
		return "bg-green-500"
	}, [status.exists, status.initializing])

	const tooltipText = status.initializing && !status.exists
		? "Memory Bank: Initializing..."
		: status.exists
		? `Memory Bank: ${status.fileCount} files, ${status.totalSizeKB.toFixed(0)}KB`
		: "Memory Bank: Not initialized"

	return (
		<Popover open={open} onOpenChange={setOpen}>
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
						<BookMarked className="w-4 h-4" />
						<span
							className={cn(
								"absolute top-0 right-0 w-1.5 h-1.5 rounded-full transition-colors duration-200",
								statusColorClass,
							)}
						/>
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				className="w-[calc(100vw-32px)] max-w-[320px] p-0"
				align="end"
				alignOffset={0}
				side="bottom"
				sideOffset={5}
				collisionPadding={16}
				avoidCollisions={true}>
				<div className="p-3 border-b border-vscode-dropdown-border">
					<h4 className="m-0 text-sm font-medium">Memory Bank</h4>
				</div>
				<div className="p-4 space-y-2 text-sm">
					<div className="flex items-center gap-2">
						<span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColorClass}`} />
						<span>{status.initializing && !status.exists ? "Initializing..." : status.exists ? "Active" : "Not initialized"}</span>
					</div>
					{status.exists && (
						<>
							<div className="text-vscode-descriptionForeground">
								Files: {status.fileCount}
							</div>
							<div className="text-vscode-descriptionForeground">
								Total size: {status.totalSizeKB.toFixed(0)} KB
							</div>
							{status.lastUpdated && (
								<div className="text-vscode-descriptionForeground">
									Last updated: {status.lastUpdated}
								</div>
							)}
							<div className="mt-2 flex gap-2">
								<Button
									variant="secondary"
									size="sm"
									onClick={() => vscode.postMessage({ type: "openMemoryBank" })}
									className="flex items-center gap-1 text-xs">
									Open
								</Button>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => vscode.postMessage({ type: "initMemoryBank" })}
									className="flex items-center gap-1 text-xs">
									Init
								</Button>
							</div>
						</>
					)}
					{!status.exists && (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => vscode.postMessage({ type: "initMemoryBank" })}
							className="flex items-center gap-1 text-xs">
							Initialize
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
