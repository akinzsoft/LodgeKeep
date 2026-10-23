import { listTimezones, isValidTimezone } from '../timezones.js';

/**
 * A native select of valid IANA timezones (typing a few letters jumps to a
 * match). A stored value that is not a real zone shows as unselected, so the
 * user must choose one before saving.
 */
export function TimezoneSelect({ value, onChange, className, required = true, id }) {
  const valid = isValidTimezone(value);
  return (
    <select id={id} className={className} value={valid ? value : ''} onChange={(event) => onChange(event.target.value)} required={required}>
      <option value="" disabled>
        {value && !valid ? `"${value}" is not a valid timezone, choose one` : 'Choose a timezone'}
      </option>
      {listTimezones().map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </select>
  );
}
