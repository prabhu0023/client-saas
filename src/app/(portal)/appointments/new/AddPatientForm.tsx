'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addPatient } from './actions'
import styles from './new-appointment.module.css'

/**
 * The inline add-patient form (T2). Follows ReplyForm.tsx: the action
 * returns its failure reason, this renders it next to the fields with
 * everything typed still in place. Re-typing a phone number because a
 * dash was in the wrong place is exactly the friction a walk-in booking
 * can't afford.
 *
 * A number that already belongs to a patient is not an error — the
 * action hands back the existing record and booking continues on it
 * (R2). Staff still have to be TOLD that, because the name they typed
 * was discarded in favour of the stored one, and a clinical booking must
 * not change the name under it silently. The notice can't be rendered
 * here: this form unmounts the moment the selection lands in the URL, so
 * `reused` rides along as `?reused=1` and page.tsx shows it on the
 * selected-patient card, where the name it is talking about is visible.
 */
export function AddPatientForm({
  doctorId,
  dateYmd,
}: {
  doctorId: string
  dateYmd: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [fullName, setFullName] = useState('')
  const [waPhone, setWaPhone] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isPending) return

    const fd = new FormData()
    fd.set('fullName', fullName)
    fd.set('waPhone', waPhone)
    fd.set('dateOfBirth', dateOfBirth)
    fd.set('notes', notes)

    setError(null)
    startTransition(async () => {
      const result = await addPatient(fd)
      if (result.error || !result.patient) {
        setError(result.error ?? 'could not save the patient')
        return
      }
      const params = new URLSearchParams({
        patient: result.patient.id,
        doctor: doctorId,
        date: dateYmd,
      })
      // Tells the next render that this patient was an EXISTING record,
      // not one created from what was just typed.
      if (result.reused) params.set('reused', '1')
      router.push(`/appointments/new?${params.toString()}`)
    })
  }

  return (
    <form className={styles.addForm} onSubmit={onSubmit}>
      <h3 className={styles.addTitle}>New patient</h3>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.field}>
        <label className={styles.pickerLabel} htmlFor="fullName">
          Full name
        </label>
        <input
          className={styles.textInput}
          id="fullName"
          name="fullName"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.pickerLabel} htmlFor="waPhone">
          WhatsApp number
        </label>
        <input
          className={styles.textInput}
          id="waPhone"
          name="waPhone"
          required
          inputMode="tel"
          placeholder="+919876543210"
          value={waPhone}
          onChange={(e) => setWaPhone(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.pickerLabel} htmlFor="dateOfBirth">
          Date of birth <span className={styles.optional}>(optional)</span>
        </label>
        <input
          className={styles.dateInput}
          id="dateOfBirth"
          name="dateOfBirth"
          type="date"
          value={dateOfBirth}
          onChange={(e) => setDateOfBirth(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.pickerLabel} htmlFor="notes">
          Notes <span className={styles.optional}>(optional)</span>
        </label>
        <textarea
          className={styles.textArea}
          id="notes"
          name="notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <button className={styles.primaryBtn} type="submit" disabled={isPending}>
        {isPending ? 'Saving…' : 'Save and continue'}
      </button>
    </form>
  )
}
