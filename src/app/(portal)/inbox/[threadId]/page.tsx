import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStaff } from '@/lib/portal/auth'
import {
  getThread,
  getThreadTimeline,
  isWindowOpen,
  WINDOW_CLOSED_NOTICE,
  type ThreadDetail,
  type TimelineEntry,
} from '@/lib/portal/messages'
import { getDoctorNameMap } from '@/lib/portal/doctors'
import { markThreadRead, escalateThread } from '../actions'
import { ReplyForm } from '../ReplyForm'
import styles from '../inbox.module.css'

/**
 * One patient thread (T3 + T4): their messages interleaved with their
 * appointments so a doubt is read next to the visit it's about (R7),
 * then the reply box, escalate and mark-read actions.
 *
 * The reply box itself is the client ReplyForm, so a failed send shows
 * its reason next to the typed text instead of replacing the screen; the
 * server action refuses an out-of-window send regardless (R5).
 */
export default async function ThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>
}) {
  const { clinic } = await requireStaff()
  const { threadId } = await params

  // Null covers both "no such thread" and "another clinic's thread".
  const thread = await getThread(clinic.id, threadId)
  if (!thread) notFound()

  const [timeline, windowOpen, doctorNames] = await Promise.all([
    getThreadTimeline(clinic.id, thread.patientId, clinic.timezone),
    isWindowOpen(clinic.id, thread.patientId),
    thread.escalatedToDoctorId ? getDoctorNameMap(clinic.id) : new Map(),
  ])

  // Same label ladder as the list: fall through on null AND on ''.
  const patientLabel =
    thread.patientName || thread.patientPhone || 'Unknown patient'

  return (
    <div>
      <div className={styles.threadHead}>
        <div>
          <Link className={styles.back} href="/inbox">
            ‹ Patient messages
          </Link>
          <h1 className={styles.title}>{patientLabel}</h1>
          <div className={styles.count}>
            {thread.patientName ? `${thread.patientPhone} · ` : ''}
            {thread.status === 'escalated'
              ? escalationLabel(thread, doctorNames)
              : `Thread ${thread.status}`}
          </div>
        </div>

        <div className={styles.threadActions}>
          {thread.unreadCount > 0 && (
            <form action={markThreadRead}>
              <input type="hidden" name="threadId" value={thread.id} />
              <button className={styles.action} type="submit">
                Mark as read
              </button>
            </form>
          )}
          {thread.status !== 'escalated' && (
            <form action={escalateThread}>
              <input type="hidden" name="threadId" value={thread.id} />
              <button className={styles.action} type="submit">
                Escalate to doctor
              </button>
            </form>
          )}
        </div>
      </div>

      <section className={styles.timeline}>
        {timeline.length === 0 ? (
          <div className={styles.emptyInline}>Nothing on this thread yet.</div>
        ) : (
          timeline.map((entry) => <TimelineRow key={entry.id} entry={entry} />)
        )}
      </section>

      <section className={styles.replyCard}>
        <h2 className={styles.cardTitle}>Reply on WhatsApp</h2>
        <ReplyForm
          threadId={thread.id}
          windowOpen={windowOpen}
          closedNotice={WINDOW_CLOSED_NOTICE}
        />
      </section>
    </div>
  )
}

/**
 * Who the thread is waiting on. Prefers the doctor's name (via the
 * clinic_doctor_names RPC), falls back to their specialty, then to a
 * plain label — the same graceful degradation the dashboard uses when
 * names aren't readable.
 */
function escalationLabel(
  thread: ThreadDetail,
  names: Map<string, string>,
): string {
  const name = thread.escalatedToDoctorId
    ? names.get(thread.escalatedToDoctorId)
    : undefined
  if (name) return `Escalated to ${name}`
  if (thread.escalatedToDoctorSpecialty) {
    return `Escalated to ${thread.escalatedToDoctorSpecialty}`
  }
  return 'Escalated to doctor'
}

/** One timeline entry: a message bubble or an appointment marker. */
function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const stamp = `${entry.dayLabel} · ${entry.timeLabel}`

  if (entry.kind === 'appointment') {
    return (
      <div className={styles.apptEntry}>
        <span className={styles.apptDot} aria-hidden="true" />
        <span className={styles.apptText}>
          Appointment · {entry.status.replace('_', ' ')}
        </span>
        <span className={styles.entryTime}>{stamp}</span>
      </div>
    )
  }

  const inbound = entry.direction === 'inbound'
  return (
    <div className={inbound ? styles.inboundEntry : styles.outboundEntry}>
      <div className={styles.entryMeta}>
        {inbound ? 'Patient' : 'Clinic'} · {stamp}
      </div>
      <div className={styles.entryBody}>{entry.body}</div>
    </div>
  )
}
