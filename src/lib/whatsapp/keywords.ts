/**
 * Booking-intent keyword matching for the text-driven WhatsApp flow.
 *
 * A no-live-session inbound only starts the booking flow if it matches
 * one of these keywords; anything else gets the fallback nudge. Kept as
 * its own tiny module (rather than living in the flow) so both the flow
 * and its tests can import it without pulling in DB/send dependencies.
 */
const BOOKING_KEYWORDS = ['appointment', 'book', 'booking', 'hello', 'hi']
const CANCEL_KEYWORDS = ['cancel']
const RESCHEDULE_KEYWORDS = ['reschedule', 'change', 'move']

/** Case-insensitive substring match against the booking keywords. */
export function matchesBookingKeyword(text: string): boolean {
  const t = text.toLowerCase()
  return BOOKING_KEYWORDS.some((k) => t.includes(k))
}

/**
 * Case-insensitive match for a cancel-intent keyword. Checked BEFORE the
 * booking keywords when routing a no-session message, so "cancel my
 * appointment" starts the cancel flow rather than a new booking (the
 * word "appointment" would otherwise match a booking keyword too).
 */
export function matchesCancelKeyword(text: string): boolean {
  const t = text.toLowerCase()
  return CANCEL_KEYWORDS.some((k) => t.includes(k))
}

/**
 * Case-insensitive match for a reschedule-intent keyword. Checked BEFORE
 * both cancel and booking keywords when routing a no-session message, so
 * "reschedule my appointment" / "change my appointment" start the
 * reschedule flow rather than a cancel or a new booking.
 */
export function matchesRescheduleKeyword(text: string): boolean {
  const t = text.toLowerCase()
  return RESCHEDULE_KEYWORDS.some((k) => t.includes(k))
}
