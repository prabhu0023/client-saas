import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { myMembershipStatus } from '@/lib/portal/onboarding'
import { createClinicAction } from './actions'
import { SlugField } from './SlugField'
import styles from './onboarding.module.css'

/**
 * Create-clinic form (FR-1.4), deliberately OUTSIDE the (portal) group so
 * it never hits requireStaff() — which now sends a clinic-less user
 * exactly here, and would otherwise loop.
 *
 * It gates on a session only, then branches on my_membership_status():
 * an active member has a clinic already (FR-1.5), and a disabled or
 * 'invited' member must not create a second one. That branch needs the
 * SECURITY DEFINER RPC because RLS hides a non-active clinic_members row
 * from its own owner (§12.3) — and the same refusal is repeated by
 * create_clinic_with_owner, which is the real gate.
 */

const ERRORS: Record<string, string> = {
  name: 'Enter the clinic name.',
  // Only reachable by a crafted post — the field is a <select> of this
  // very list.
  timezone: 'Choose a timezone.',
  'not-active': 'Your access to this clinic is not active — contact your admin.',
  failed: 'We could not create the clinic. Try again.',
}

/** Rendered under the slug input rather than above the form. */

const FIELD_ERRORS: Record<string, string> = {
  'slug-taken': 'That web address is taken. Try another.',
  slug: 'Use 3–40 lowercase letters, numbers or single hyphens.',
}

/**
 * The timezone a clinic in the target market picks, kept explicitly:
 * Intl's list is CLDR-canonical, so it offers 'Asia/Calcutta' and has no
 * 'Asia/Kolkata' entry at all. Both are valid IANA names and both are in
 * pg_timezone_names, but 'Asia/Kolkata' is the spelling scripts/seed.ts
 * uses and the one an admin will look for.
 */
const PREFERRED_TIMEZONE = 'Asia/Kolkata'

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string
    name?: string
    slug?: string
    tz?: string
  }>
}) {
  // Session only — a user with no membership is exactly who this page is
  // for, so getStaffContext() (which returns null for them) cannot tell
  // us what we need.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const status = await myMembershipStatus()
  if (status === 'active') redirect('/dashboard')

  const { error, name, slug, tz } = await searchParams

  if (status === 'disabled' || status === 'invited') {
    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <h1 className={styles.title}>DoctorDesk</h1>
          <p className={styles.notice} role="status">
            {ERRORS['not-active']}
          </p>
          {/* /logout is POST-only, same as the portal header's control. */}
          <form className={styles.foot} action="/logout" method="post">
            <button className={styles.linkButton} type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>
    )
  }

  const message = error && ERRORS[error] ? ERRORS[error] : null
  const slugError = error ? FIELD_ERRORS[error] ?? null : null
  const timezones = timezoneOptions()
  const selectedTimezone =
    tz && timezones.includes(tz) ? tz : PREFERRED_TIMEZONE

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Name your clinic</h1>
        <p className={styles.subtitle}>
          This is the last step before the setup checklist.
        </p>

        {message && (
          <p className={styles.error} role="alert">
            {message}
          </p>
        )}

        <form action={createClinicAction}>
          <SlugField
            defaultName={name ?? ''}
            defaultSlug={slug ?? ''}
            error={slugError}
          />

          <div className={styles.field}>
            <label className={styles.label} htmlFor="timezone">
              Timezone
            </label>
            <select
              className={styles.select}
              id="timezone"
              name="timezone"
              required
              defaultValue={selectedTimezone}
              aria-describedby="timezone-hint"
            >
              {timezones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <p className={styles.hint} id="timezone-hint">
              Appointment times and WhatsApp slots are shown in this zone.
              It cannot be changed later.
            </p>
          </div>

          <button className={styles.button} type="submit">
            Create clinic
          </button>
        </form>
      </div>
    </div>
  )
}

/**
 * IANA names only, which is the set `create_clinic_with_owner` accepts
 * (`pg_timezone_names`) — so a value picked here cannot come back as the
 * `invalid` outcome §12.2 reads as a bug signal. Node-runtime only; none
 * of the onboarding routes opt into Edge.
 */
function timezoneOptions(): string[] {
  const zones = Intl.supportedValuesOf('timeZone')
  if (zones.includes(PREFERRED_TIMEZONE)) return zones
  return [...zones, PREFERRED_TIMEZONE].sort()
}
