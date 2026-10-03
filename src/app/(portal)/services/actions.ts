'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/portal/roles'
import {
  createService,
  listServices,
  setServiceActive,
  setServiceDoctors,
  updateService,
  type ServiceWriteResult,
} from '@/lib/portal/services'

/**
 * Admin actions on /services (FR-3.1–FR-3.5).
 *
 * The clinic id always comes from requireAdmin()'s context, never from
 * the form, and 014's admin-write policies re-check it in the database —
 * so a crafted post carrying another clinic's service id updates nothing.
 *
 * Every action redirects with an `?error=`/`?saved=` code rather than
 * throwing: a thrown action error is redacted to a digest in production
 * and the (portal) group has no error boundary. redirect() is therefore
 * always called OUTSIDE try/catch, since Next implements it by throwing.
 *
 * Nothing here deletes a service. Deactivation is the only removal
 * (FR-3.3) — `appointments.service_id` is ON DELETE SET NULL, so a hard
 * delete would quietly rewrite what past appointments were for.
 */

/** The duplicate-name rule is case-insensitive and applies to ACTIVE services. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Reject a name that an ACTIVE service already uses (§12.1). Deactivated
 * services are exempt: keeping the old row is the whole point of FR-3.3,
 * and the replacement is usually called the same thing.
 */
async function duplicateActiveName(
  clinicId: string,
  name: string,
  exceptId: string | null,
): Promise<boolean> {
  const services = await listServices(clinicId)
  return services.some(
    (s) => s.active && s.id !== exceptId && sameName(s.name, name),
  )
}

/** Map the shared create/update refusals to their query-string codes. */
function writeOutcome(result: ServiceWriteResult, saved: string): string {
  if (result.status === 'invalid') {
    return result.field === 'name' ? 'error=name' : 'error=price'
  }
  if (result.status === 'not_found') return 'error=not-found'
  if (result.status === 'error') return 'error=failed'

  revalidateServices()
  return `saved=${saved}`
}

/**
 * An active service is a /setup checklist item, so the checklist has to
 * be re-rendered as well as this screen. The layout is NOT revalidated:
 * `getSetupStatus().complete` deliberately excludes the services item
 * (it is advisory), so the "Finish setup" link cannot change here.
 */
function revalidateServices(): void {
  revalidatePath('/services')
  revalidatePath('/setup')
}

/** Create a service (FR-3.2). New services start active. */
export async function addService(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const name = String(formData.get('name') ?? '')
  const price = String(formData.get('price') ?? '')

  if (await duplicateActiveName(clinic.id, name, null)) {
    redirect('/services?error=duplicate')
  }

  const result = await createService(clinic.id, { name, price })
  redirect(`/services?${writeOutcome(result, 'created')}`)
}

/** Edit a service's name and price (FR-3.2). The active flag is untouched. */
export async function editService(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const serviceId = String(formData.get('serviceId') ?? '')
  const name = String(formData.get('name') ?? '')
  const price = String(formData.get('price') ?? '')

  if (await duplicateActiveName(clinic.id, name, serviceId)) {
    redirect('/services?error=duplicate')
  }

  const result = await updateService(clinic.id, serviceId, { name, price })
  redirect(`/services?${writeOutcome(result, 'updated')}`)
}

/**
 * Deactivate or re-activate a service (FR-3.3). Deactivating is this
 * screen's delete: the row stays, so appointments that referenced it keep
 * reading correctly.
 */
export async function toggleServiceActive(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()
  const serviceId = String(formData.get('serviceId') ?? '')
  const raw = String(formData.get('active') ?? '')

  if (raw !== 'true' && raw !== 'false') redirect('/services?error=failed')
  const active = raw === 'true'

  const result = await setServiceActive(clinic.id, serviceId, active)

  if (result.status === 'not_found') redirect('/services?error=not-found')
  if (result.status === 'error') redirect('/services?error=failed')

  revalidateServices()
  redirect(`/services?saved=${active ? 'activated' : 'deactivated'}`)
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Set which doctors offer a service (FR-3.4).
 *
 * The form submits the WHOLE set as checkboxes, and one RPC call replaces
 * it atomically. No boxes ticked means an empty array, which clears the
 * mapping — a legitimate state, not a missing value, which is why this
 * reads `getAll()` rather than treating absence as "no change".
 *
 * The ids are shape-checked here only so a malformed post surfaces as the
 * product's copy instead of a Postgres cast error; the real check is the
 * RPC's, which refuses any id that is not a doctor profile of this clinic.
 */
export async function saveServiceDoctors(formData: FormData): Promise<void> {
  await requireAdmin()
  const serviceId = String(formData.get('serviceId') ?? '')
  const doctorIds = formData.getAll('doctorIds').map((v) => String(v))

  if (doctorIds.some((id) => !UUID_RE.test(id))) {
    console.error(`[services] mapping rejected for ${serviceId}: malformed doctor id`)
    redirect('/services?error=doctor-not-available')
  }

  const result = await setServiceDoctors(serviceId, doctorIds)

  if (result.status === 'doctor_not_in_clinic') {
    redirect('/services?error=doctor-not-available')
  }
  if (result.status === 'service_not_found') redirect('/services?error=not-found')
  if (result.status === 'forbidden' || result.status === 'unauthenticated') {
    redirect('/services?error=forbidden')
  }
  if (result.status === 'error') redirect('/services?error=failed')

  revalidateServices()
  redirect('/services?saved=doctors')
}
