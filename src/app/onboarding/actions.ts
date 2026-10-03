'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  isValidTimeZone,
  validateClinicName,
  validateSlug,
} from '@/lib/portal/onboarding-validate'
import { createClinic } from '@/lib/portal/onboarding'

/**
 * Create the clinic and the caller's founding admin membership (FR-1.4).
 *
 * One RPC call does the whole write (§9.1), so there is nothing to undo
 * here: every refusal is a returned outcome that happened before any
 * insert. Outcomes map to §12.2's rows, with the typed name and slug
 * carried back in the query string for the recoverable ones — a clinic
 * name is the value that becomes the public web address, not personal
 * data, so unlike /signup's email it is safe to echo.
 *
 * `redirect()` is outside any try/catch, as everywhere else in the repo.
 */
export async function createClinicAction(formData: FormData): Promise<void> {
  const rawName = String(formData.get('name') ?? '')
  const rawSlug = String(formData.get('slug') ?? '').trim()
  const rawTimezone = String(formData.get('timezone') ?? '').trim()

  const name = validateClinicName(rawName)
  if (!name.ok) redirect(back('name', { name: rawName, slug: rawSlug, tz: rawTimezone }))

  const slugProblem = validateSlug(rawSlug)
  if (slugProblem) {
    redirect(back('slug', { name: rawName, slug: rawSlug, tz: rawTimezone }))
  }

  if (!isValidTimeZone(rawTimezone)) {
    redirect(back('timezone', { name: rawName, slug: rawSlug, tz: rawTimezone }))
  }

  const result = await createClinic({
    name: name.value,
    slug: rawSlug,
    timezone: rawTimezone,
  })

  if (result.status === 'slug_taken') {
    console.warn(`[onboarding] slug_taken for slug ${rawSlug}`)
    redirect(back('slug-taken', { name: rawName, slug: rawSlug, tz: rawTimezone }))
  }

  if (result.status === 'membership_disabled') {
    console.warn('[onboarding] membership_disabled — refusing a second clinic')
    redirect('/onboarding?error=not-active')
  }

  if (result.status === 'unauthenticated') redirect('/login')

  if (result.status === 'invalid') {
    // The local validators above passed, so the RPC disagreeing with them
    // is validator drift, not user error (§12.2). The slug is the rule
    // written twice, so it is the field to point at.
    console.error(
      '[onboarding] create_clinic_with_owner returned invalid — validator drift',
    )
    redirect(back('slug', { name: rawName, slug: rawSlug, tz: rawTimezone }))
  }

  if (result.status === 'error') {
    redirect(back('failed', { name: rawName, slug: rawSlug, tz: rawTimezone }))
  }

  if (result.status === 'already_member') {
    console.warn('[onboarding] already_member — opening the existing clinic')
    redirect('/dashboard')
  }

  // The portal chrome renders the clinic name and the "Finish setup" link
  // from the layout, so the layout cache has to go too.
  revalidatePath('/', 'layout')
  redirect('/setup')
}

/** Re-render the form with the error and whatever was typed. */
function back(
  error: string,
  typed: { name: string; slug: string; tz: string },
): string {
  const params = new URLSearchParams({ error })
  if (typed.name) params.set('name', typed.name)
  if (typed.slug) params.set('slug', typed.slug)
  if (typed.tz) params.set('tz', typed.tz)
  return `/onboarding?${params.toString()}`
}
