import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WaSession } from './session'

/**
 * Integration test for the text-driven booking flow (E2-T1).
 *
 * Drives `handleTextMessage` through the full conversation as a patient
 * would — feeding inbound free text and asserting the outbound reply and
 * the resulting session state at each step:
 *
 *   idle → (keyword) → awaiting_doctor → awaiting_day → awaiting_time → book
 *
 * Everything at the module boundary is stubbed: the session store is an
 * in-memory map, the DB-backed query loaders and slot generation return
 * fixtures, and booking returns a scripted outcome. The timezone helpers
 * and the pure message builders run for real, so the asserted reply text
 * is exactly what a patient would receive.
 */

// ------------------------------------------------------------
// In-memory session store standing in for wa_sessions.
// ------------------------------------------------------------
const sessions = new Map<string, WaSession>()

const loadSessionMock = vi.fn(async (conversationId: string) =>
  sessions.get(conversationId) ?? null,
)
const saveSessionMock = vi.fn(async (session: WaSession) => {
  sessions.set(session.conversationId, session)
})
const clearSessionMock = vi.fn(async (conversationId: string) => {
  sessions.delete(conversationId)
})

vi.mock('./session', async () => {
  // Keep the real matchOption (pure); only stub the persistence fns.
  const actual = await vi.importActual<typeof import('./session')>('./session')
  return {
    ...actual,
    loadSession: (id: string) => loadSessionMock(id),
    saveSession: (s: WaSession) => saveSessionMock(s),
    clearSession: (id: string) => clearSessionMock(id),
  }
})

// ------------------------------------------------------------
// DB-backed query loaders (doctors / days / slot length).
// ------------------------------------------------------------
const loadDoctorOptionsMock = vi.fn()
const loadDoctorLabelMock = vi.fn()
const loadDoctorSlotMinutesMock = vi.fn()
const loadAvailableDaysMock = vi.fn()
const loadUpcomingAppointmentsMock = vi.fn()
const cancelAppointmentMock = vi.fn()

vi.mock('./query', () => ({
  loadDoctorOptions: (...a: unknown[]) => loadDoctorOptionsMock(...a),
  loadDoctorLabel: (...a: unknown[]) => loadDoctorLabelMock(...a),
  loadDoctorSlotMinutes: (...a: unknown[]) => loadDoctorSlotMinutesMock(...a),
  loadAvailableDays: (...a: unknown[]) => loadAvailableDaysMock(...a),
  loadUpcomingAppointments: (...a: unknown[]) =>
    loadUpcomingAppointmentsMock(...a),
  cancelAppointment: (...a: unknown[]) => cancelAppointmentMock(...a),
}))

// ------------------------------------------------------------
// Slot generation + booking.
// ------------------------------------------------------------
const generateSlotsMock = vi.fn()
vi.mock('@/lib/availability/slot-generation', () => ({
  generateSlots: (...a: unknown[]) => generateSlotsMock(...a),
}))

const bookAppointmentMock = vi.fn()
vi.mock('@/lib/booking/book', () => ({
  bookAppointment: (...a: unknown[]) => bookAppointmentMock(...a),
}))

// ------------------------------------------------------------
// loadClinic() reads clinics via supabaseAdmin(); return a fixed clinic.
// ------------------------------------------------------------
const CLINIC = { id: 'clinic-1', timezone: 'Asia/Kolkata' }
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: CLINIC, error: null }),
        }),
      }),
    }),
  }),
}))

import { handleTextMessage, type TextFlowInput } from './text-flow'

// ------------------------------------------------------------
// Fixtures + helpers.
// ------------------------------------------------------------
const CONV = 'conv-1'
const PHONE = '+919876543210'

const TWO_DOCTORS = [
  { id: 'doc-rao', label: 'Dr. Rao (General)' },
  { id: 'doc-iyer', label: 'Dr. Iyer (Pediatrics)' },
]

