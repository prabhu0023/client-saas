import { redirect } from 'next/navigation'

// The public root sends people into the portal; the portal layout gates
// on auth and bounces to /login when there's no active-member session.
export default function Home() {
  redirect('/dashboard')
}
