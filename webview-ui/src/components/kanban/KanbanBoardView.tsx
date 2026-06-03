import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

// ─── Shared Types (mirrored from services/kanban/types.ts) ─────────────────

type CardStatus = "todo" | "in_progress" | "in_review" | "done" | "blocked"
type CardPriority = "low" | "medium" | "high" | "critical"
type BoardStatus = "active" | "completed" | "archived"

interface KanbanCard {
	id: string
	boardId: string
	title: string
	description?: string
	status: CardStatus
	priority: CardPriority
	assignee?: string
	dependencies?: string[]
	labels?: string[]
	createdAt: number
	updatedAt: number
}

interface KanbanBoard {
	id: string
	name: string
	description?: string
	cards: KanbanCard[]
	createdAt: number
	updatedAt: number
	status: BoardStatus
}

// ─── Constants ────────────────────────────────────────────────────────────

const CARD_STATUS_FLOW: readonly CardStatus[] = ["todo", "in_progress", "in_review", "done", "blocked"]
const STATUS_COLORS: Record<CardStatus, string> = {
	todo: "var(--vscode-list-inactiveSelectionBackground)",
	in_progress: "var(--vscode-editorInfo-foreground)",
	in_review: "var(--vscode-editorWarning-foreground)",
	done: "var(--vscode-testing-iconPassed)",
	blocked: "var(--vscode-errorForeground)",
}
const PRIORITY_LABELS: Record<CardPriority, string> = {
	low: "L",
	medium: "M",
	high: "H",
	critical: "C",
}
const PRIORITY_COLORS: Record<CardPriority, string> = {
	low: "var(--vscode-descriptionForeground)",
	medium: "var(--vscode-editorInfo-foreground)",
	high: "var(--vscode-editorWarning-foreground)",
	critical: "var(--vscode-errorForeground)",
}

// ─── Sub-Components ───────────────────────────────────────────────────────

interface CardProps {
	card: KanbanCard
	onStatusChange: (cardId: string, status: CardStatus) => void
}

const KanbanCardDisplay = React.memo(function KanbanCardDisplay({ card, onStatusChange }: CardProps) {
	const handleDragStart = useCallback(
		(e: React.DragEvent) => {
			e.dataTransfer.setData("text/plain", card.id)
			e.dataTransfer.effectAllowed = "move"
		},
		[card.id],
	)

	return (
		<div
			className="kanban-card"
			draggable
			onDragStart={handleDragStart}
			style={{
				background: "var(--vscode-sideBar-background)",
				border: "1px solid var(--vscode-widget-border)",
				borderRadius: "6px",
				padding: "10px 12px",
				marginBottom: "8px",
				cursor: "grab",
				transition: "box-shadow 0.15s ease",
			}}>
			<div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
				<span
					style={{
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: "20px",
						height: "20px",
						borderRadius: "4px",
						fontSize: "11px",
						fontWeight: 700,
						color: "#fff",
						background: PRIORITY_COLORS[card.priority],
					}}>
					{PRIORITY_LABELS[card.priority]}
				</span>
				<span style={{ fontWeight: 600, fontSize: "13px", lineHeight: "18px" }}>{card.title}</span>
			</div>
			{card.description && (
				<p
					style={{
						margin: 0,
						fontSize: "12px",
						color: "var(--vscode-descriptionForeground)",
						lineHeight: "16px",
						display: "-webkit-box",
						WebkitLineClamp: 2,
						WebkitBoxOrient: "vertical",
						overflow: "hidden",
					}}>
					{card.description}
				</p>
			)}
			{card.labels && card.labels.length > 0 && (
				<div style={{ display: "flex", gap: "4px", marginTop: "6px", flexWrap: "wrap" }}>
					{card.labels.map((label) => (
						<span
							key={label}
							style={{
								fontSize: "10px",
								padding: "1px 6px",
								borderRadius: "3px",
								background: "var(--vscode-badge-background)",
								color: "var(--vscode-badge-foreground)",
							}}>
							{label}
						</span>
					))}
				</div>
			)}
			{/* Status change buttons */}
			<div style={{ display: "flex", gap: "4px", marginTop: "8px" }}>
				{CARD_STATUS_FLOW.filter(
					(s) =>
						s !== card.status &&
						!(s === "blocked" && card.status !== "todo" && card.status !== "in_progress"),
				).map((targetStatus) => (
					<button
						key={targetStatus}
						onClick={() => onStatusChange(card.id, targetStatus)}
						title={`Move to ${targetStatus}`}
						style={{
							fontSize: "10px",
							padding: "2px 6px",
							borderRadius: "3px",
							border: `1px solid ${STATUS_COLORS[targetStatus]}`,
							background: "transparent",
							color: STATUS_COLORS[targetStatus],
							cursor: "pointer",
						}}>
						{targetStatus === "todo"
							? "📋"
							: targetStatus === "in_progress"
								? "🔨"
								: targetStatus === "in_review"
									? "👁️"
									: targetStatus === "done"
										? "✅"
										: "🚫"}
					</button>
				))}
			</div>
		</div>
	)
})