const DAYS = [
  { doctorId: 'doc-rao', dateYmd: '2026-09-28', label: 'Mon, Sep 28' },
  { doctorId: 'doc-rao', dateYmd: '2026-09-29', label: 'Tue, Sep 29' },
]

// Two slots on the chosen day (hhmm is the id the flow books from).
const SLOTS = [
  {
    doctorId: 'doc-rao',
    startsAtUtc: '2026-09-28T03:30:00.000Z',
    endsAtUtc: '2026-09-28T04:00:00.000Z',
    localLabel: '9:00 AM',
    hhmm: '0900',
  },
  {
    doctorId: 'doc-rao',
    startsAtUtc: '2026-09-28T04:00:00.000Z',
    endsAtUtc: '2026-09-28T04:30:00.000Z',
    localLabel: '9:30 AM',
    hhmm: '0930',
  },
]

function input(text: string): TextFlowInput {
  return { clinicId: CLINIC.id, conversationId: CONV, waPhone: PHONE, text }
}

async function send(text: string) {
  return handleTextMessage(input(text))
}

beforeEach(() => {
  sessions.clear()
  vi.clearAllMocks()
  // Sensible defaults; individual tests override as needed.
  loadDoctorOptionsMock.mockResolvedValue(TWO_DOCTORS)
  loadDoctorLabelMock.mockResolvedValue('Dr. Rao (General)')
  loadDoctorSlotMinutesMock.mockResolvedValue(30)
  loadAvailableDaysMock.mockResolvedValue(DAYS)
  generateSlotsMock.mockResolvedValue(SLOTS)
  bookAppointmentMock.mockResolvedValue({
    status: 'booked',
    appointmentId: 'appt-1',
    patientId: 'pat-1',
  })
  loadUpcomingAppointmentsMock.mockResolvedValue([
    { id: 'appt-A', doctorId: 'doc-rao', label: 'Mon, Sep 28 at 9:00 AM (General)' },
    { id: 'appt-B', doctorId: 'doc-iyer', label: 'Tue, Sep 29 at 10:00 AM (Pediatrics)' },
  ])
  cancelAppointmentMock.mockResolvedValue(true)
})

describe('handleTextMessage — full booking flow', () => {
  it('books end to end: keyword → doctor → day → time → confirmation', async () => {
    // 1. Keyword starts the flow → doctor menu.
    const r1 = await send('I need an appointment')
    expect(r1?.body).toContain('Which doctor')
    expect(r1?.body).toContain('1. Dr. Rao (General)')
    expect(sessions.get(CONV)?.step).toBe('awaiting_doctor')

    // 2. Pick doctor 1 → day menu.
    const r2 = await send('1')
    expect(r2?.body).toContain('Which day')
    expect(r2?.body).toContain('1. Mon, Sep 28')
    expect(sessions.get(CONV)?.step).toBe('awaiting_day')
    expect(sessions.get(CONV)?.data.doctorId).toBe('doc-rao')

    // 3. Pick day 1 → time menu.
    const r3 = await send('1')
    expect(r3?.body).toContain('pick a time')
    expect(r3?.body).toContain('1. 9:00 AM')
    expect(sessions.get(CONV)?.step).toBe('awaiting_time')
    expect(sessions.get(CONV)?.data.dateYmd).toBe('2026-09-28')

    // 4. Pick time 1 → booked + confirmation, session cleared.
    const r4 = await send('1')
    expect(bookAppointmentMock).toHaveBeenCalledTimes(1)
    expect(r4?.body).toContain('Confirmed!')
    expect(r4?.body).toContain('Dr. Rao (General)')
    expect(sessions.has(CONV)).toBe(false)
  })

  it('single-doctor clinic skips the doctor step and goes to days', async () => {
    loadDoctorOptionsMock.mockResolvedValue([TWO_DOCTORS[0]])

    const r1 = await send('appointment')
    // Straight to the day menu; no doctor prompt.
    expect(r1?.body).toContain('Which day')
    expect(sessions.get(CONV)?.step).toBe('awaiting_day')
    expect(sessions.get(CONV)?.data.doctorId).toBe('doc-rao')
  })
})

