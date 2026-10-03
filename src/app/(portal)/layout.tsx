import type { ReactNode } from 'react'
import Link from 'next/link'
import { requireStaff } from '@/lib/portal/auth'
import styles from './portal.module.css'

/**
 * Auth gate + chrome for every portal page. requireStaff() redirects to
 * /login when there's no active-member session, so anything rendered
 * below here can assume a valid StaffContext.
 */
export default async function PortalLayout({
  children,
}: {
  children: ReactNode
}) {
  const { clinic, email, member } = await requireStaff()

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.clinicName}>{clinic.name}</span>
          <span className={styles.clinicMeta}>
            {clinic.timezone} · {member.role}
          </span>
        </div>

        <nav className={styles.nav}>
          <Link className={styles.navLink} href="/dashboard">
            Appointments
          </Link>
          <Link className={styles.navLink} href="/availability">
            Availability
          </Link>
          <Link className={styles.navLink} href="/inbox">
            Inbox
          </Link>
        </nav>

        <div className={styles.right}>
          {email && <span className={styles.userEmail}>{email}</span>}
          <form action="/logout" method="post">
            <button className={styles.signOut} type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  )
}