interface ColumnProps {
	status: CardStatus
	cards: KanbanCard[]
	onStatusChange: (cardId: string, status: CardStatus) => void
	onDrop: (cardId: string, status: CardStatus) => void
}

const KanbanColumn = React.memo(function KanbanColumn({ status, cards, onStatusChange, onDrop }: ColumnProps) {
	const { t } = useAppTranslation()

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.dataTransfer.dropEffect = "move"
	}, [])

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			const cardId = e.dataTransfer.getData("text/plain")
			if (cardId) {
				onDrop(cardId, status)
			}
		},
		[status, onDrop],
	)

	const statusLabel = t(`kanban.status.${status}` as any, status)

	return (
		<div
			className="kanban-column"
			onDragOver={handleDragOver}
			onDrop={handleDrop}
			style={{
				flex: 1,
				minWidth: "220px",
				maxWidth: "320px",
				background: "var(--vscode-editor-background)",
				borderRadius: "8px",
				display: "flex",
				flexDirection: "column",
				maxHeight: "100%",
			}}>
			{/* Column header */}
			<div
				style={{
					padding: "10px 12px",
					fontWeight: 600,
					fontSize: "13px",
					borderBottom: `3px solid ${STATUS_COLORS[status]}`,
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}>
				<span>{statusLabel}</span>
				<span
					style={{
						fontSize: "11px",
						color: "var(--vscode-descriptionForeground)",
						background: "var(--vscode-badge-background)",
						padding: "1px 7px",
						borderRadius: "10px",
					}}>
					{cards.length}
				</span>
			</div>

			{/* Card list */}
			<div
				style={{
					flex: 1,
					overflowY: "auto",
					padding: "8px",
				}}>
				{cards.length === 0 ? (
					<p
						style={{
							textAlign: "center",
							color: "var(--vscode-descriptionForeground)",
							fontSize: "12px",
							padding: "20px 0",
							margin: 0,
						}}>
						{status === "todo" ? "➕ Add a card..." : "—"}
					</p>
				) : (
					cards.map((card) => <KanbanCardDisplay key={card.id} card={card} onStatusChange={onStatusChange} />)
				)}
			</div>
		</div>
	)
})

// ─── Main Board Component ─────────────────────────────────────────────────

interface KanbanBoardViewProps {
	board: KanbanBoard
	onBoardUpdate?: (board: KanbanBoard) => void
}

export function KanbanBoardView({ board, onBoardUpdate: _onBoardUpdate }: KanbanBoardViewProps) {
	const [localBoard, setLocalBoard] = useState(board)

	useEffect(() => {
		setLocalBoard(board)
	}, [board])

	const handleStatusChange = useCallback(
		(cardId: string, newStatus: CardStatus) => {
			setLocalBoard((prev) => ({
				...prev,
				cards: prev.cards.map((c) =>
					c.id === cardId ? { ...c, status: newStatus, updatedAt: Date.now() } : c,
				),
			}))
			// Notify extension
			vscode.postMessage({
				type: "kanbanCardStatusChange",
				boardId: board.id,
				cardId,
				status: newStatus,
			})
		},
		[board.id],
	)

	const handleDrop = useCallback(
		(cardId: string, targetStatus: CardStatus) => {
			handleStatusChange(cardId, targetStatus)
		},
		[handleStatusChange],
	)

	// Group cards by status
	const columns = useMemo(() => {
		const grouped: Record<CardStatus, KanbanCard[]> = {
			todo: [],
			in_progress: [],
			in_review: [],
			done: [],
			blocked: [],
		}
		for (const card of localBoard.cards) {
			if (grouped[card.status]) {
				grouped[card.status].push(card)
			} else {
				grouped.todo.push(card)
			}
		}
		return grouped
	}, [localBoard.cards])

	const { t } = useAppTranslation()

	return (
		<div className="kanban-board" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
			{/* Board header */}
			<div
				style={{
					padding: "12px 16px",
					borderBottom: "1px solid var(--vscode-widget-border)",
				}}>
				<h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>{localBoard.name}</h2>
				{localBoard.description && (
					<p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--vscode-descriptionForeground)" }}>
						{localBoard.description}
					</p>
				)}
			</div>

			{/* Columns */}
			<div
				style={{
					flex: 1,
					display: "flex",
					gap: "12px",
					padding: "12px",
					overflowX: "auto",
					overflowY: "hidden",
				}}>
				{CARD_STATUS_FLOW.map((status) => (
					<KanbanColumn
						key={status}
						status={status}
						cards={columns[status]}
						onStatusChange={handleStatusChange}
						onDrop={handleDrop}
					/>
				))}
			</div>

			{/* Footer */}
			<div
				style={{
					padding: "8px 16px",
					borderTop: "1px solid var(--vscode-widget-border)",
					fontSize: "11px",
					color: "var(--vscode-descriptionForeground)",
					display: "flex",
					justifyContent: "space-between",
				}}>
				<span>{t("kanban.totalCards", `${localBoard.cards.length} cards`)}</span>
				<span>{t("kanban.lastUpdated", `Updated ${new Date(localBoard.updatedAt).toLocaleString()}`)}</span>
			</div>
		</div>
	)
}
