import Link from 'next/link'
import { requireStaff } from '@/lib/portal/auth'
import { listClinicDoctors } from '@/lib/portal/availability'
import { getPatient } from '@/lib/portal/patients'
import { listSlotsForDay } from '@/lib/portal/new-appointment'
import { todayYmdInTimeZone, addDaysYmd } from '@/lib/availability/timezone'
import { PatientSearch } from './PatientSearch'
import { SlotPicker } from './SlotPicker'
import styles from './new-appointment.module.css'

const YMD = /^\d{4}-\d{2}-\d{2}$/

/**
 * Staff booking screen (T3/T4): patient → doctor → day → slot.
 *
 * The three selections live in the URL (?patient, ?doctor, ?date) rather
 * than in client state, for the same reason the dashboard's day lives
 * there: every step is linkable, the back button works, and the slot
 * list is re-read on the server on every navigation instead of ageing in
 * a client cache.
 *
 * Which means all three are client-supplied and none are trusted.
 * ?patient is resolved with getPatient(clinic.id, …) and a miss falls
 * back to the search step rather than a 404 — a stale link should be
 * recoverable, not a dead end. ?doctor is accepted only if it is in this
 * clinic's own doctor list, and ?date only if it is a YMD. The slot list
 * is rendered on the SERVER so the offered times can only ever come from
 * generateSlots (R3) — the client never gets to propose a time.
 *
 * ?reused is the one flag that carries no authority: AddPatientForm sets
 * it when the number staff typed already belonged to a patient, and all
 * it does is add a line saying so next to that patient's stored name
 * (R2). It lives in the URL because the form that learned it unmounts on
 * the redirect. The href() helper below rebuilds the query from scratch,
 * so the notice drops off the first time staff navigate anywhere else —
 * it is about the add they just did, not about the patient.
 *
 * Carrying it in the URL means it can also be WRONG: a forged or shared
 * link shows the notice for a patient nobody just re-entered. That is
 * accepted rather than fixed, because the row itself does not record
 * that a staff member typed an existing number — only the add that
 * learned it knows, and it is gone by the time this page renders. The
 * cost is one stale sentence about a name that is correct either way;
 * the flag never changes which patient is booked.
 */
