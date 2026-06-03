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

// ─── Props ────────────────────────────────────────────────────────────────

interface KanbanBoardViewProps {
	board: KanbanBoard
	onCardStatusChange: (boardId: string, cardId: string, newStatus: CardStatus) => void
}

// ─── Board Component ──────────────────────────────────────────────────────

const KanbanBoardView: React.FC<KanbanBoardViewProps> = ({ board, onCardStatusChange }) => {
	const { t } = useAppTranslation()
	const [localBoard, setLocalBoard] = useState<KanbanBoard>(board)

	useEffect(() => {
		setLocalBoard(board)
	}, [board])

	const cardsByStatus = useMemo(() => {
		const grouped: Record<CardStatus, KanbanCard[]> = {
			todo: [],
			in_progress: [],
			in_review: [],
			done: [],
			blocked: [],
		}
		for (const card of localBoard.cards) {
			grouped[card.status].push(card)
		}
		return grouped
	}, [localBoard.cards])

	const handleCardStatusChange = useCallback(
		(cardId: string, newStatus: CardStatus) => {
			onCardStatusChange(localBoard.id, cardId, newStatus)
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
			} as any)
		},
		[board.id, localBoard.id, onCardStatusChange],
	)

	return (
		<div className="kanban-board">
			<div className="kanban-board-header">
				<h3>{localBoard.name}</h3>
				{localBoard.description && <p>{localBoard.description}</p>}
			</div>
			<div className="kanban-columns">
				{CARD_STATUS_FLOW.map((status) => (
					<KanbanColumn
						key={status}
						status={status}
						t={t}
						cards={cardsByStatus[status]}
						onCardStatusChange={handleCardStatusChange}
					/>
				))}
			</div>
			<div
				style={{
					marginTop: "8px",
					fontSize: "11px",
					color: "var(--vscode-descriptionForeground)",
					display: "flex",
					justifyContent: "space-between",
				}}>
				<span>{t("kanban.totalCards", { count: localBoard.cards.length })}</span>
				<span>{t("kanban.lastUpdated", { time: new Date(localBoard.updatedAt).toLocaleString() })}</span>
			</div>
		</div>
	)
}

// ─── Column Component ─────────────────────────────────────────────────────

interface KanbanColumnProps {
	status: CardStatus
	t: (key: string, options?: Record<string, any>) => string
	cards: KanbanCard[]
	onCardStatusChange: (cardId: string, newStatus: CardStatus) => void
}

const KanbanColumn: React.FC<KanbanColumnProps> = ({ status, t, cards, onCardStatusChange }) => {
	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.dataTransfer.dropEffect = "move"
	}, [])

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			const cardId = e.dataTransfer.getData("text/plain")
			if (cardId) {
				onCardStatusChange(cardId, status)
			}
		},
		[status, onCardStatusChange],
	)

	const statusLabel = t(`kanban.status.${status}`)

	return (
		<div
			className="kanban-column"
			onDragOver={handleDragOver}
			onDrop={handleDrop}
			style={{
				flex: 1,
				minWidth: "220px",
				backgroundColor: "var(--vscode-editor-background)",
				borderRadius: "6px",
				padding: "8px",
			}}>
			<div
				style={{
					fontWeight: 600,
					fontSize: "12px",
					textTransform: "uppercase",
					color: STATUS_COLORS[status],
					marginBottom: "8px",
					padding: "4px 8px",
				}}>
				{statusLabel} ({cards.length})
			</div>
			<div className="kanban-cards">
				{cards.map((card) => (
					<KanbanCardComponent key={card.id} card={card} onStatusChange={onCardStatusChange} />
				))}
			</div>
		</div>
	)
}

// ─── Card Component ───────────────────────────────────────────────────────

interface KanbanCardComponentProps {
	card: KanbanCard
	onStatusChange: (cardId: string, newStatus: CardStatus) => void
}

const KanbanCardComponent: React.FC<KanbanCardComponentProps> = ({ card, onStatusChange }) => {
	const handleDragStart = useCallback(
		(e: React.DragEvent) => {
			e.dataTransfer.setData("text/plain", card.id)
			e.dataTransfer.effectAllowed = "move"
		},
		[card.id],
	)

	const nextStatus = useMemo(() => {
		const idx = CARD_STATUS_FLOW.indexOf(card.status)
		if (idx >= 0 && idx < CARD_STATUS_FLOW.length - 1) {
			return CARD_STATUS_FLOW[idx + 1]
		}
		return null
	}, [card.status])

	const handleAdvance = useCallback(() => {
		if (nextStatus) {
			onStatusChange(card.id, nextStatus)
		}
	}, [card.id, nextStatus, onStatusChange])

	return (
		<div
			className="kanban-card"
			draggable
			onDragStart={handleDragStart}
			style={{
				backgroundColor: "var(--vscode-sideBar-background)",
				borderRadius: "4px",
				padding: "8px",
				marginBottom: "6px",
				cursor: "grab",
				border: "1px solid var(--vscode-widget-border)",
			}}>
			<div style={{ fontWeight: 500, fontSize: "13px", marginBottom: "4px" }}>{card.title}</div>
			{card.description && (
				<div
					style={{
						fontSize: "11px",
						color: "var(--vscode-descriptionForeground)",
						marginBottom: "4px",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
					}}>
					{card.description}
				</div>
			)}
			<div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
				<span
					style={{
						fontSize: "10px",
						fontWeight: 700,
						color: PRIORITY_COLORS[card.priority],
						backgroundColor: "var(--vscode-badge-background)",
						padding: "1px 4px",
						borderRadius: "3px",
					}}>
					{PRIORITY_LABELS[card.priority]}
				</span>
				{nextStatus && (
					<button
						onClick={handleAdvance}
						style={{
							fontSize: "10px",
							padding: "1px 6px",
							cursor: "pointer",
							border: "1px solid var(--vscode-button-border, transparent)",
							borderRadius: "3px",
							backgroundColor: "var(--vscode-button-background)",
							color: "var(--vscode-button-foreground)",
							marginLeft: "auto",
						}}>
						Advance
					</button>
				)}
			</div>
		</div>
	)
}

export default KanbanBoardView
