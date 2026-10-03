import Link from 'next/link'
import { requireStaff } from '@/lib/portal/auth'
import { listThreads, type ThreadListItem } from '@/lib/portal/messages'
import { localDayLabel, localTimeLabel } from '@/lib/availability/timezone'
import styles from './inbox.module.css'

/**
 * Patient message inbox (T3). Lists every thread in the clinic, with the
 * ones needing attention first: escalated, then open, each
 * newest-activity-first (the ordering lives in listThreads). 'closed' is
 * ranked last there but nothing sets it in v1 — resolving a thread is
 * deferred (spec §4.5).
 *
 * This is a human-relay queue — staff read and reply themselves, nothing
 * here answers a patient automatically.
 */
export default async function InboxPage() {
  const { clinic } = await requireStaff()
  const threads = await listThreads(clinic.id)

  const unread = threads.reduce((n, t) => n + (t.unreadCount > 0 ? 1 : 0), 0)

  return (
    <div>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Patient messages</h1>
          <div className={styles.count}>
            {threads.length === 0
              ? 'No threads'
              : `${threads.length} thread${threads.length === 1 ? '' : 's'}`}
            {unread > 0 ? ` · ${unread} unread` : ''}
          </div>
        </div>
      </div>

      {threads.length === 0 ? (
        <div className={styles.empty}>No patient messages yet.</div>
      ) : (
        <div className={styles.list}>
          {threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              timezone={clinic.timezone}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ThreadRow({
  thread,
  timezone,
}: {
  thread: ThreadListItem
  timezone: string
}) {
  const when = thread.lastMessageAt ? new Date(thread.lastMessageAt) : null

  return (
    <Link className={styles.row} href={`/inbox/${thread.id}`}>
      <div className={styles.details}>
        <div className={styles.patient}>
          {/* `||` not `??`: an unnamed patient has full_name null AND a
              missing patient row yields '', both of which must fall
              through to the next label rather than render blank. */}
          {thread.patientName || thread.patientPhone || 'Unknown patient'}
          {thread.unreadCount > 0 && (
            <span
              className={styles.unread}
              aria-label={`${thread.unreadCount} unread message${
                thread.unreadCount === 1 ? '' : 's'
              }`}
            >
              {thread.unreadCount}
            </span>
          )}
          {thread.status === 'escalated' && (
            <span className={`${styles.badge} ${styles.escalated}`}>
              Escalated
            </span>
          )}
          {/* No Closed badge: nothing writes status 'closed' in v1 —
              thread resolution is deferred (spec §4.5), so a badge for
              it would render a state no code path can produce. */}
        </div>
        <div className={styles.preview}>
          {thread.lastMessagePreview ?? 'No messages yet'}
        </div>
      </div>

      <div className={styles.when}>
        {when ? (
          <>
            <div>{localDayLabel(when, timezone)}</div>
            <div className={styles.whenTime}>
              {localTimeLabel(when, timezone)}
            </div>
          </>
        ) : (
          '—'
        )}
      </div>
    </Link>
  )
}
