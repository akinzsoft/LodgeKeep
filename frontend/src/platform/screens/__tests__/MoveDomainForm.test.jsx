import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoveDomainForm } from '../MoveDomainForm.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ moveToNewDomain: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, ...mocks } };
});

describe('<MoveDomainForm>', () => {
  beforeEach(() => {
    mocks.moveToNewDomain.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends the reason and reports how many e-mails were queued', async () => {
    mocks.moveToNewDomain.mockResolvedValue({ appDomain: 'lodgekeep.ng', emails: { queued: 4, alreadySent: 0 } });
    const user = userEvent.setup();
    render(<MoveDomainForm tenantId="9" currentDomain="lodgekeep.planmsys.com" />);
    await user.type(screen.getByLabelText(/reason/i), 'Customer asked');
    await user.click(screen.getByRole('button', { name: /move to new domain/i }));
    expect(mocks.moveToNewDomain).toHaveBeenCalledWith('9', 'Customer asked');
    expect(await screen.findByText(/4 e-mail\(s\) queued/)).toBeInTheDocument();
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    window.confirm.mockReturnValue(false);
    const user = userEvent.setup();
    render(<MoveDomainForm tenantId="9" currentDomain="x.example.com" />);
    await user.type(screen.getByLabelText(/reason/i), 'Because');
    await user.click(screen.getByRole('button', { name: /move to new domain/i }));
    expect(mocks.moveToNewDomain).not.toHaveBeenCalled();
  });

  it('shows the server refusal', async () => {
    mocks.moveToNewDomain.mockRejectedValue(new ApiError({ status: 409, code: 'BUSINESS_RULE_ALREADY_ON_DOMAIN', message: 'This tenant is already on lodgekeep.ng.' }));
    const user = userEvent.setup();
    render(<MoveDomainForm tenantId="9" currentDomain="lodgekeep.ng" />);
    await user.type(screen.getByLabelText(/reason/i), 'Again');
    await user.click(screen.getByRole('button', { name: /move to new domain/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already on');
  });
});
