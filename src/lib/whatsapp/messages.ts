import type { OutboundText } from './types'

/**
 * Pure message builders for the text-driven WhatsApp flow. Each returns
 * an OutboundMessage the send adapter delivers via wacrm.
 *
 * The wacrm channel forwards only free text (not a tapped interactive-row
 * id), so the flow uses numbered TEXT menus rather than WhatsApp
 * interactive lists — see the numbered-text builders below.
 */

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

/**
 * Receipt for a captured non-booking message (R3). Deliberately neutral:
 * a human reads and replies, so this NEVER answers the question or
 * offers any clinical guidance (spec §1 non-goals, §2 hard constraints).
 *
 * On the patient's first ever message it also carries the one-time
 * notice that messages are logged and visible to the clinic (spec §2
 * consent). Either way it is exactly ONE outbound message.
 */
export function buildMessageAck(
  to: string,
  isFirstMessage: boolean,
): OutboundText {
  const ack =
    'Thanks — the clinic has received your message and will reply soon.'
  const notice =
    'Please note: messages in this chat are saved to your clinic record and can be seen by the clinic staff and your doctor.'
  return {
    kind: 'text',
    to,
    body: isFirstMessage ? `${ack}\n\n${notice}` : ack,
  }
}

// ------------------------------------------------------------
// Numbered-text builders for the wacrm channel.
//
// wacrm's inbound webhook doesn't forward the tapped interactive-row id,
// so the flow is driven by numbered TEXT replies. These build a plain
// numbered menu ('1. ...\n2. ...') and ask the patient to reply with a
// number. The caller pairs each line with a FlowOption so the reply can
// be matched back to an id.
// ------------------------------------------------------------

/** Render a numbered menu with a prompt line above it. */
function numberedMenu(
  to: string,
  prompt: string,
  labels: string[],
): OutboundText {
  const lines = labels.map((label, i) => `${i + 1}. ${label}`)
  return {
    kind: 'text',
    to,
    body: `${prompt}\n\n${lines.join('\n')}\n\nReply with a number.`,
  }
}

export function buildDoctorMenu(to: string, labels: string[]): OutboundText {
  return numberedMenu(to, 'Which doctor would you like to see?', labels)
}

export function buildDayMenu(to: string, labels: string[]): OutboundText {
  return numberedMenu(to, 'Which day works for you?', labels)
}

export function buildTimeMenu(to: string, labels: string[]): OutboundText {
  return numberedMenu(to, 'Please pick a time:', labels)
}

export function buildCancelMenu(to: string, labels: string[]): OutboundText {
  return numberedMenu(
    to,
    'Which appointment would you like to cancel?',
    labels,
  )
}

export function buildReschedulePickMenu(
  to: string,
  labels: string[],
): OutboundText {
  return numberedMenu(
    to,
    'Which appointment would you like to reschedule?',
    labels,
  )
}

/** Confirmation after a successful reschedule (new slot booked, old cancelled). */
export function buildRescheduled(
  to: string,
  doctorLabel: string,
  dayLabel: string,
  timeLabel: string,
): OutboundText {
  return {
    kind: 'text',
    to,
    body: `Done! Your appointment has been moved to ${dayLabel} at ${timeLabel} with ${doctorLabel}. See you then.`,
  }
}

/** Shown when the patient has no upcoming appointments to cancel. */
export function buildNoAppointments(to: string): OutboundText {
  return {
    kind: 'text',
    to,
    body: 'You have no upcoming appointments to cancel.',
  }
}

/** Confirmation after a successful cancellation. */
export function buildCancelled(to: string, apptLabel: string): OutboundText {
  return {
    kind: 'text',
    to,
    body: `Your appointment on ${apptLabel} has been cancelled. To book a new one, reply with "appointment".`,
  }
}

/** Shown when a typed reply doesn't match any offered option. */
export function buildDidNotUnderstand(to: string): OutboundText {
  return {
    kind: 'text',
    to,
    body: 'Sorry, I didn\'t catch that. Please reply with the number of your choice.',
  }
}
