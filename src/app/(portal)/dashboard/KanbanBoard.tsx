'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AppointmentStatus } from '@/types'
import { updateAppointmentStatus } from './actions'
import styles from './dashboard.module.css'

/**
 * Client-side Kanban board with drag-and-drop (native HTML5 DnD, no
 * dependency). Dragging a card onto another column applies that status
 * via the existing updateAppointmentStatus server action, but only for
 * transitions allowed by NEXT_ACTIONS — the same rules the action
 * buttons enforce — then refreshes the route so the server re-renders.
 *
 * The board is a client component; the page stays a server component and
 * passes already-resolved, serializable card data down.
 */

export interface BoardCard {
  id: string
  status: AppointmentStatus
  startLabel: string
  endLabel: string
  patientName: string | null
  patientPhone: string
  serviceName: string | null
  doctorLabel: string | null
  createdVia: 'whatsapp' | 'portal'
}

const COLUMNS: { status: AppointmentStatus; title: string }[] = [
  { status: 'booked', title: 'Booked' },
  { status: 'confirmed', title: 'Confirmed' },
  { status: 'completed', title: 'Completed' },
  { status: 'cancelled', title: 'Cancelled' },
  { status: 'no_show', title: 'No-show' },
]

// Valid target statuses for a drop, per current status (mirrors the
// server's SETTABLE + the button rules). Terminal states can't move.
const ALLOWED_TARGETS: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  cancelled: [],
  completed: [],
  no_show: [],
}

export function KanbanBoard({
  cards,
  dateYmd,
}: {
  cards: BoardCard[]
  dateYmd: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overStatus, setOverStatus] = useState<AppointmentStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const draggingCard = cards.find((c) => c.id === draggingId) ?? null

  function canDrop(card: BoardCard | null, target: AppointmentStatus): boolean {
    if (!card) return false
    if (card.status === target) return false
    return ALLOWED_TARGETS[card.status].includes(target)
  }

  function onDrop(target: AppointmentStatus) {
    const card = draggingCard
    setDraggingId(null)
    setOverStatus(null)
    if (!canDrop(card, target) || !card) return

    const fd = new FormData()
    fd.set('id', card.id)
    fd.set('status', target)
    fd.set('date', dateYmd)

    setError(null)
    startTransition(async () => {
      try {
        await updateAppointmentStatus(fd)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'update failed')
      }
    })
  }

  return (
    <>
      {error && <div className={styles.boardError}>{error}</div>}
      <div className={`${styles.board} ${isPending ? styles.boardBusy : ''}`}>
        {COLUMNS.map((col) => {
          const items = cards.filter((c) => c.status === col.status)
          const droppable = canDrop(draggingCard, col.status)
          const isOver = overStatus === col.status && droppable

          return (
            <div
              key={col.status}
              className={`${styles.column} ${isOver ? styles.columnOver : ''} ${
                draggingCard && !droppable && draggingCard.status !== col.status
                  ? styles.columnDisabled
                  : ''
              }`}
              onDragOver={(e) => {
                if (droppable) {
                  e.preventDefault()
                  setOverStatus(col.status)
                }
              }}
              onDragLeave={() => setOverStatus((s) => (s === col.status ? null : s))}
              onDrop={(e) => {
                e.preventDefault()
                onDrop(col.status)
              }}
            >
              <div className={styles.columnHead}>
                <span
                  className={`${styles.columnDot} ${styles[col.status]}`}
                  aria-hidden
                />
                <span className={styles.columnTitle}>{col.title}</span>
                <span className={styles.columnCount}>{items.length}</span>
              </div>

              <div className={styles.cards}>
                {items.length === 0 ? (
                  <div className={styles.columnEmpty}>—</div>
                ) : (
                  items.map((card) => (
                    <Card
                      key={card.id}
                      card={card}
                      draggable={ALLOWED_TARGETS[card.status].length > 0}
                      dragging={draggingId === card.id}
                      onDragStart={() => setDraggingId(card.id)}
                      onDragEnd={() => {
                        setDraggingId(null)
                        setOverStatus(null)
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function Card({
  card,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard
  draggable: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
}) {
  return (
    <div
      className={`${styles.card} ${draggable ? styles.cardDraggable : ''} ${
        dragging ? styles.cardDragging : ''
      }`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        // Some browsers need data set for the drag to initiate.
        e.dataTransfer.setData('text/plain', card.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      <div className={styles.cardTime}>
        {card.startLabel} – {card.endLabel}
      </div>
      <div className={styles.cardPatient}>
        {card.patientName ?? (card.patientPhone || 'Unknown patient')}
      </div>
      <div className={styles.cardMeta}>
        {card.patientName ? `${card.patientPhone} · ` : ''}
        {card.serviceName ?? 'No service'}
        {card.doctorLabel ? ` · ${card.doctorLabel}` : ''}
        {` · via ${card.createdVia}`}
      </div>
    </div>
  )
}
