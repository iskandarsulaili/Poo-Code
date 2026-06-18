import React, { useCallback, useEffect, useRef } from "react"
import { X } from "lucide-react"

import ParallelDashboard from "./ParallelDashboard"

interface ParallelOverlayProps {
	open: boolean
	onClose: () => void
}

const ParallelOverlay: React.FC<ParallelOverlayProps> = ({ open, onClose }) => {
	const overlayRef = useRef<HTMLDivElement>(null)

	// Close on Escape key
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose()
			}
		},
		[onClose],
	)

	useEffect(() => {
		if (open) {
			document.addEventListener("keydown", handleKeyDown)
		}
		return () => {
			document.removeEventListener("keydown", handleKeyDown)
		}
	}, [open, handleKeyDown])

	// Close on backdrop click
	const handleBackdropClick = useCallback(
		(e: React.MouseEvent) => {
			if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
				onClose()
			}
		},
		[onClose],
	)

	if (!open) {
		return null
	}

	return (
		<div
			onClick={handleBackdropClick}
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 1000,
				background: "rgba(0, 0, 0, 0.5)",
				display: "flex",
				justifyContent: "flex-end",
				animation: "parallelOverlayFadeIn 0.15s ease-out",
			}}>
			<div
				ref={overlayRef}
				style={{
					width: "80%",
					maxWidth: "800px",
					height: "100%",
					background: "var(--vscode-sideBar-background, #252526)",
					borderLeft: "1px solid var(--vscode-panel-border, #333)",
					display: "flex",
					flexDirection: "column",
					animation: "parallelOverlaySlideIn 0.2s ease-out",
					boxShadow: "-4px 0 12px rgba(0, 0, 0, 0.3)",
				}}>
				{/* Overlay header with close button */}
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						alignItems: "center",
						padding: "4px 8px",
						borderBottom: "1px solid var(--vscode-panel-border, #333)",
						flexShrink: 0,
					}}>
					<button
						onClick={onClose}
						aria-label="Close parallel dashboard"
						style={{
							background: "none",
							border: "none",
							color: "var(--vscode-foreground, #ccc)",
							cursor: "pointer",
							padding: "4px",
							borderRadius: "4px",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							opacity: 0.7,
						}}
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLButtonElement).style.opacity = "1"
							;(e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLButtonElement).style.opacity = "0.7"
							;(e.currentTarget as HTMLButtonElement).style.background = "none"
						}}>
						<X size={18} />
					</button>
				</div>

				{/* Scrollable dashboard content */}
				<div style={{ flex: 1, overflow: "hidden" }}>
					<ParallelDashboard />
				</div>
			</div>
		</div>
	)
}

export default ParallelOverlay
