import type { Slot } from '@/types'
import { encodeDayId, encodeSlotId } from '@/lib/booking/slot-id'
import {
  type ListRow,
  type OutboundList,
  type OutboundText,
  MAX_LIST_ROWS,
} from './types'

/**
 * Pure message builders for the staged flow (§6). Each returns an
 * OutboundMessage the send adapter delivers via wacrm. All lists are
 * capped at MAX_LIST_ROWS (WhatsApp's hard limit).
 */

export interface DoctorOption {
  id: string
  /** Display name for the row, e.g. 'Dr. Rao (Cardiology)'. */
  label: string
}

/** An available day: the date plus a human label ('Mon, Sep 22'). */
export interface DayOption {
  doctorId: string
  /** 'YYYY-MM-DD' */
  dateYmd: string
  label: string
}

export function buildDoctorList(
  to: string,
  doctors: DoctorOption[],
): OutboundList {
  const rows: ListRow[] = doctors.slice(0, MAX_LIST_ROWS).map((d) => ({
    id: `doc_${d.id}`,
    title: d.label.slice(0, 24), // WhatsApp row title limit
  }))
  return {
    kind: 'list',
    to,
    body: 'Which doctor would you like to see?',
    buttonLabel: 'Choose doctor',
    rows,
  }
}

export function buildDayList(to: string, days: DayOption[]): OutboundList {
  const rows: ListRow[] = days.slice(0, MAX_LIST_ROWS).map((d) => ({
    id: encodeDayId(d.doctorId, d.dateYmd),
    title: d.label.slice(0, 24),
  }))
  return {
    kind: 'list',
    to,
    body: 'Which day works for you?',
    buttonLabel: 'Choose day',
    rows,
  }
}

export function buildTimeList(
  to: string,
  doctorId: string,
  dateYmd: string,
  slots: Slot[],
): OutboundList {
  const rows: ListRow[] = slots.slice(0, MAX_LIST_ROWS).map((s) => ({
    // s.hhmm is the compact clinic-local time carried on the slot, so no
    // fragile re-parsing of the display label.
    id: encodeSlotId(doctorId, dateYmd, s.hhmm),
    title: s.localLabel.slice(0, 24),
  }))
  return {
    kind: 'list',
    to,
    body: 'Please pick a time:',
    buttonLabel: 'Choose time',
    rows,
  }
}

export function buildConfirmation(
  to: string,
  doctorLabel: string,
  dayLabel: string,
  timeLabel: string,
): OutboundText {
  return {
    kind: 'text',
    to,
    body: `Confirmed! Your appointment with ${doctorLabel} is booked for ${dayLabel} at ${timeLabel}. See you then.`,
  }
}

export function buildSlotTaken(to: string): OutboundText {
  return {
    kind: 'text',
    to,
    body: 'Sorry, that time was just taken. Please pick another from the updated list.',
  }
}

export function buildNoAvailability(to: string): OutboundText {
  return {
    kind: 'text',
    to,
    body: 'Sorry, there are no open slots right now. Please try again later.',
  }
}

export function buildFallback(to: string): OutboundText {
  return {
    kind: 'text',
    to,
    body: 'To book an appointment, reply with "appointment".',
  }
}