export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<{
    patient?: string
    doctor?: string
    date?: string
    reused?: string
  }>
}) {
  const { clinic } = await requireStaff()
  const { patient, doctor, date, reused } = await searchParams

  const doctors = await listClinicDoctors(clinic.id)

  if (doctors.length === 0) {
    return (
      <div>
        <h1 className={styles.title}>New appointment</h1>
        <div className={styles.empty}>
          No doctors are set up for this clinic yet.
        </div>
      </div>
    )
  }

  const selectedDoctorId =
    doctor && doctors.some((d) => d.id === doctor) ? doctor : doctors[0].id
  const selectedDoctor = doctors.find((d) => d.id === selectedDoctorId)!

  const dateYmd =
    date && YMD.test(date) ? date : todayYmdInTimeZone(clinic.timezone)

  // A patient id we can't resolve in this clinic is treated as "none
  // selected yet", not as an error.
  const selectedPatient = patient
    ? await getPatient(clinic.id, patient)
    : null

  const slots = await listSlotsForDay({
    clinicId: clinic.id,
    doctorId: selectedDoctorId,
    dateYmd,
    timezone: clinic.timezone,
  })

  const href = (opts: { patient?: string | null; doctor?: string; date?: string }) => {
    const params = new URLSearchParams()
    const p = opts.patient === undefined ? selectedPatient?.id : opts.patient
    if (p) params.set('patient', p)
    params.set('doctor', opts.doctor ?? selectedDoctorId)
    params.set('date', opts.date ?? dateYmd)
    return `/appointments/new?${params.toString()}`
  }

  return (
    <div>
      <div className={styles.head}>
        <div>
          <Link className={styles.back} href={`/dashboard?date=${dateYmd}`}>
            ← Back to appointments
          </Link>
          <h1 className={styles.title}>New appointment</h1>
          <p className={styles.sub}>
            Times are {clinic.timezone} and come from the same availability
            patients see on WhatsApp.
          </p>
        </div>
      </div>

      <section className={styles.step}>
        <h2 className={styles.stepTitle}>
          <span className={styles.stepNum}>1</span> Patient
        </h2>

        {selectedPatient ? (
          <>
            {reused === '1' && (
              <p className={styles.notice} role="status">
                This number already had a patient record. Booking under the
                stored name below, not the one just typed.
              </p>
            )}
            <div className={styles.selected}>
              <div>
                <div className={styles.selectedName}>
                  {selectedPatient.fullName ?? 'Unnamed patient'}
                </div>
                <div className={styles.selectedMeta}>
                  {selectedPatient.waPhone}
                  {selectedPatient.dateOfBirth
                    ? ` · born ${selectedPatient.dateOfBirth}`
                    : ''}
                </div>
              </div>
              <Link className={styles.change} href={href({ patient: null })}>
                Change patient
              </Link>
            </div>
          </>
        ) : (
          <PatientSearch doctorId={selectedDoctorId} dateYmd={dateYmd} />
        )}
      </section>

      <section className={styles.step}>
        <h2 className={styles.stepTitle}>
          <span className={styles.stepNum}>2</span> Doctor
        </h2>

        {doctors.length === 1 ? (
          <p className={styles.onlyDoctor}>{selectedDoctor.label}</p>
        ) : (
          <form className={styles.picker} method="get">
            {selectedPatient && (
              <input type="hidden" name="patient" value={selectedPatient.id} />
            )}
            <input type="hidden" name="date" value={dateYmd} />
            <label className={styles.pickerLabel} htmlFor="doctor">
              Doctor
            </label>
            <select
              className={styles.select}
              id="doctor"
              name="doctor"
              defaultValue={selectedDoctorId}
            >
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <button className={styles.action} type="submit">
              View slots
            </button>
          </form>
        )}
      </section>

      <section className={styles.step}>
        <h2 className={styles.stepTitle}>
          <span className={styles.stepNum}>3</span> Day
        </h2>

        <div className={styles.dayRow}>
          <Link
            className={styles.navBtn}
            href={href({ date: addDaysYmd(dateYmd, -1) })}
            aria-label="Previous day"
          >
            ‹
          </Link>
          <form className={styles.picker} method="get">
            {selectedPatient && (
              <input type="hidden" name="patient" value={selectedPatient.id} />
            )}
            <input type="hidden" name="doctor" value={selectedDoctorId} />
            <label className={styles.pickerLabel} htmlFor="date">
              Date
            </label>
            <input
              className={styles.dateInput}
              type="date"
              id="date"
              name="date"
              defaultValue={dateYmd}
            />
            <button className={styles.action} type="submit">
              Go
            </button>
          </form>
          <Link
            className={styles.navBtn}
            href={href({ date: addDaysYmd(dateYmd, 1) })}
            aria-label="Next day"
          >
            ›
          </Link>
        </div>
      </section>

      <section className={styles.step}>
        <h2 className={styles.stepTitle}>
          <span className={styles.stepNum}>4</span> Time
        </h2>

        {slots.length === 0 ? (
          <p className={styles.emptyInline}>
            No open slots for this day — try another date, or add hours in{' '}
            <Link className={styles.inlineLink} href="/availability">
              Availability
            </Link>
            .
          </p>
        ) : !selectedPatient ? (
          <p className={styles.emptyInline}>
            {slots.length} open{' '}
            {slots.length === 1 ? 'time' : 'times'} on this day. Choose a
            patient in step 1 to book one.
          </p>
        ) : (
          <SlotPicker
            patientId={selectedPatient.id}
            doctorId={selectedDoctorId}
            dateYmd={dateYmd}
            slots={slots.map((s) => ({ hhmm: s.hhmm, label: s.localLabel }))}
          />
        )}
      </section>
    </div>
  )
}
