'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/portal/roles'
import {
  validateDisplayNumber,
  validatePhoneNumberId,
  validateWacrmAccountId,
} from '@/lib/portal/onboarding-validate'
import { connectWacrmAccount } from '@/lib/portal/onboarding'

/**
 * Write the clinic's WhatsApp identity (FR-1.8/FR-1.9).
 *
 * The clinic id comes from requireAdmin()'s context, never from the form,
 * and the RPC re-checks it with is_clinic_admin() — so a crafted post
 * cannot connect someone else's clinic, it gets `forbidden`.
 *
 * Re-submitting the same account id is idempotent (§9.2 steps 4–5), which
 * is what makes correcting a typo a plain re-save rather than an operator
 * task. Nothing here discloses which clinic holds a taken id.
 */
export async function connectWhatsApp(formData: FormData): Promise<void> {
  const { clinic } = await requireAdmin()

  const accountId = validateWacrmAccountId(String(formData.get('wacrmAccountId') ?? ''))
  if (!accountId.ok) redirect('/setup?error=account')

  const phoneNumberId = validatePhoneNumberId(String(formData.get('phoneNumberId') ?? ''))
  if (!phoneNumberId.ok) redirect('/setup?error=phone')

  const displayNumber = validateDisplayNumber(String(formData.get('displayNumber') ?? ''))
  if (!displayNumber.ok) redirect('/setup?error=display')

  const result = await connectWacrmAccount({
    clinicId: clinic.id,
    wacrmAccountId: accountId.value,
    phoneNumberId: phoneNumberId.value,
    displayNumber: displayNumber.value,
  })

  if (result.status === 'wacrm_taken') {
    console.warn(`[onboarding] wacrm_taken for clinic ${clinic.id}`)
    redirect('/setup?error=wacrm-taken')
  }

  if (result.status === 'phone_number_taken') {
    console.warn(`[onboarding] phone_number_taken for clinic ${clinic.id}`)
    redirect('/setup?error=phone-taken')
  }

  if (result.status === 'forbidden') {
    // requireAdmin() already passed, so the two disagree — that is a bug
    // or a crafted request, not a user mistake.
    console.error(`[onboarding] connect refused as forbidden for clinic ${clinic.id}`)
    redirect('/setup?error=forbidden')
  }

  if (result.status === 'unauthenticated') redirect('/login')

  if (result.status === 'invalid') {
    console.error('[onboarding] connect_wacrm_account returned invalid — validator drift')
    redirect('/setup?error=account')
  }

  // Two admins saved at once; the transaction rolled back whole.
  if (result.status === 'conflict') redirect('/setup?error=raced')

  if (result.status === 'error') redirect('/setup?error=failed')

  revalidatePath('/setup')
  // The layout renders the "Finish setup" link from getSetupStatus().
  revalidatePath('/', 'layout')
  redirect('/setup?saved=1')
}
