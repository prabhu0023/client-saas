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

/** Shown when a typed reply doesn't match any offered option. */
export function buildDidNotUnderstand(to: string): OutboundText {
  return {
    kind: 'text',
    to,
    body: 'Sorry, I didn\'t catch that. Please reply with the number of your choice.',
  }
}
