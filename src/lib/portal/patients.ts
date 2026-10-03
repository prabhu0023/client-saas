import { createClient } from '@/lib/supabase/server'
import {
  escapeLikePattern,
  normalizeSearchTerm,
  type ValidatedNewPatient,
} from './patient-validate'

/**
 * Portal-side patient lookup and inline creation for staff booking
 * (T1/T2, requirements R1/R2/R5).
 *
 * Runs on the RLS-respecting cookie client, so a staff member can only
 * reach patients of clinics they're an active member of. Every statement
 * ALSO passes `.eq('clinic_id', clinicId)` explicitly: RLS is the
 * security boundary, the filter is defence in depth plus the thing that
 * picks the right tenant for a multi-clinic user — same contract as
 * src/lib/portal/messages.ts and appointments.ts.
 *
 * Search issues TWO `.ilike()` reads (name, phone) and merges them in
 * JS rather than one `.or()`. `.or()` takes a RAW PostgREST filter
 * string, so a comma or a parenthesis in a typed patient name would
 * either break the query or inject extra filter conditions into it;
 * `.ilike()` sends the value as a parameterised filter, which a typed
 * name can never escape. Two round trips, issued in parallel, is the
 * price of that.
 */

export interface PatientRef {
  id: string
  fullName: string | null
  waPhone: string
  dateOfBirth: string | null
}

const COLUMNS = 'id, full_name, wa_phone, date_of_birth'

interface PatientRow {
  id: string
  full_name: string | null
  wa_phone: string
  date_of_birth: string | null
}

function toRef(row: PatientRow): PatientRef {
  return {
    id: row.id,
    fullName: row.full_name,
    waPhone: row.wa_phone,
    dateOfBirth: row.date_of_birth,
  }
}

/**
 * Patients in the clinic whose name OR phone contains the typed term,
 * case-insensitively (R1). Returns [] for a term the type-ahead must not
 * query on (blank, one character) so no keystroke becomes a table scan.
 */
export async function searchPatients(
  clinicId: string,
  rawTerm: string,
  limit = 10,
): Promise<PatientRef[]> {
  const term = normalizeSearchTerm(rawTerm)
  if (!term.ok) return []

  const pattern = `%${escapeLikePattern(term.value)}%`
  const supabase = await createClient()

  const [byName, byPhone] = await Promise.all([
    supabase
      .from('patients')
      .select(COLUMNS)
      .eq('clinic_id', clinicId)
      .ilike('full_name', pattern)
      .limit(limit),
    supabase
      .from('patients')
      .select(COLUMNS)
      .eq('clinic_id', clinicId)
      .ilike('wa_phone', pattern)
      .limit(limit),
  ])

  if (byName.error) throw new Error(`patient search failed: ${byName.error.message}`)
  if (byPhone.error) throw new Error(`patient search failed: ${byPhone.error.message}`)

  // A patient matching both columns must appear once, so dedupe by id.
  const merged = new Map<string, PatientRef>()
  for (const row of [
    ...((byName.data ?? []) as unknown as PatientRow[]),
    ...((byPhone.data ?? []) as unknown as PatientRow[]),
  ]) {
    if (!merged.has(row.id)) merged.set(row.id, toRef(row))
  }

  return [...merged.values()]
    .sort(
      (a, b) =>
        (a.fullName ?? '').localeCompare(b.fullName ?? '') ||
        a.waPhone.localeCompare(b.waPhone),
    )
    .slice(0, limit)
}

/**
 * One patient, or null when they don't exist — which is also what a
 * patient id belonging to another clinic returns, so a forged id reads
 * as a 404 without leaking existence (same no-leak contract as
 * getThread).
 */
export async function getPatient(
  clinicId: string,
  patientId: string,
): Promise<PatientRef | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('patients')
    .select(COLUMNS)
    .eq('id', patientId)
    .eq('clinic_id', clinicId)
    .maybeSingle()

  if (error) throw new Error(`patient fetch: ${error.message}`)
  if (!data) return null
  return toRef(data as unknown as PatientRow)
}

/**
 * Create the patient staff just typed in, or hand back the one that
 * already holds this number (R2: reuse, don't error).
 *
 * Deliberately an insert-then-reread rather than an upsert: the existing
 * row's curated full_name / DOB / notes must survive, and an upsert
 * would overwrite them with whatever was typed into the quick add form.
 * UNIQUE (clinic_id, wa_phone) from migration 001 is what makes the race
 * safe — the loser reads the winner's row (same pattern as
 * openThreadForPatient).
 */
export async function createOrReusePatient(
  clinicId: string,
  input: ValidatedNewPatient,
): Promise<{ patient: PatientRef; reused: boolean }> {
  const supabase = await createClient()

  const { data: created, error: insertErr } = await supabase
    .from('patients')
    .insert({
      clinic_id: clinicId,
      wa_phone: input.waPhone,
      full_name: input.fullName,
      date_of_birth: input.dateOfBirth,
      notes: input.notes,
    })
    .select(COLUMNS)
    .maybeSingle()

  if (!insertErr) {
    if (created) {
      return { patient: toRef(created as unknown as PatientRow), reused: false }
    }
    // Insert reported success but returned nothing (RLS can hide the
    // RETURNING row, as openThreadForPatient documents); read it back.
    const row = await findByPhone(supabase, clinicId, input.waPhone)
    if (row) return { patient: row, reused: false }
    throw new Error('patient create failed: inserted row not readable')
  }

  // 23505 = unique violation: this number is already a patient here.
  if (insertErr.code === '23505') {
    const row = await findByPhone(supabase, clinicId, input.waPhone)
    if (row) return { patient: row, reused: true }
  }

  throw new Error(`patient create failed: ${insertErr.message}`)
}

/** The existing patient for (clinic, wa_phone), or null. */
async function findByPhone(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  waPhone: string,
): Promise<PatientRef | null> {
  const { data, error } = await supabase
    .from('patients')
    .select(COLUMNS)
    .eq('clinic_id', clinicId)
    .eq('wa_phone', waPhone)
    .maybeSingle()

  if (error) throw new Error(`patient lookup failed: ${error.message}`)
  if (!data) return null
  return toRef(data as unknown as PatientRow)
}
