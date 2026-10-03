import { requireAdmin } from '@/lib/portal/roles'
import { listClinicDoctors, type DoctorRef } from '@/lib/portal/availability'
import {
  listServices,
  SERVICE_MESSAGES,
  type ServiceListItem,
} from '@/lib/portal/services'
import {
  addService,
  editService,
  saveServiceDoctors,
  toggleServiceActive,
} from './actions'
import styles from './services.module.css'

/**
 * Services and the doctor↔service mapping (ONB-3). Admin-only via
 * requireAdmin(); 014's admin-write policies are the actual boundary.
 *
 * Deactivate is the only removal offered, and the copy says so: a service
 * is what past appointments point at (`appointments.service_id` is ON
 * DELETE SET NULL), so deleting one would rewrite history rather than
 * tidy up (FR-3.3).
 *
 * The doctor picker is plain checkboxes submitting the WHOLE set in one
 * post, because the write replaces the set atomically (FR-3.4). Unticking
 * everything is a real request — it clears the mapping.
 */

const ERRORS: Record<string, string> = {
  name: 'Enter the service name.',
  price: 'Enter a price like 450 or 450.50.',
  duplicate: SERVICE_MESSAGES.duplicateName,
  'doctor-not-available': SERVICE_MESSAGES.doctorNotInClinic,
  'not-found': SERVICE_MESSAGES.serviceNotFound,
  forbidden: SERVICE_MESSAGES.adminsOnly,
  failed: 'Something went wrong. Try again.',
}

const SAVED: Record<string, string> = {
  created: 'Service added.',
  updated: 'Service updated.',
  activated: 'Service activated.',
  deactivated: 'Service deactivated — past appointments keep it.',
  doctors: 'Doctors updated.',
}

/** Integer cents to major units. No currency symbol: the clinic has no currency column. */
function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2)
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>
}) {
  const { clinic } = await requireAdmin()
  const { error, saved } = await searchParams

  const [services, doctors] = await Promise.all([
    listServices(clinic.id),
    listClinicDoctors(clinic.id),
  ])

  const errorMessage = error ? ERRORS[error] ?? 'Something went wrong.' : null
  const savedMessage = saved ? SAVED[saved] ?? null : null

  return (
    <div>
      <div className={styles.head}>
        <h1 className={styles.title}>Services</h1>
        <p className={styles.sub}>
          What this clinic charges for, and which doctors offer each one.
        </p>
      </div>

      {errorMessage && (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      )}
      {savedMessage && (
        <p className={styles.saved} role="status">
          {savedMessage}
        </p>
      )}

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Add a service</h2>
        <form className={styles.addForm} action={addService}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="new-name">
              Name
            </label>
            <input
              className={styles.input}
              id="new-name"
              name="name"
              type="text"
              maxLength={120}
              placeholder="Consultation"
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="new-price">
              Price
            </label>
            <input
              className={styles.input}
              id="new-price"
              name="price"
              type="text"
              inputMode="decimal"
              placeholder="450.00"
              required
            />
          </div>

          <button className={styles.primaryBtn} type="submit">
            Add service
          </button>
        </form>
        <p className={styles.hint}>
          Enter the price in whole units, e.g. 450 or 450.50.
        </p>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Your services</h2>
        {services.length === 0 ? (
          <p className={styles.emptyInline}>
            No services yet. Add the ones patients pay for — a consultation is
            usually the first.
          </p>
        ) : (
          <ul className={styles.serviceList}>
            {services.map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                doctors={doctors}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ServiceRow({
  service,
  doctors,
}: {
  service: ServiceListItem
  doctors: DoctorRef[]
}) {
  const offeredBy = new Set(service.doctors.map((d) => d.id))

  return (
    <li className={`${styles.service} ${service.active ? '' : styles.serviceOff}`}>
      <div className={styles.serviceHead}>
        <div className={styles.serviceWho}>
          <span className={styles.serviceName}>{service.name}</span>
          <span className={styles.servicePrice}>
            {formatPrice(service.priceCents)}
          </span>
        </div>
        <div className={styles.badges}>
          {service.active ? (
            <span className={styles.badgeOn}>active</span>
          ) : (
            <span className={styles.badgeOff}>inactive</span>
          )}
        </div>
      </div>

      <p className={styles.offeredBy}>
        {service.doctors.length === 0
          ? 'No doctors offer this yet.'
          : `Offered by ${service.doctors.map((d) => d.label).join(', ')}`}
      </p>

      <div className={styles.controls}>
        <form className={styles.inlineForm} action={editService}>
          <input type="hidden" name="serviceId" value={service.id} />
          <label className={styles.srOnly} htmlFor={`name-${service.id}`}>
            Name for {service.name}
          </label>
          <input
            className={styles.input}
            id={`name-${service.id}`}
            name="name"
            type="text"
            maxLength={120}
            defaultValue={service.name}
            required
          />
          <label className={styles.srOnly} htmlFor={`price-${service.id}`}>
            Price for {service.name}
          </label>
          <input
            className={styles.inputPrice}
            id={`price-${service.id}`}
            name="price"
            type="text"
            inputMode="decimal"
            defaultValue={formatPrice(service.priceCents)}
            required
          />
          <button className={styles.secondaryBtn} type="submit">
            Save
          </button>
        </form>

        <form className={styles.inlineForm} action={toggleServiceActive}>
          <input type="hidden" name="serviceId" value={service.id} />
          <input
            type="hidden"
            name="active"
            value={service.active ? 'false' : 'true'}
          />
          <button className={styles.secondaryBtn} type="submit">
            {service.active ? 'Deactivate' : 'Activate'}
          </button>
        </form>
      </div>

      <details className={styles.doctorBox} open={offeredBy.size > 0}>
        <summary className={styles.doctorSummary}>Doctors offering this</summary>

        {doctors.length === 0 ? (
          <p className={styles.doctorHint}>
            No bookable doctors yet. Give a member a doctor profile on Staff
            first.
          </p>
        ) : (
          <form className={styles.doctorForm} action={saveServiceDoctors}>
            <input type="hidden" name="serviceId" value={service.id} />
            <ul className={styles.doctorList}>
              {doctors.map((doctor) => (
                <li className={styles.doctorItem} key={doctor.id}>
                  <label className={styles.checkLabel}>
                    <input
                      type="checkbox"
                      name="doctorIds"
                      value={doctor.id}
                      defaultChecked={offeredBy.has(doctor.id)}
                    />
                    {doctor.label}
                  </label>
                </li>
              ))}
            </ul>
            <button className={styles.primaryBtn} type="submit">
              Save doctors
            </button>
            <p className={styles.doctorHint}>
              Saving replaces the whole list. Clearing every box means no
              doctor offers this service.
            </p>
          </form>
        )}
      </details>
    </li>
  )
}
