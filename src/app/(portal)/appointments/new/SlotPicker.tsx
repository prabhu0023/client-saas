'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createAppointment } from './actions'
import styles from './new-appointment.module.css'

/**
 * Step 4's time buttons (T4). Each button submits only the slot's 'HHMM'
 * id — never an instant — so the server decides what times exist and the
 * client can only pick one of them.
 *
 * On any failure this renders the reason AND calls router.refresh(). The
 * refresh is the recovery, not a nicety: the server re-runs generateSlots
 * and the slot someone else just won disappears from the list, which is
 * what "re-offers the day's slots" means for R4. It mirrors the WhatsApp
 * flow re-entering the time step after a lost race.
 */
export function SlotPicker({
  patientId,
  doctorId,
  dateYmd,
  slots,
}: {
  patientId: string
  doctorId: string
  dateYmd: string
  /** Shaped from Slot on the server — only the id and its label. */
  slots: Array<{ hhmm: string; label: string }>
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function book(hhmm: string) {
    if (isPending) return

    const fd = new FormData()
    fd.set('patientId', patientId)
    fd.set('doctorId', doctorId)
    fd.set('date', dateYmd)
    fd.set('hhmm', hhmm)

    setError(null)
    startTransition(async () => {
      const result = await createAppointment(fd)
      if (result.error) {
        setError(result.error)
        // Re-read the day's slots so a time that's gone stops being offered.
        router.refresh()
        return
      }
      router.push(`/dashboard?date=${dateYmd}`)
      router.refresh()
    })
  }

  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.slots}>
        {slots.map((s) => (
          <button
            key={s.hhmm}
            className={styles.slotBtn}
            type="button"
            disabled={isPending}
            onClick={() => book(s.hhmm)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </>
  )
}