describe('handleTextMessage — non-happy paths', () => {
  it('no session + non-keyword text → fallback nudge, no session created', async () => {
    const r = await send('where are you located?')
    expect(r?.body).toContain('reply with "appointment"')
    expect(sessions.has(CONV)).toBe(false)
  })

  it('unrecognized reply at the doctor step → did-not-understand, stays put', async () => {
    await send('appointment') // → awaiting_doctor
    const r = await send('the third one please')
    expect(r?.body).toContain("didn't catch that")
    // Still awaiting a doctor pick.
    expect(sessions.get(CONV)?.step).toBe('awaiting_doctor')
    expect(bookAppointmentMock).not.toHaveBeenCalled()
  })

  it('slot taken mid-flow → re-offers the day’s times, session stays at time step', async () => {
    bookAppointmentMock.mockResolvedValue({ status: 'slot_taken' })

    await send('appointment') // doctor menu
    await send('1') // day menu
    await send('1') // time menu
    const r = await send('1') // attempt booking → slot_taken

    // Recovery: the time menu is shown again (still the same two slots).
    expect(r?.body).toContain('pick a time')
    expect(r?.body).toContain('1. 9:00 AM')
    expect(sessions.get(CONV)?.step).toBe('awaiting_time')
  })

  it('booking error resets the conversation to a fresh start', async () => {
    bookAppointmentMock.mockResolvedValue({ status: 'error', message: 'db down' })

    await send('appointment')
    await send('1')
    await send('1')
    const r = await send('1') // booking errors

    expect(r?.body).toContain('reply with "appointment"') // fallback
    expect(sessions.has(CONV)).toBe(false) // session cleared
  })

  it('no doctors configured → no-availability message', async () => {
    loadDoctorOptionsMock.mockResolvedValue([])
    const r = await send('appointment')
    expect(r?.body).toContain('no open slots')
    expect(sessions.has(CONV)).toBe(false)
  })

  it('doctor has no available days → no-availability message', async () => {
    loadAvailableDaysMock.mockResolvedValue([])
    await send('appointment') // doctor menu
    const r2 = await send('1') // pick doctor → tries days
    expect(r2?.body).toContain('no open slots')
  })
})

describe('handleTextMessage — cancel flow', () => {
  it('cancel keyword lists upcoming appointments', async () => {
    const r = await send('cancel')
    expect(r?.body).toContain('cancel')
    expect(r?.body).toContain('1. Mon, Sep 28 at 9:00 AM (General)')
    expect(sessions.get(CONV)?.step).toBe('awaiting_cancel')
  })

  it('"cancel my appointment" starts cancel, not a new booking', async () => {
    const r = await send('cancel my appointment')
    // Cancel menu, not the doctor menu.
    expect(r?.body).toContain('cancel')
    expect(sessions.get(CONV)?.step).toBe('awaiting_cancel')
    expect(loadDoctorOptionsMock).not.toHaveBeenCalled()
  })

  it('picking an appointment cancels it and confirms', async () => {
    await send('cancel') // → awaiting_cancel
    const r = await send('1') // pick the first

    expect(cancelAppointmentMock).toHaveBeenCalledWith(
      CLINIC.id,
      PHONE,
      'appt-A',
    )
    expect(r?.body).toContain('has been cancelled')
    expect(r?.body).toContain('Mon, Sep 28 at 9:00 AM (General)')
    expect(sessions.has(CONV)).toBe(false) // session cleared
  })

  it('no upcoming appointments → nothing-to-cancel message, no session', async () => {
    loadUpcomingAppointmentsMock.mockResolvedValue([])
    const r = await send('cancel')
    expect(r?.body).toContain('no upcoming appointments')
    expect(sessions.has(CONV)).toBe(false)
  })

  it('unrecognized pick at cancel step → did-not-understand, stays put', async () => {
    await send('cancel')
    const r = await send('the morning one')
    expect(r?.body).toContain("didn't catch that")
    expect(sessions.get(CONV)?.step).toBe('awaiting_cancel')
    expect(cancelAppointmentMock).not.toHaveBeenCalled()
  })

  it('appointment already gone (cancel returns false) → graceful fallback', async () => {
    cancelAppointmentMock.mockResolvedValue(false)
    await send('cancel')
    const r = await send('1')
    expect(r?.body).toContain('no upcoming appointments')
    expect(sessions.has(CONV)).toBe(false)
  })
})

