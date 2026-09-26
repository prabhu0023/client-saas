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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  const { clinic } = await requireStaff()
  const { date } = await searchParams

  const dateYmd =
    date && YMD.test(date) ? date : todayYmdInTimeZone(clinic.timezone)

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
          <Link
            className={styles.navBtn}
            href={`/dashboard?date=${prevYmd}`}
            aria-label="Previous day"
          >
            ‹
          </Link>
          {dateYmd !== todayYmd && (
            <Link className={styles.today} href="/dashboard">
              Today
            </Link>
          )}
          <Link
            className={styles.navBtn}
            href={`/dashboard?date=${nextYmd}`}
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
            <button className={styles.action} type="submit">
              Go
            </button>
          </form>
        </div>
      </div>

      {appointments.length === 0 ? (
        <div className={styles.empty}>No appointments for this day.</div>
      ) : (
        <div className={styles.list}>
          {appointments.map((appt) => (
            <AppointmentRow
              key={appt.id}
              appt={appt}
              dateYmd={dateYmd}
              doctorLabel={resolveDoctorLabel(appt, doctorNames)}
            />
          ))}
        </div>
      )}
    </div>
  )
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

function AppointmentRow({
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
