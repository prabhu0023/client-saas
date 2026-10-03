import Link from 'next/link'
import { requireAdmin } from '@/lib/portal/roles'
import { getSetupStatus, getSavedWacrmConnection } from '@/lib/portal/setup-status'
import { connectWhatsApp } from './actions'
import styles from './setup.module.css'

/**
 * The setup checklist (FR-1.10) and the Connect WhatsApp form (FR-1.8).
 *
 * Admin-only via requireAdmin(); RLS (migration 014) is the actual
 * boundary, this just gives a redirect instead of a raw 42501.
 *
 * The checklist is four reads, each deep-linking to the screen that
 * resolves it. The last item (an active service) is advisory: a clinic can
 * take bookings without named services, so it does not hold `complete`
 * open.
 *
 * There is no way to verify a wacrm account id against wacrm — the API key
 * is platform-level, so /me returns OUR account, not the clinic's (§9.2).
 * So the form does the two things that are actually useful: it states the
 * consequence of a wrong id in PRD §8's own words, and it echoes the saved
 * id back verbatim so an admin can compare it by eye with what wacrm
 * shows. The real test is the last line of the checklist — send a message.
 */

const ERRORS: Record<string, string> = {
  account: 'That does not look like a wacrm account id.',
  phone: 'Phone number id should be digits only.',
  display: 'Enter a valid number.',
  'wacrm-taken': 'That wacrm account is already connected to another clinic.',
  'phone-taken': 'That WhatsApp number id is already in use.',
  forbidden: 'Admins only.',
  raced: 'Try again — another change was in flight.',
  failed: 'Could not save the WhatsApp connection.',
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>
}) {
  const { clinic } = await requireAdmin()
  const { error, saved } = await searchParams

  const [status, connection] = await Promise.all([
    getSetupStatus(clinic.id),
    getSavedWacrmConnection(clinic.id),
  ])

  const message = error ? ERRORS[error] ?? 'Something went wrong.' : null

  const items = [
    {
      done: status.whatsappConnected,
      label: 'Connect WhatsApp',
      detail: 'Map this clinic to the wacrm account that receives its messages.',
      href: '#connect',
      action: 'Connect below',
    },
    {
      done: status.hasDoctor,
      label: 'Add a bookable doctor',
      detail:
        'Give any active member a doctor profile — including yourself. Patients are offered them by name.',
      href: '/staff',
      action: 'Open Staff',
    },
    {
      done: status.hasAvailability,
      label: 'Set consulting hours',
      detail: 'Weekly hours are what slot generation offers on WhatsApp.',
      href: '/availability',
      action: 'Open Availability',
    },
    {
      done: status.hasService,
      label: 'Add a service',
      detail: 'Optional — bookings work without one.',
      href: '/services',
      action: 'Open Services',
    },
  ]

  const remaining = items.filter((item) => !item.done).length

  return (
    <div>
      <div className={styles.head}>
        <h1 className={styles.title}>Finish setup</h1>
        <p className={styles.sub}>
          {status.complete
            ? 'This clinic can take bookings over WhatsApp.'
            : `${remaining} item${remaining === 1 ? '' : 's'} left before patients can book on WhatsApp.`}
        </p>
      </div>

      {saved === '1' && (
        <p className={styles.saved} role="status">
          WhatsApp connection saved.
        </p>
      )}

      <ol className={styles.list}>
        {items.map((item) => (
          <li
            className={`${styles.item} ${item.done ? styles.itemDone : ''}`}
            key={item.label}
          >
            <span className={styles.mark} aria-hidden="true">
              {item.done ? '✓' : '○'}
            </span>
            <div className={styles.itemBody}>
              <div className={styles.itemLabel}>
                {item.label}
                <span className={styles.srOnly}>
                  {item.done ? ' — done' : ' — not done yet'}
                </span>
              </div>
              <p className={styles.itemDetail}>{item.detail}</p>
            </div>
            <Link className={styles.itemLink} href={item.href}>
              {item.action}
            </Link>
          </li>
        ))}
      </ol>

      <p className={styles.finalCheck}>
        Last check, and the only one that proves the chain: message the
        clinic&rsquo;s WhatsApp number from a phone and watch it arrive in{' '}
        <Link className={styles.inlineLink} href="/inbox">
          Inbox
        </Link>
        .
      </p>

      <section className={styles.panel} id="connect">
        <h2 className={styles.panelTitle}>Connect WhatsApp</h2>

        {connection ? (
          <p className={styles.current}>
            Currently connected to wacrm account{' '}
            <code className={styles.code}>{connection.wacrmAccountId}</code>
            {connection.phoneNumberId && (
              <>
                {' '}
                · phone number id{' '}
                <code className={styles.code}>{connection.phoneNumberId}</code>
              </>
            )}
            {connection.displayNumber && <> · {connection.displayNumber}</>}
          </p>
        ) : (
          <p className={styles.current}>No wacrm account connected yet.</p>
        )}

        <p className={styles.warning}>
          This must match the <code className={styles.code}>account_id</code>{' '}
          wacrm stamps on its webhooks. If it does not, patient messages are
          silently dropped — nothing fails loudly.
        </p>

        {message && (
          <p className={styles.error} role="alert">
            {message}
          </p>
        )}

        <form action={connectWhatsApp}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="wacrmAccountId">
              wacrm account id
            </label>
            <input
              className={styles.input}
              id="wacrmAccountId"
              name="wacrmAccountId"
              type="text"
              required
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              defaultValue={connection?.wacrmAccountId ?? ''}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="phoneNumberId">
              Meta phone number id{' '}
              <span className={styles.optional}>(optional)</span>
            </label>
            <input
              className={styles.input}
              id="phoneNumberId"
              name="phoneNumberId"
              type="text"
              inputMode="numeric"
              maxLength={64}
              autoComplete="off"
              defaultValue={connection?.phoneNumberId ?? ''}
              aria-describedby="phoneNumberId-hint"
            />
            <p className={styles.hint} id="phoneNumberId-hint">
              Digits only, from WhatsApp Manager. Recorded for reference;
              routing uses the wacrm account id.
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="displayNumber">
              Number as patients see it{' '}
              <span className={styles.optional}>(optional)</span>
            </label>
            <input
              className={styles.input}
              id="displayNumber"
              name="displayNumber"
              type="text"
              maxLength={32}
              autoComplete="off"
              placeholder="+91 90000 00000"
              defaultValue={connection?.displayNumber ?? ''}
            />
          </div>

          <button className={styles.button} type="submit">
            Save connection
          </button>
        </form>
      </section>
    </div>
  )
}
