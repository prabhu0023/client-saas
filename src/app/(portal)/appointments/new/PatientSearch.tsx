'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { searchPatientsAction } from './actions'
import { AddPatientForm } from './AddPatientForm'
import type { PatientRef } from '@/lib/portal/patients'
import styles from './new-appointment.module.css'

/**
 * Step 1's type-ahead (T1). A client component because the search runs
 * per keystroke, which needs two things a form submit can't give:
 *
 *  - a debounce, so one query goes out per pause rather than one per
 *    letter;
 *  - a request sequence number, because the results come back out of
 *    order under load, and a slow response for 'as' arriving after the
 *    fast one for 'asha' would silently replace the right list with a
 *    stale one. Only a reply whose sequence is still the latest is
 *    rendered.
 *
 * Selecting a patient navigates rather than storing state, so the
 * selection lands in the URL and the server re-renders the real slot
 * list for it. The match count is announced in a live region: the list
 * appears without any focus change, which a screen reader would
 * otherwise never mention.
 */

/** One query per pause, not per keystroke. */
const DEBOUNCE_MS = 250

export function PatientSearch({
  doctorId,
  dateYmd,
}: {
  doctorId: string
  dateYmd: string
}) {
  const router = useRouter()
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<PatientRef[]>([])
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Monotonic request id; a reply that isn't the latest is dropped.
  const seq = useRef(0)

  useEffect(() => {
    const trimmed = term.trim()
    // Too short to query on — onChange already cleared the list.
    if (trimmed.length < 2) return

    const mine = ++seq.current
    const timer = setTimeout(() => {
      searchPatientsAction(trimmed)
        .then((found) => {
          if (seq.current !== mine) return
          setResults(found)
          setSearched(true)
          setError(null)
        })
        .catch(() => {
          if (seq.current !== mine) return
          setResults([])
          setSearched(true)
          setError('patient search failed — try again')
        })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [term])

  /**
   * Clearing happens here rather than in the effect: a term that's too
   * short must drop the old results immediately, and bumping the
   * sequence invalidates any reply still in flight for the longer term.
   */
  function onTermChange(next: string) {
    setTerm(next)
    if (next.trim().length < 2) {
      seq.current++
      setResults([])
      setSearched(false)
      setError(null)
    }
  }

  function select(patientId: string) {
    router.push(
      `/appointments/new?patient=${patientId}&doctor=${doctorId}&date=${dateYmd}`,
    )
  }

  const announcement = !searched
    ? ''
    : results.length === 0
      ? 'No matching patients'
      : `${results.length} matching patient${results.length === 1 ? '' : 's'}`

  return (
    <div className={styles.searchBlock}>
      <label className={styles.pickerLabel} htmlFor="patient-search">
        Find the patient
      </label>
      <input
        className={styles.searchInput}
        id="patient-search"
        type="search"
        autoComplete="off"
        value={term}
        onChange={(e) => onTermChange(e.target.value)}
        placeholder="Asha, or 90000"
        aria-describedby="patient-search-hint"
      />
      <p className={styles.hint} id="patient-search-hint">
        Search by name or phone. Type at least 2 characters.
      </p>

      <p className={styles.srStatus} role="status">
        {announcement}
      </p>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {searched && results.length > 0 && (
        <ul className={styles.results}>
          {results.map((p) => (
            <li key={p.id}>
              <button
                className={styles.result}
                type="button"
                onClick={() => select(p.id)}
              >
                <span className={styles.resultName}>
                  {p.fullName ?? 'Unnamed patient'}
                </span>
                <span className={styles.resultMeta}>{p.waPhone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {searched && results.length === 0 && !error && (
        <p className={styles.emptyInline}>No matching patients.</p>
      )}

      <button
        className={styles.toggle}
        type="button"
        aria-expanded={adding}
        onClick={() => setAdding((v) => !v)}
      >
        {adding ? 'Cancel new patient' : 'Not found? Add new patient'}
      </button>

      {adding && <AddPatientForm doctorId={doctorId} dateYmd={dateYmd} />}
    </div>
  )
}
