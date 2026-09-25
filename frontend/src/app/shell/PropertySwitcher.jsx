import styles from './PropertySwitcher.module.css';
import chip from './headerChip.module.css';

function BuildingIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4" />
    </svg>
  );
}

/**
 * PropertySwitcher — PRODUCT_REQUIREMENTS.md's App shell, Top bar: "the
 * current property must always be visible, since posting a charge against
 * the wrong property is unrecoverable. Tenants entitled to only one property
 * still see the property name, just not a switcher."
 *
 * Presentational only — see `AppShell.jsx`'s header for why this component
 * makes no network call itself. `onSwitchProperty(propertyId)` is the
 * caller's hook to `POST /api/v1/auth/switch-property`
 * (API.md §5), which is what actually re-verifies the switch server-side
 * (SECURITY.md §3) — nothing here is the authorization, only the UI for
 * requesting one.
 *
 * @param {{id: string, name: string}} activeProperty
 * @param {Array<{id: string, name: string}>} properties   All properties the signed-in user holds access to. Length <= 1 renders no dropdown at all — see the spec quote above.
 * @param {(propertyId: string) => void} onSwitchProperty
 */
export function PropertySwitcher({ activeProperty, properties, onSwitchProperty }) {
  if (properties.length <= 1) {
    return (
      <div className={`${chip.chip} ${styles.nameChip}`} title="Active property">
        <span className={chip.icon}>
          <BuildingIcon />
        </span>
        <span className={chip.text}>
          <span className={chip.label}>Property</span>
          <span className={`${chip.value} ${styles.nameOnly}`}>{activeProperty.name}</span>
        </span>
      </div>
    );
  }

  return (
    <label className={`${chip.chip} ${styles.switcher}`}>
      <span className={chip.icon}>
        <BuildingIcon />
      </span>
      <span className={chip.text}>
        <span className={chip.label}>Property</span>
        <span className={styles.srOnly}>Active property</span>
        <select
          className={styles.select}
          value={activeProperty.id}
          onChange={(event) => onSwitchProperty(event.target.value)}
        >
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
