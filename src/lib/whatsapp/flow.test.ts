import { describe, it, expect } from 'vitest'
import { decideAction, matchesBookingKeyword } from './flow'
import { encodeDayId, encodeSlotId } from '@/lib/booking/slot-id'
import type { InboundEvent } from './types'

const DOCTOR = '11111111-2222-3333-4444-555555555555'

function event(over: Partial<InboundEvent>): InboundEvent {
  return {
    phoneNumberId: 'pn-1',
    from: '+919876543210',
    wamid: 'wamid.1',
    ...over,
  }
}

describe('matchesBookingKeyword', () => {
  it('matches known keywords case-insensitively', () => {
    expect(matchesBookingKeyword('I need an APPOINTMENT')).toBe(true)
    expect(matchesBookingKeyword('hello sir')).toBe(true)
    expect(matchesBookingKeyword('book me in')).toBe(true)
  })
  it('does not match unrelated text', () => {
    expect(matchesBookingKeyword('what are your fees?')).toBe(false)
  })
})

describe('decideAction routing', () => {
  it('free-text keyword -> show_doctors', () => {
    expect(decideAction(event({ text: 'appointment' }))).toEqual({
      type: 'show_doctors',
    })
  })

  it('unrelated free text -> fallback', () => {
    expect(decideAction(event({ text: 'where are you located' }))).toEqual({
      type: 'fallback',
    })
  })

  it('doctor tap -> show_days', () => {
    expect(decideAction(event({ interactiveReplyId: `doc_${DOCTOR}` }))).toEqual({
      type: 'show_days',
      doctorId: DOCTOR,
    })
  })

  it('day tap -> show_times', () => {
    const id = encodeDayId(DOCTOR, '2026-09-22')
    expect(decideAction(event({ interactiveReplyId: id }))).toEqual({
      type: 'show_times',
      doctorId: DOCTOR,
      dateYmd: '2026-09-22',
    })
  })

  it('slot tap -> book', () => {
    const id = encodeSlotId(DOCTOR, '2026-09-22', '1000')
    expect(decideAction(event({ interactiveReplyId: id }))).toEqual({
      type: 'book',
      doctorId: DOCTOR,
      dateYmd: '2026-09-22',
      hhmm: '1000',
    })
  })

  it('reply id takes precedence over text', () => {
    const id = encodeSlotId(DOCTOR, '2026-09-22', '1000')
    const res = decideAction(
      event({ interactiveReplyId: id, text: 'appointment' }),
    )
    expect(res.type).toBe('book')
  })

  it('unknown reply id -> fallback (no guessing)', () => {
    expect(decideAction(event({ interactiveReplyId: 'garbage_xyz' }))).toEqual({
      type: 'fallback',
    })
  })

  it('empty event -> fallback', () => {
    expect(decideAction(event({}))).toEqual({ type: 'fallback' })
  })
})
