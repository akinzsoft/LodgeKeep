import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Chooses `option` (its value or its visible text) in the select labelled
 * `label` — but only once that option actually exists.
 *
 * POS selects like Outlet, Terminal, Stock item and Menu item render
 * immediately with just a placeholder, then fill in when their list fetch
 * resolves a tick later. Waiting for the select element alone (the old
 * `selectOptions(await findByLabelText(...), ...)` pattern) let the selection
 * race the fetch; under CPU load it lost with "Value ... not found in
 * options" — intermittent failures in whichever test lost the race that run.
 */
export async function selectWhenLoaded(label, option) {
  await waitFor(() => {
    const select = screen.getByLabelText(label);
    const found = [...select.options].some((candidate) => candidate.value === option || candidate.textContent === option);
    if (!found) throw new Error(`"${option}" has not loaded into the "${label}" select yet`);
  });
  await userEvent.selectOptions(screen.getByLabelText(label), option);
}
