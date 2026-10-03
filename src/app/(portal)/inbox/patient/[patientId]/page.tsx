import { notFound, redirect } from 'next/navigation'
import { requireStaff } from '@/lib/portal/auth'
import { openThreadForPatient } from '@/lib/portal/messages'

/**
 * Open a patient's chat by PATIENT id rather than thread id.
 *
 * The dashboard knows which patient a visit belongs to, not which
 * thread — and for most patients there is no thread yet, because
 * patient_threads rows are created by the inbound capture RPC when the
 * patient writes first. Linking an appointment straight at
 * /inbox/[threadId] would therefore dead-end for exactly the patients
 * staff most want to reach: the ones who just left the clinic.
 *
 * So this resolves patient → thread (creating an empty thread when
 * needed) and redirects to the one real chat screen, which keeps a
 * single implementation of the timeline, reply and escalate UI.
 *
 * A patient belonging to another clinic resolves to null → 404, so a
 * guessed id reveals nothing.
 */
export default async function PatientThreadPage({
  params,
}: {
  params: Promise<{ patientId: string }>
}) {
  const { clinic } = await requireStaff()
  const { patientId } = await params

  const threadId = await openThreadForPatient(clinic.id, patientId)
  if (!threadId) notFound()

  redirect(`/inbox/${threadId}`)
}
