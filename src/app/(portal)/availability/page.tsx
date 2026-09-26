import { requireStaff } from '@/lib/portal/auth'
import {
  listClinicDoctors,
  getAvailabilityRules,
  getUpcomingExceptions,
  WEEKDAY_LABELS,
} from '@/lib/portal/availability'
import { todayYmdInTimeZone } from '@/lib/availability/timezone'
import type { AvailabilityRule, AvailabilityException } from '@/types'
import {
  addRule,
  toggleRule,
  deleteRule,
  addException,
  deleteException,
} from './actions'
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
                    <RuleChip key={r.id} rule={r} doctorId={selectedId} />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>

        <form className={styles.addForm} action={addRule}>
          <input type="hidden" name="doctorId" value={selectedId} />
          <select className={styles.smallSelect} name="weekday" defaultValue="1">
            {WEEKDAY_LABELS.map((label, day) => (
              <option key={label} value={day}>
                {label}
              </option>
            ))}
          </select>
          <input
            className={styles.timeInput}
            type="time"
            name="startTime"
            required
            aria-label="Start time"
          />
          <span className={styles.dash}>–</span>
          <input
            className={styles.timeInput}
            type="time"
            name="endTime"
            required
            aria-label="End time"
          />
          <input
            className={styles.slotInput}
            type="number"
            name="slotMinutes"
            min="1"
            placeholder="slot min"
            aria-label="Slot minutes (optional)"
          />
          <button className={styles.addBtn} type="submit">
            Add hours
          </button>
        </form>
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
              <ExceptionRow key={e.id} exception={e} doctorId={selectedId} />
            ))}
          </div>
        )}

        <form className={styles.addForm} action={addException}>
          <input type="hidden" name="doctorId" value={selectedId} />
          <input
            className={styles.timeInput}
            type="date"
            name="date"
            min={todayYmd}
            required
            aria-label="Exception date"
          />
          <select className={styles.smallSelect} name="kind" defaultValue="off">
            <option value="off">Off</option>
            <option value="extra">Extra</option>
          </select>
          <input
            className={styles.timeInput}
            type="time"
            name="startTime"
            aria-label="Start time (optional for whole-day off)"
          />
          <span className={styles.dash}>–</span>
          <input
            className={styles.timeInput}
            type="time"
            name="endTime"
            aria-label="End time (optional for whole-day off)"
          />
          <button className={styles.addBtn} type="submit">
            Add exception
          </button>
        </form>
        <p className={styles.hint}>
          Leave times blank on an <strong>Off</strong> to block the whole day.
          <strong> Extra</strong> hours need a start and end.
        </p>
      </section>
    </div>
  )
}

function RuleChip({ rule, doctorId }: { rule: AvailabilityRule; doctorId: string }) {
  return (
    <span
      className={`${styles.window} ${rule.active ? '' : styles.inactive}`}
    >
      {hhmm(rule.start_time)}–{hhmm(rule.end_time)}
      {rule.slot_minutes ? ` · ${rule.slot_minutes}m` : ''}
      {rule.active ? '' : ' (off)'}
      <form className={styles.chipForm} action={toggleRule}>
        <input type="hidden" name="id" value={rule.id} />
        <input type="hidden" name="doctorId" value={doctorId} />
        <input type="hidden" name="active" value={(!rule.active).toString()} />
        <button className={styles.chipBtn} type="submit" title={rule.active ? 'Disable' : 'Enable'}>
          {rule.active ? '⏸' : '▶'}
        </button>
      </form>
      <form className={styles.chipForm} action={deleteRule}>
        <input type="hidden" name="id" value={rule.id} />
        <input type="hidden" name="doctorId" value={doctorId} />
        <button className={styles.chipBtn} type="submit" title="Remove">
          ✕
        </button>
      </form>
    </span>
  )
}

function ExceptionRow({
  exception,
  doctorId,
}: {
  exception: AvailabilityException
  doctorId: string
}) {
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
      <form action={deleteException}>
        <input type="hidden" name="id" value={exception.id} />
        <input type="hidden" name="doctorId" value={doctorId} />
        <button className={styles.exDelete} type="submit" title="Remove">
          ✕
        </button>
      </form>
    </div>
  )
}