describe('handleTextMessage — reschedule flow', () => {
  it('reschedule keyword lists upcoming appointments to move', async () => {
    const r = await send('reschedule')
    expect(r?.body).toContain('reschedule')
    expect(r?.body).toContain('1. Mon, Sep 28 at 9:00 AM (General)')
    expect(sessions.get(CONV)?.step).toBe('awaiting_reschedule')
  })

  it('"change my appointment" starts reschedule, not cancel or booking', async () => {
    const r = await send('change my appointment')
    expect(r?.body).toContain('reschedule')
    expect(sessions.get(CONV)?.step).toBe('awaiting_reschedule')
    expect(loadDoctorOptionsMock).not.toHaveBeenCalled()
  })

  it('full reschedule: pick appt → day → time → books new AND cancels old', async () => {
    await send('reschedule') // → awaiting_reschedule (lists appts)
    const rDay = await send('1') // pick appt-A (doc-rao) → day menu
    expect(rDay?.body).toContain('Which day')
    // carries the reschedule id + same doctor
    expect(sessions.get(CONV)?.data.rescheduleId).toBe('appt-A')
    expect(sessions.get(CONV)?.data.doctorId).toBe('doc-rao')

    const rTime = await send('1') // pick day → time menu
    expect(rTime?.body).toContain('pick a time')

    const rDone = await send('1') // pick time → book new + cancel old
    expect(bookAppointmentMock).toHaveBeenCalledTimes(1)
    expect(cancelAppointmentMock).toHaveBeenCalledWith(CLINIC.id, PHONE, 'appt-A')
    expect(rDone?.body).toContain('moved to')
    expect(sessions.has(CONV)).toBe(false)
  })

  it('does NOT cancel the old appointment if the new slot is taken', async () => {
    bookAppointmentMock.mockResolvedValue({ status: 'slot_taken' })

    await send('reschedule')
    await send('1') // pick appt-A → day
    await send('1') // pick day → time
    const r = await send('1') // attempt new booking → slot_taken

    // Old appointment untouched; patient keeps their original booking.
    expect(cancelAppointmentMock).not.toHaveBeenCalled()
    // Re-offered the times, still rescheduling.
    expect(r?.body).toContain('pick a time')
    expect(sessions.get(CONV)?.data.rescheduleId).toBe('appt-A')
  })

  it('does NOT cancel the old appointment if the new booking errors', async () => {
    bookAppointmentMock.mockResolvedValue({ status: 'error', message: 'db down' })

    await send('reschedule')
    await send('1')
    await send('1')
    const r = await send('1') // booking errors

    expect(cancelAppointmentMock).not.toHaveBeenCalled()
    expect(r?.body).toContain('reply with "appointment"') // fallback
    expect(sessions.has(CONV)).toBe(false)
  })

  it('no upcoming appointments → nothing-to-reschedule message', async () => {
    loadUpcomingAppointmentsMock.mockResolvedValue([])
    const r = await send('reschedule')
    expect(r?.body).toContain('no upcoming appointments')
    expect(sessions.has(CONV)).toBe(false)
  })
})
