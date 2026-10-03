import { createClient } from '@/lib/supabase/server'
import { getDoctorNameMap } from './doctors'
import { parsePriceToCents, validateServiceName } from './onboarding-validate'
import type { DoctorRef } from './availability'

/**
 * The /services read/write layer (ONB-3, FR-3.1–FR-3.5).
 *
 * Everything goes through the RLS cookie client. 014 splits `services`
 * and `doctor_services` into member-read + admin-write policies, so the
 * database refuses a non-admin write whether or not `requireAdmin()` ever
 * ran — this module does not re-check the role.
 *
 * Two shapes here are deliberate:
 *
 * - Prices arrive as a MAJOR-UNIT STRING ('450', '450.50') and are
 *   converted here by `parsePriceToCents`, so no float ever reaches
 *   `services.price_cents` and '450.555' is refused rather than rounded
 *   (§9.5, §12.1).
 * - There is no `deleteService()`, and there never should be.
 *   `appointments.service_id` is `ON DELETE SET NULL` (001), so deleting a
 *   service would silently rewrite what past appointments were for.
 *   `setServiceActive(…, false)` is the only removal (FR-3.3).
 *
 * The doctor mapping is replaced by `set_doctor_services` (014) rather
 * than by a delete-then-insert pair from here: it validates both
 * clinic-scoped sides in one transaction, so the screen can never show a
 * half-applied mapping (§9.5).
 */

/** §12.2's services copy, exported so the page's error map cannot drift. */
export const SERVICE_MESSAGES = {
  duplicateName: 'A service with that name already exists.',
  doctorNotInClinic: 'One of those doctors is no longer available.',
  serviceNotFound: 'That service is no longer available.',
  adminsOnly: 'Admins only.',
} as const

// ------------------------------------------------------------
// Listing
// ------------------------------------------------------------

export interface ServiceListItem {
  id: string
  name: string
  /** Integer cents, exactly as stored. */
  priceCents: number
  active: boolean
  /** The doctors offering this service, labelled for display. */
  doctors: DoctorRef[]
  createdAt: string
}

/**
 * Every service in the clinic with its price, active flag and the doctors
 * who offer it (FR-3.5).
 *
 * Three reads rather than one join, for the same reason `listMembers()`
 * splits: the doctor LABEL is a name from `users`, which RLS scopes to
 * the caller's own row, so it comes from `clinic_doctor_names` (010) via
 * `getDoctorNameMap()`. Labelling matches `listClinicDoctors()` — name
 * with specialty appended when both are known, then specialty, then a
 * short id — so the same doctor reads the same way on /availability and
 * here.
 *
 * Inactive services are listed too: deactivation is this screen's only
 * removal, so hiding them would make it look like a delete.
 */
export async function listServices(clinicId: string): Promise<ServiceListItem[]> {
  const supabase = await createClient()

  const [services, links, profiles, names] = await Promise.all([
    supabase
      .from('services')
      .select('id, name, price_cents, active, created_at')
      .eq('clinic_id', clinicId)
      .order('active', { ascending: false })
      .order('name', { ascending: true }),
    supabase
      .from('doctor_services')
      .select('service_id, doctor_id')
      .eq('clinic_id', clinicId),
    supabase
      .from('doctor_profiles')
      .select('id, specialty')
      .eq('clinic_id', clinicId),
    getDoctorNameMap(clinicId),
  ])

  if (services.error) throw new Error(`services fetch: ${services.error.message}`)
  if (links.error) throw new Error(`doctor services fetch: ${links.error.message}`)
  if (profiles.error) {
    throw new Error(`doctor profiles fetch: ${profiles.error.message}`)
  }

  const labelById = new Map<string, string>()
  for (const row of (profiles.data ?? []) as unknown as Array<{
    id: string
    specialty: string | null
  }>) {
    labelById.set(row.id, doctorLabel(row.id, row.specialty, names.get(row.id)))
  }

  const doctorsByService = new Map<string, DoctorRef[]>()
  for (const row of (links.data ?? []) as unknown as Array<{
    service_id: string
    doctor_id: string
  }>) {
    const list = doctorsByService.get(row.service_id) ?? []
    list.push({
      id: row.doctor_id,
      label: labelById.get(row.doctor_id) ?? doctorLabel(row.doctor_id, null, undefined),
    })
    doctorsByService.set(row.service_id, list)
  }

  return ((services.data ?? []) as unknown as Array<{
    id: string
    name: string
    price_cents: number
    active: boolean
    created_at: string
  }>).map((s) => ({
    id: s.id,
    name: s.name,
    priceCents: s.price_cents,
    active: s.active,
    doctors: (doctorsByService.get(s.id) ?? []).sort((a, b) =>
      a.label.localeCompare(b.label),
    ),
    createdAt: s.created_at,
  }))
}

/** Same rule as listClinicDoctors(), so one doctor reads one way. */
function doctorLabel(
  id: string,
  specialty: string | null,
  name: string | undefined,
): string {
  if (name && specialty) return `${name} (${specialty})`
  if (name) return name
  return specialty ?? `Doctor ${id.slice(0, 8)}`
}

// ------------------------------------------------------------
// Create / edit
// ------------------------------------------------------------

export interface ServiceInput {
  /** Raw from the form; trimmed and length-checked here. */
  name: string
  /** Raw major-unit string ('450', '450.50'); converted to cents here. */
  price: string
}

export type ServiceWriteResult =
  | { status: 'ok'; id: string }
  /** A field the validators own. `message` is §12.1's copy for it. */
  | { status: 'invalid'; field: 'name' | 'price'; message: string }
  /** RLS filtered the row away: not this clinic's service any more. */
  | { status: 'not_found' }
  | { status: 'error'; message: string }

