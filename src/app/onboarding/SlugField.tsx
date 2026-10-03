'use client'

import { useState } from 'react'
import { slugify } from '@/lib/portal/onboarding-validate'
import styles from './onboarding.module.css'

/**
 * The clinic name + web address pair. The only client component on
 * /onboarding, and only because the slug has to follow the name as it is
 * typed: a suggestion that arrives after a round-trip is a suggestion
 * nobody waits for.
 *
 * The suggestion stops the moment the user edits the slug themselves —
 * the slug becomes their public web address, so their own typing wins
 * over ours for the rest of the session. Both fields are plain named
 * inputs, so the server action reads them from FormData and
 * `validateSlug` on the server is what actually decides.
 */
export function SlugField({
  defaultName,
  defaultSlug,
  error,
}: {
  defaultName: string
  defaultSlug: string
  /** Field-level message for the slug, rendered under it. */
  error: string | null
}) {
  const [name, setName] = useState(defaultName)
  const [slug, setSlug] = useState(defaultSlug)
  // A slug that came back from a failed submit is already the user's.
  const [touched, setTouched] = useState(Boolean(defaultSlug))

  function onNameChange(next: string) {
    setName(next)
    if (!touched) setSlug(slugify(next))
  }

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="name">
          Clinic name
        </label>
        <input
          className={styles.input}
          id="name"
          name="name"
          type="text"
          maxLength={120}
          required
          autoComplete="organization"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="slug">
          Web address
        </label>
        <input
          className={styles.input}
          id="slug"
          name="slug"
          type="text"
          minLength={3}
          maxLength={40}
          required
          autoComplete="off"
          spellCheck={false}
          value={slug}
          onChange={(e) => {
            setTouched(true)
            setSlug(e.target.value)
          }}
          aria-describedby={error ? 'slug-error' : 'slug-hint'}
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p className={styles.fieldError} id="slug-error" role="alert">
            {error}
          </p>
        ) : (
          <p className={styles.hint} id="slug-hint">
            3–40 lowercase letters, numbers or single hyphens.
          </p>
        )}
      </div>
    </>
  )
}
