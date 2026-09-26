/**
 * Outbound WhatsApp message shapes.
 *
 * These are the clinic app's own normalized shapes — the flow builds an
 * OutboundMessage and hands it to the send adapter (send.ts), which maps
 * it to wacrm's send contract. Keeping our own vocabulary means a later
 * switch to the Meta Cloud API only changes the adapter, not the flow.
 *
 * Inbound events are parsed directly from wacrm's webhook envelope in
 * the route (see src/app/api/whatsapp/inbound/route.ts); the live flow
 * consumes plain text, so there is no normalized inbound type here.
 *
 * The interactive-list shapes (OutboundList/ListRow) are retained for
 * the send adapter's list branch and a possible future tap-based flow;
 * the live numbered-text flow emits OutboundText only.
 */

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

/**
 * A proactive template message — the ONLY kind allowed outside the 24h
 * session window (Meta requires a pre-approved template for reminders).
 *
 * `templateName` is the approved template's name; `bodyParams` are the
 * ordered values that fill the template's `{{1}}, {{2}}, ...` body
 * placeholders; `languageCode` is the template's registered locale
 * (e.g. 'en', 'en_US'). Kept separate from OutboundMessage because it
 * goes through a distinct send path (`sendTemplate`), not the free-form
 * `sendMessage`.
 */
export interface OutboundTemplate {
  kind: 'template'
  to: string
  templateName: string
  /** Ordered values for the template body's {{1}}, {{2}}, ... params. */
  bodyParams: string[]
  /** Template's registered language/locale. Defaults to 'en' at send time. */
  languageCode?: string
}

/** An active doctor rendered as a pickable option in the flow. */
export interface DoctorOption {
  id: string
  /** Display name for the option, e.g. 'Dr. Rao (Cardiology)'. */
  label: string
}

/** An available day: the date plus a human label ('Mon, Sep 22'). */
export interface DayOption {
  doctorId: string
  /** 'YYYY-MM-DD' */
  dateYmd: string
  label: string
}
