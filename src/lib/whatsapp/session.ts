import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Conversation state for the text-driven wacrm booking flow, persisted
 * in `wa_sessions` (keyed by wacrm conversation_id). Because wacrm's
 * webhook forwards only free text (no tapped-row id), we remember which
 * numbered options we last offered so the next reply ('1', '2', ...)
 * can be resolved back to a doctor/day/slot id.
 */

export type FlowStep =
  | 'idle'
  | 'awaiting_doctor'
  | 'awaiting_day'
  | 'awaiting_time'
  | 'awaiting_cancel'

/** One numbered option we presented, so a typed reply can be matched. */
export interface FlowOption {
  /** 1-based position shown to the patient. */
  n: number
  /** The underlying id this option selects (doctorId, dateYmd, or hhmm). */
  id: string
  /** The label shown, used for fuzzy text matching as a fallback. */
  label: string
}

export interface FlowData {
  doctorId?: string
  dateYmd?: string
  /** The options presented in the message that put us in `step`. */
  options?: FlowOption[]
}

export interface WaSession {
  conversationId: string
  clinicId: string
  waPhone: string | null
  step: FlowStep
  data: FlowData
}

/**
 * Load a live (non-expired) session for a conversation. Returns null if
 * none exists or it has expired — the caller then starts fresh.
 */
export async function loadSession(
  conversationId: string,
): Promise<WaSession | null> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('wa_sessions')
    .select('conversation_id, clinic_id, wa_phone, step, data, expires_at')
    .eq('conversation_id', conversationId)
    .maybeSingle()

  if (error || !data) return null

  const row = data as {
    conversation_id: string
    clinic_id: string
    wa_phone: string | null
    step: FlowStep
    data: FlowData
    expires_at: string
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) return null

  return {
    conversationId: row.conversation_id,
    clinicId: row.clinic_id,
    waPhone: row.wa_phone,
    step: row.step,
    data: row.data ?? {},
  }
}

/**
 * Upsert a session, bumping its expiry. Sessions live 30 minutes from
 * the last write, so an abandoned flow restarts cleanly.
 */
export async function saveSession(session: WaSession): Promise<void> {
  const db = supabaseAdmin()
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const { error } = await db.from('wa_sessions').upsert(
    {
      conversation_id: session.conversationId,
      clinic_id: session.clinicId,
      wa_phone: session.waPhone,
      step: session.step,
      data: session.data,
      expires_at: expiresAt,
    },
    { onConflict: 'conversation_id' },
  )
  if (error) console.error('[wa/session] save failed:', error.message)
}

/** Clear a conversation's session (e.g. after a successful booking). */
export async function clearSession(conversationId: string): Promise<void> {
  const db = supabaseAdmin()
  const { error } = await db
    .from('wa_sessions')
    .delete()
    .eq('conversation_id', conversationId)
  if (error) console.error('[wa/session] clear failed:', error.message)
}

/**
 * Match a patient's typed reply against a list of numbered options.
 * Accepts a bare number ('2'), a number with punctuation ('2.'), or a
 * case-insensitive substring of the label ('rao'). Returns the matched
 * option, or null if nothing matches unambiguously.
 */
export function matchOption(
  text: string,
  options: FlowOption[],
): FlowOption | null {
  const trimmed = text.trim()

  // Numeric pick: leading integer.
  const numMatch = trimmed.match(/^(\d{1,2})/)
  if (numMatch) {
    const n = Number(numMatch[1])
    const byNumber = options.find((o) => o.n === n)
    if (byNumber) return byNumber
  }

  // Label substring (only if it hits exactly one option).
  const lower = trimmed.toLowerCase()
  if (lower.length >= 2) {
    const hits = options.filter((o) => o.label.toLowerCase().includes(lower))
    if (hits.length === 1) return hits[0]
  }

  return null
}
