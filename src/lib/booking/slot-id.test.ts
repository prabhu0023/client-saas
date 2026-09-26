import { describe, it, expect } from 'vitest'
import {
  encodeDayId,
  encodeSlotId,
  parseDayId,
  parseSlotId,
} from './slot-id'

const DOCTOR = '11111111-2222-3333-4444-555555555555'

describe('slot-id encode/parse', () => {
  it('round-trips a day id (doctorId contains hyphens)', () => {
    const id = encodeDayId(DOCTOR, '2026-09-22')
    expect(id).toBe(`day_${DOCTOR}_2026-09-22`)
    expect(parseDayId(id)).toEqual({ doctorId: DOCTOR, dateYmd: '2026-09-22' })
  })

  it('round-trips a slot id', () => {
    const id = encodeSlotId(DOCTOR, '2026-09-22', '1000')
    expect(id).toBe(`slot_${DOCTOR}_2026-09-22_1000`)
    expect(parseSlotId(id)).toEqual({
      doctorId: DOCTOR,
      dateYmd: '2026-09-22',
      hhmm: '1000',
    })
  })

  it('rejects malformed ids', () => {
    expect(parseDayId('slot_x_2026-09-22')).toBeNull() // wrong prefix
    expect(parseDayId('day_')).toBeNull()
    expect(parseSlotId('slot_' + DOCTOR + '_2026-09-22')).toBeNull() // no time
    expect(parseSlotId('slot_' + DOCTOR + '_2026-9-2_1000')).toBeNull() // bad date
    expect(parseSlotId('slot_' + DOCTOR + '_2026-09-22_10am')).toBeNull() // bad time
  })

  it('does not confuse day and slot prefixes', () => {
    const dayId = encodeDayId(DOCTOR, '2026-09-22')
    expect(parseSlotId(dayId)).toBeNull()
  })
})