/**
 * Create a service (FR-3.2). New services start active, which is what
 * turns /setup's advisory services item green.
 *
 * The duplicate-active-name check lives in the action (§12.1): it needs
 * the clinic's current list, and the database has no unique constraint to
 * lean on here — a deactivated service is allowed to share a name with
 * the active one that replaced it.
 */
export async function createService(
  clinicId: string,
  input: ServiceInput,
): Promise<ServiceWriteResult> {
  const parsed = parseServiceInput(input)
  if ('status' in parsed) return parsed

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('services')
    .insert({
      clinic_id: clinicId,
      name: parsed.name,
      price_cents: parsed.priceCents,
      active: true,
    })
    .select('id')

  if (error) {
    console.error(`[services] create failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  const row = ((data ?? []) as unknown as Array<{ id: string }>)[0]
  if (!row) return { status: 'error', message: 'insert returned no row' }

  console.info(`[services] created ${row.id} for clinic ${clinicId}`)
  return { status: 'ok', id: row.id }
}

/** Edit a service's name and price (FR-3.2). The active flag is untouched. */
export async function updateService(
  clinicId: string,
  serviceId: string,
  input: ServiceInput,
): Promise<ServiceWriteResult> {
  const parsed = parseServiceInput(input)
  if ('status' in parsed) return parsed

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('services')
    .update({ name: parsed.name, price_cents: parsed.priceCents })
    .eq('id', serviceId)
    .eq('clinic_id', clinicId)
    .select('id')

  if (error) {
    console.error(`[services] update of ${serviceId} failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  // A failing USING filters rows rather than raising, so empty is "not yours".
  if (((data ?? []) as unknown[]).length === 0) return { status: 'not_found' }
  return { status: 'ok', id: serviceId }
}

/**
 * Validate the form pair once, for both writes. Returns either the typed
 * values or the refusal the caller passes straight back.
 */
function parseServiceInput(
  input: ServiceInput,
): { name: string; priceCents: number } | Extract<ServiceWriteResult, { status: 'invalid' }> {
  const name = validateServiceName(input.name)
  if (!name.ok) return { status: 'invalid', field: 'name', message: name.error }

  const price = parsePriceToCents(input.price)
  if (!price.ok) return { status: 'invalid', field: 'price', message: price.error }

  return { name: name.value, priceCents: price.value }
}

// ------------------------------------------------------------
// Deactivate — the only removal there is
// ------------------------------------------------------------

export type SetServiceActiveResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'error'; message: string }

/**
 * Deactivate or re-activate a service (FR-3.3).
 *
 * This is deliberately an UPDATE of `active` and never a DELETE:
 * `appointments.service_id` is `ON DELETE SET NULL`, so removing the row
 * would leave past appointments pointing at nothing — history rewritten
 * by a tidy-up. A deactivated service stops being offered and keeps
 * every reference it ever had.
 */
export async function setServiceActive(
  clinicId: string,
  serviceId: string,
  active: boolean,
): Promise<SetServiceActiveResult> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('services')
    .update({ active })
    .eq('id', serviceId)
    .eq('clinic_id', clinicId)
    .select('id')

  if (error) {
    console.error(`[services] active=${active} on ${serviceId} failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  if (((data ?? []) as unknown[]).length === 0) return { status: 'not_found' }

  console.info(`[services] ${serviceId} active=${active}`)
  return { status: 'ok' }
}

// ------------------------------------------------------------
// Doctor mapping
// ------------------------------------------------------------

export type SetServiceDoctorsResult =
  | { status: 'ok'; linked: number }
  /** An id that is not a doctor profile of this clinic — or no longer one. */
  | { status: 'doctor_not_in_clinic' }
  | { status: 'service_not_found' }
  | { status: 'forbidden' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }

interface SetDoctorServicesRow {
  outcome:
    | 'ok'
    | 'doctor_not_in_clinic'
    | 'service_not_found'
    | 'forbidden'
    | 'unauthenticated'
  linked: number | null
}

/**
 * Replace the whole set of doctors offering a service (FR-3.4).
 *
 * One RPC, one transaction: `set_doctor_services` (014) resolves the
 * clinic from the SERVICE — the caller never supplies one — re-checks
 * `is_clinic_admin()` on it, refuses the whole call if any supplied id is
 * not a doctor profile of that clinic, then deletes the unwanted pairs
 * and inserts the missing ones. A client-side delete-then-insert pair
 * would be two statements and could leave the screen showing a
 * half-applied mapping.
 *
 * An EMPTY array is a legitimate request: it clears the mapping.
 */
export async function setServiceDoctors(
  serviceId: string,
  doctorIds: string[],
): Promise<SetServiceDoctorsResult> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('set_doctor_services', {
    p_service_id: serviceId,
    p_doctor_ids: doctorIds,
  })

  if (error) {
    console.error(`[services] set_doctor_services failed: ${error.message}`)
    return { status: 'error', message: error.message }
  }

  const row = (Array.isArray(data) ? data[0] : data) as SetDoctorServicesRow | undefined
  if (!row) return { status: 'error', message: 'empty rpc result' }

  switch (row.outcome) {
    case 'ok':
      return { status: 'ok', linked: row.linked ?? 0 }
    case 'doctor_not_in_clinic':
    case 'service_not_found':
    case 'forbidden':
    case 'unauthenticated':
      // Each of these means the UI offered something the database refuses,
      // i.e. a stale screen or a crafted post (§12.2).
      console.error(`[services] mapping refused for ${serviceId}: ${row.outcome}`)
      return { status: row.outcome }
    default:
      return { status: 'error', message: `unknown outcome: ${row.outcome}` }
  }
}
