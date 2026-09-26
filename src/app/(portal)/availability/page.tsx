import { requireStaff } from '@/lib/portal/auth'
import {
  listClinicDoctors,
  getAvailabilityRules,
  getUpcomingExceptions,
  WEEKDAY_LABELS,
} from '@/lib/portal/availability'
import { todayYmdInTimeZone } from '@/lib/availability/timezone'
import type { AvailabilityRule, AvailabilityException } from '@/types'
import styles from './availability.module.css'

/** Trim 'HH:mm:ss' → 'HH:mm' for display. */
function hhmm(t: string | null): string {
  return t ? t.slice(0, 5) : ''
}

/**
 * Availability view (E5-T1). Shows a doctor's weekly recurring rules and
 * upcoming date exceptions — the same inputs slot generation uses to
 * offer WhatsApp day/time lists. Read-only for now; editing is E5-T2.
 */
export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ doctor?: string }>
}) {
  const { clinic } = await requireStaff()
  const { doctor } = await searchParams

  const doctors = await listClinicDoctors(clinic.id)

  if (doctors.length === 0) {
    return (
      <div>
        <h1 className={styles.title}>Availability</h1>
        <div className={styles.empty}>
          No doctors are set up for this clinic yet.
        </div>
      </div>
    )
  }

  // Selected doctor: the query param if valid, else the first.
  const selectedId =
    doctor && doctors.some((d) => d.id === doctor) ? doctor : doctors[0].id
  const selected = doctors.find((d) => d.id === selectedId)!

  const todayYmd = todayYmdInTimeZone(clinic.timezone)
  const [rules, exceptions] = await Promise.all([
    getAvailabilityRules(clinic.id, selectedId),
    getUpcomingExceptions(clinic.id, selectedId, todayYmd),
  ])

  // Group rules by weekday for a Sun–Sat overview.
  const byWeekday: AvailabilityRule[][] = WEEKDAY_LABELS.map(() => [])
  for (const r of rules) {
    if (r.weekday >= 0 && r.weekday <= 6) byWeekday[r.weekday].push(r)
  }

  return (
    <div>
      <div className={styles.head}>
        <h1 className={styles.title}>Availability</h1>

        {doctors.length > 1 && (
          <form className={styles.picker} method="get">
            <label className={styles.pickerLabel} htmlFor="doctor">
              Doctor
            </label>
            <select
              id="doctor"
              name="doctor"
              defaultValue={selectedId}
              className={styles.select}
            >
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <button className={styles.action} type="submit">
              View
            </button>
          </form>
        )}
      </div>

      <p className={styles.sub}>
        Weekly hours for <strong>{selected.label}</strong>, in{' '}
        {clinic.timezone}. These drive the times patients see on WhatsApp.
      </p>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Weekly hours</h2>
        <div className={styles.week}>
          {WEEKDAY_LABELS.map((label, day) => (
            <div key={label} className={styles.dayRow}>
              <div className={styles.dayName}>{label}</div>
              <div className={styles.windows}>
                {byWeekday[day].length === 0 ? (
                  <span className={styles.closed}>Closed</span>
                ) : (
                  byWeekday[day].map((r) => (
                    <span
                      key={r.id}
                      className={`${styles.window} ${
                        r.active ? '' : styles.inactive
                      }`}
                    >
                      {hhmm(r.start_time)}–{hhmm(r.end_time)}
                      {r.slot_minutes ? ` · ${r.slot_minutes}m` : ''}
                      {r.active ? '' : ' (off)'}
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Upcoming exceptions</h2>
        {exceptions.length === 0 ? (
          <div className={styles.emptyInline}>
            No date-specific changes coming up.
          </div>
        ) : (
          <div className={styles.exceptions}>
            {exceptions.map((e) => (
              <ExceptionRow key={e.id} exception={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ExceptionRow({ exception }: { exception: AvailabilityException }) {
  const isOff = exception.kind === 'off'
  const wholeDay = !exception.start_time && !exception.end_time
  const range =
    exception.start_time && exception.end_time
      ? `${exception.start_time.slice(0, 5)}–${exception.end_time.slice(0, 5)}`
      : null

  return (
    <div className={styles.exRow}>
      <div className={styles.exDate}>{exception.date}</div>
      <div className={styles.exDetail}>
        <span
          className={`${styles.exBadge} ${isOff ? styles.exOff : styles.exExtra}`}
        >
          {isOff ? 'Off' : 'Extra'}
        </span>
        <span className={styles.exText}>
          {isOff
            ? wholeDay
              ? 'Whole day unavailable'
              : `Unavailable ${range}`
            : `Extra hours ${range}`}
        </span>
      </div>
    </div>
  )
}
