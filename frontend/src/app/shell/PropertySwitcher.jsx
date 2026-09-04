import styles from './PropertySwitcher.module.css';

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
    return <span className={styles.nameOnly}>{activeProperty.name}</span>;
  }

  return (
    <label className={styles.switcher}>
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
    </label>
  );
}
