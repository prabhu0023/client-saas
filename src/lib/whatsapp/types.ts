/**
 * WhatsApp message/event shapes for the staged booking flow (§6).
 *
 * These are the clinic app's own normalized shapes — wacrm forwards
 * inbound events to us and we hand back outbound messages for it to
 * deliver to Meta. We keep our own vocabulary so a later switch to the
 * Meta Cloud API only changes the adapter (send.ts / the route), not
 * the flow logic.
 */

/** A normalized inbound WhatsApp event (from wacrm's webhook forward). */
export interface InboundEvent {
  /** Meta's stable phone_number_id of the receiving number -> tenant key. */
  phoneNumberId: string
  /** Sender's WhatsApp number (E.164). */
  from: string
  /** Meta message id (wamid) — used for idempotency/dedupe. */
  wamid: string
  /** Free text, when the customer typed a message. */
  text?: string
  /**
   * The id of the button/list row the customer tapped, when this event
   * is an interactive reply. This is the value we encoded on send
   * (e.g. `day_<doctorId>_<date>`).
   */
  interactiveReplyId?: string
}

/** One selectable row in an interactive list. */
export interface ListRow {
  id: string
  title: string
  description?: string
}

/** An interactive list message to send (max 10 rows total). */
export interface OutboundList {
  kind: 'list'
  to: string
  body: string
  buttonLabel: string
  rows: ListRow[]
}

/** A plain text message to send. */
export interface OutboundText {
  kind: 'text'
  to: string
  body: string
}

export type OutboundMessage = OutboundList | OutboundText

export const MAX_LIST_ROWS = 10
