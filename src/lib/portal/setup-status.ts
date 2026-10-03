import { createClient } from '@/lib/supabase/server'

/**
 * The /setup checklist probe (FR-1.10): what is still missing before the
 * clinic can take a booking over WhatsApp.
 *
 * Four independent existence reads through the RLS client, run in
 * parallel. Each one DEGRADES to false on a DB error instead of
 * throwing: the checklist is a hint, and losing the whole portal chrome
 * (the layout renders "Finish setup" from this) because one probe timed
 * out would be a worse failure than one item reading "not done yet".
 */

export interface SetupStatus {
  /** An active clinic_wacrm_accounts row — the last hop of PRD §8. */
  whatsappConnected: boolean
  /** At least one bookable doctor; see hasDoctor's note below. */
  hasDoctor: boolean
  hasAvailability: boolean
  /** Advisory only — a clinic can take bookings with no services. */
  hasService: boolean
  /**
   * True when the clinic is bookable over WhatsApp: connected, with a
   * doctor and some availability. `hasService` is deliberately NOT part
   * of it (FR-1.10 marks that item advisory), so a clinic that never
   * sells named services is not held permanently incomplete — and the
   * "Finish setup" nav link, which keys on this, does go away.
   */
  complete: boolean
}

/**
 * The saved WhatsApp identity, echoed back on /setup verbatim for
 * eyeball verification — there is no way to verify a wacrm account id
 * against wacrm itself (§9.2), so comparing it by eye with what wacrm
 * shows is the check that exists.
 */
export interface SavedWacrmConnection {
  wacrmAccountId: string
  phoneNumberId: string | null
  displayNumber: string | null
}

export async function getSetupStatus(clinicId: string): Promise<SetupStatus> {
  const supabase = await createClient()

  const [whatsappConnected, hasDoctor, hasAvailability, hasService] =
    await Promise.all([
      probe('wacrm', () =>
        supabase
          .from('clinic_wacrm_accounts')
          .select('id')
          .eq('clinic_id', clinicId)
          .eq('status', 'active')
          .limit(1),
      ),
      // A bookable doctor is a doctor_profiles row whose MEMBERSHIP is
      // active — never `role = 'doctor'` (FR-1.10, §9.4a). Keying on the
      // role would leave a solo admin-owner clinic unable to turn this
      // item green, and it would also disagree with every existing
      // doctor reader (loadDoctorOptions, listClinicDoctors,
      // getDoctorSlotMinutes, clinic_doctor_names), all of which select
      // on member status alone.
      probe('doctor', () =>
        supabase
          .from('doctor_profiles')
          .select('id, clinic_members!inner(status)')
          .eq('clinic_id', clinicId)
          .eq('clinic_members.status', 'active')
          .limit(1),
      ),
      // Inactive rules generate no slots, so they do not count.
      probe('availability', () =>
        supabase
          .from('availability_rules')
          .select('id')
          .eq('clinic_id', clinicId)
          .eq('active', true)
          .limit(1),
      ),
      probe('service', () =>
        supabase
          .from('services')
          .select('id')
          .eq('clinic_id', clinicId)
          .eq('active', true)
          .limit(1),
      ),
    ])

  return {
    whatsappConnected,
    hasDoctor,
    hasAvailability,
    hasService,
    complete: whatsappConnected && hasDoctor && hasAvailability,
  }
}

/**
 * The clinic's active wacrm mapping and active WhatsApp number, for the
 * Connect WhatsApp form's prefill. null when nothing is connected yet.
 *
 * Two reads rather than a join: the number row is optional and lives in a
 * different table (`clinic_whatsapp_numbers`, written by the same RPC),
 * and a missing number must not hide the account id.
 */
export async function getSavedWacrmConnection(
  clinicId: string,
): Promise<SavedWacrmConnection | null> {
  const supabase = await createClient()

  const { data: account, error: accountErr } = await supabase
    .from('clinic_wacrm_accounts')
    .select('wacrm_account_id')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (accountErr) {
    console.error(`[onboarding] wacrm connection read failed: ${accountErr.message}`)
    return null
  }
  if (!account) return null

  const { data: number } = await supabase
    .from('clinic_whatsapp_numbers')
    .select('phone_number_id, display_number')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  const row = account as unknown as { wacrm_account_id: string }
  const num = (number ?? null) as unknown as {
    phone_number_id: string
    display_number: string | null
  } | null

  return {
    wacrmAccountId: row.wacrm_account_id,
    phoneNumberId: num?.phone_number_id ?? null,
    displayNumber: num?.display_number ?? null,
  }
}

/** Run one existence read; a failure degrades that flag to false. */
async function probe(
  label: string,
  read: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<boolean> {
  try {
    const { data, error } = await read()
    if (error) {
      console.error(`[onboarding] setup probe ${label} failed: ${error.message}`)
      return false
    }
    return Array.isArray(data) && data.length > 0
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error'
    console.error(`[onboarding] setup probe ${label} threw: ${message}`)
    return false
  }
}
