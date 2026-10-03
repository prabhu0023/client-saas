import { requireStaff } from '@/lib/portal/auth'
import {
  getAppointmentsForDay,
  type DashboardAppointment,
} from '@/lib/portal/appointments'
import { getDoctorNameMap } from '@/lib/portal/doctors'
import {
  todayYmdInTimeZone,
  localDayLabel,
  addDaysYmd,
} from '@/lib/availability/timezone'
import Link from 'next/link'
import type { AppointmentStatus } from '@/types'
import { updateAppointmentStatus } from './actions'
import { KanbanBoard, type BoardCard } from './KanbanBoard'
import styles from './dashboard.module.css'

const YMD = /^\d{4}-\d{2}-\d{2}$/

// Which actions to offer for each current status. Terminal states
// (cancelled/completed/no_show) offer nothing.
const NEXT_ACTIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  cancelled: [],
  completed: [],
  no_show: [],
}

const ACTION_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Booked',
  confirmed: 'Confirm',
  cancelled: 'Cancel',
  completed: 'Complete',
  no_show: 'No-show',
}



type ViewMode = 'board' | 'agenda'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; view?: string }>
}) {
  const { clinic } = await requireStaff()
  const { date, view } = await searchParams

  const dateYmd =
    date && YMD.test(date) ? date : todayYmdInTimeZone(clinic.timezone)
  const viewMode: ViewMode = view === 'agenda' ? 'agenda' : 'board'

  const [appointments, doctorNames] = await Promise.all([
    getAppointmentsForDay({
      clinicId: clinic.id,
      dateYmd,
      timezone: clinic.timezone,
    }),
    getDoctorNameMap(clinic.id),
  ])

  // A representative label for the day header, rendered in clinic tz.
  const dayLabel = localDayLabel(new Date(`${dateYmd}T12:00:00Z`), 'UTC')
  const todayYmd = todayYmdInTimeZone(clinic.timezone)
  const prevYmd = addDaysYmd(dateYmd, -1)
  const nextYmd = addDaysYmd(dateYmd, 1)
  const count = appointments.length

  // Build a dashboard URL preserving the current view (and optionally the
  // date). Keeps the day nav + view toggle from clobbering each other.
  const href = (opts: { date?: string; view?: ViewMode }): string => {
    const params = new URLSearchParams()
    if (opts.date) params.set('date', opts.date)
    const v = opts.view ?? viewMode
    if (v !== 'board') params.set('view', v)
    const qs = params.toString()
    return qs ? `/dashboard?${qs}` : '/dashboard'
  }

  return (
    <div>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Appointments · {dayLabel}</h1>
          <div className={styles.count}>
            {count === 0
              ? 'No appointments'
              : `${count} appointment${count === 1 ? '' : 's'}`}
            {dateYmd !== todayYmd ? '' : ' · today'}
          </div>
        </div>

        <div className={styles.nav}>
          <div className={styles.viewToggle}>
            <Link
              className={`${styles.viewBtn} ${viewMode === 'board' ? styles.viewActive : ''}`}
              href={href({ date: dateYmd, view: 'board' })}
            >
              Board
            </Link>
            <Link
              className={`${styles.viewBtn} ${viewMode === 'agenda' ? styles.viewActive : ''}`}
              href={href({ date: dateYmd, view: 'agenda' })}
            >
              Agenda
            </Link>
          </div>

          <Link
            className={styles.navBtn}
            href={href({ date: prevYmd })}
            aria-label="Previous day"
          >
            ‹
          </Link>
          {dateYmd !== todayYmd && (
            <Link className={styles.today} href={href({ view: viewMode })}>
              Today
            </Link>
          )}
          <Link
            className={styles.navBtn}
            href={href({ date: nextYmd })}
            aria-label="Next day"
          >
            ›
          </Link>
          <form className={styles.dateForm} method="get">
            <input
              className={styles.dateInput}
              type="date"
              name="date"
              defaultValue={dateYmd}
            />
            {viewMode !== 'board' && (
              <input type="hidden" name="view" value={viewMode} />
            )}
            <button className={styles.action} type="submit">
              Go
            </button>
          </form>
        </div>
      </div>

      {appointments.length === 0 ? (
        <div className={styles.empty}>No appointments for this day.</div>
      ) : viewMode === 'agenda' ? (
        <div className={styles.agenda}>
          {appointments.map((appt) => (
            <AgendaRow
              key={appt.id}
              appt={appt}
              dateYmd={dateYmd}
              doctorLabel={resolveDoctorLabel(appt, doctorNames)}
            />
          ))}
        </div>
      ) : (
        <KanbanBoard cards={toBoardCards(appointments, doctorNames)} dateYmd={dateYmd} />
      )}
    </div>
  )
}

/** Shape appointments into serializable cards for the client board. */
function toBoardCards(
  appointments: DashboardAppointment[],
  names: Map<string, string>,
): BoardCard[] {
  return appointments.map((a) => ({
    id: a.id,
    status: a.status,
    startLabel: a.startLabel,
    endLabel: a.endLabel,
    patientId: a.patientId,
    patientName: a.patientName,
    patientPhone: a.patientPhone,
    serviceName: a.serviceName,
    doctorLabel: resolveDoctorLabel(a, names),
    createdVia: a.createdVia,
  }))
}

/**
 * Doctor label for a row: prefer the name (via the SECURITY DEFINER RPC),
 * append specialty when both are known, and fall back to specialty alone
 * (or nothing) when the name isn't available.
 */
function resolveDoctorLabel(
  appt: DashboardAppointment,
  names: Map<string, string>,
): string | null {
  const name = names.get(appt.doctorId)
  if (name && appt.doctorSpecialty) return `${name} · ${appt.doctorSpecialty}`
  if (name) return name
  return appt.doctorSpecialty
}

/**
 * Agenda view row: appointments in chronological order (they arrive
 * ordered by starts_at), one per line, with a status badge and the same
 * transition actions as the board. Good for reading the day top-to-bottom.
 */
function AgendaRow({
  appt,
  dateYmd,
  doctorLabel,
}: {
  appt: DashboardAppointment
  dateYmd: string
  doctorLabel: string | null
}) {
  const actions = NEXT_ACTIONS[appt.status]

  return (
    <div className={styles.row}>
      <div className={styles.time}>
        {appt.startLabel} – {appt.endLabel}
      </div>

      <div className={styles.details}>
        <div className={styles.patient}>
          {appt.patientName ?? (appt.patientPhone || 'Unknown patient')}
        </div>
        <div className={styles.meta}>
          {appt.patientName ? `${appt.patientPhone} · ` : ''}
          {appt.serviceName ?? 'No service'}
          {doctorLabel ? ` · ${doctorLabel}` : ''}
          {` · via ${appt.createdVia}`}
        </div>
      </div>

      <span className={`${styles.badge} ${styles[appt.status]}`}>
        {appt.status.replace('_', ' ')}
      </span>

      <div className={styles.actions}>
        <Link
          className={styles.messageLink}
          href={`/inbox/patient/${appt.patientId}`}
        >
          Message
        </Link>
        {actions.map((next) => (
          <form key={next} action={updateAppointmentStatus}>
            <input type="hidden" name="id" value={appt.id} />
            <input type="hidden" name="status" value={next} />
            <input type="hidden" name="date" value={dateYmd} />
            <button className={styles.action} type="submit">
              {ACTION_LABEL[next]}
            </button>
          </form>
        ))}
      </div>
    </div>
  )
}
