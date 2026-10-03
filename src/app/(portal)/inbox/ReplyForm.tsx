'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { replyToThread } from './actions'
import styles from './inbox.module.css'

/**
 * The staff reply box (T3). A client component for one reason: a WhatsApp
 * send goes over the network to wacrm and fails routinely (channel not
 * configured, 5xx, a window that closed between render and submit). The
 * action returns that reason instead of throwing, and this component
 * renders it next to the textarea with the typed reply still in place —
 * a clinical answer must never be lost to a generic error screen.
 *
 * The body is cleared only after a confirmed send, then the route is
 * refreshed so the new outbound message appears in the timeline.
 *
 * The window-closed state disables both controls and announces the
 * reason via aria-describedby; the server action refuses the send too,
 * so a closed window can never turn into a silent free-form attempt (R5).
 */

/** Mirrors MAX_REPLY_CHARS in ./actions — WhatsApp caps around 4096. */
const MAX_REPLY_CHARS = 4000

export function ReplyForm({
  threadId,
  windowOpen,
  closedNotice,
}: {
  threadId: string
  windowOpen: boolean
  /** WINDOW_CLOSED_NOTICE, passed in: the read layer is server-only. */
  closedNotice: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isPending) return

    const fd = new FormData()
    fd.set('threadId', threadId)
    fd.set('body', body)

    setError(null)
    startTransition(async () => {
      const result = await replyToThread(fd)
      if (result.error) {
        setError(result.error)
        return
      }
      setBody('')
      router.refresh()
    })
  }

  const notice = windowOpen ? null : closedNotice
  const describedBy = [
    notice ? 'window-notice' : null,
    error ? 'reply-error' : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      {notice && (
        <p className={styles.windowClosed} id="window-notice" role="status">
          {notice}
        </p>
      )}

      {error && (
        <p className={styles.replyError} id="reply-error" role="alert">
          {error}
        </p>
      )}

      <form className={styles.replyForm} onSubmit={onSubmit}>
        <label className={styles.replyLabel} htmlFor="body">
          Your reply
        </label>
        <textarea
          className={styles.replyInput}
          id="body"
          name="body"
          rows={3}
          required
          maxLength={MAX_REPLY_CHARS}
          disabled={!windowOpen || isPending}
          aria-describedby={describedBy || undefined}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            windowOpen ? 'Type the clinic’s reply…' : 'Replies are closed'
          }
        />
        <button
          className={styles.sendBtn}
          type="submit"
          disabled={!windowOpen || isPending}
          aria-describedby={describedBy || undefined}
        >
          {isPending ? 'Sending…' : 'Send reply'}
        </button>
      </form>
    </>
  )
}
