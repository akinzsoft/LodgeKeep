import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as setupApi from '../setup.js';
import { ApiError } from '../ApiError.js';
import { _resetApiClientForTesting } from '../client.js';

const respond = (status, envelope) => ({ status, json: async () => envelope });
const ok = (data, meta = {}) => ({ data, meta, error: null });

const sentRequest = () => {
  const [url, init] = fetch.mock.calls.at(-1);
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
};

/**
 * Room-management wrappers (gap closure). What matters here is the wire
 * contract the backend enforces: the bulk routes carry `room_ids`, a DELETE
 * carries its reason in a body, the archived view is a query parameter, and
 * a guard refusal keeps its `details.blocked` list on the thrown `ApiError`
 * — the blocked-rooms panel is built entirely from it.
 */
describe('setup API — room management', () => {
  beforeEach(() => {
    _resetApiClientForTesting();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listRooms() lists working rooms; { status: "archived" } asks for the archived view', async () => {
    fetch.mockResolvedValue(respond(200, ok([])));
    await setupApi.listRooms();
    expect(sentRequest().url).toMatch(/\/rooms$/);
    await setupApi.listRooms({ status: 'archived' });
    expect(sentRequest().url).toMatch(/\/rooms\?status=archived$/);
  });

  it('bulkChangeRoomType() POSTs room_ids and the target type to /rooms/change-type', async () => {
    fetch.mockResolvedValue(respond(200, ok({ changed: [], unchanged: [], cleared_preferences: [] })));
    await setupApi.bulkChangeRoomType({ room_ids: ['1', '2'], room_type_id: '9', reason: 'wrong type' });
    expect(sentRequest()).toMatchObject({ method: 'POST', body: { room_ids: ['1', '2'], room_type_id: '9', reason: 'wrong type' } });
    expect(sentRequest().url).toMatch(/\/rooms\/change-type$/);
  });

  it('bulkArchiveRooms() POSTs room_ids and a reason to /rooms/archive', async () => {
    fetch.mockResolvedValue(respond(200, ok({ changed: [] })));
    await setupApi.bulkArchiveRooms({ room_ids: ['1'], reason: 'closed' });
    expect(sentRequest()).toMatchObject({ method: 'POST', body: { room_ids: ['1'], reason: 'closed' } });
    expect(sentRequest().url).toMatch(/\/rooms\/archive$/);
  });

  it('deleteRoom() sends DELETE with the reason in the body', async () => {
    fetch.mockResolvedValue(respond(200, ok({ id: '5', deleted: true })));
    await setupApi.deleteRoom('5', 'created by mistake');
    expect(sentRequest()).toMatchObject({ method: 'DELETE', body: { reason: 'created by mistake' } });
    expect(sentRequest().url).toMatch(/\/rooms\/5$/);
  });

  it('getRoomUsage() and restoreRoom() hit their own routes', async () => {
    fetch.mockResolvedValue(respond(200, ok({ deletable: true })));
    await setupApi.getRoomUsage('5');
    expect(sentRequest()).toMatchObject({ method: 'GET' });
    expect(sentRequest().url).toMatch(/\/rooms\/5\/usage$/);
    await setupApi.restoreRoom('5');
    expect(sentRequest()).toMatchObject({ method: 'POST' });
    expect(sentRequest().url).toMatch(/\/rooms\/5\/restore$/);
  });

  it('a guard refusal keeps details.blocked on the ApiError', async () => {
    const blocked = [{ room_id: '1', room_number: '101', reasons: [{ code: 'OCCUPIED', message: 'Room 101 is occupied by a checked-in guest.' }] }];
    fetch.mockResolvedValue(
      respond(409, { data: null, meta: {}, error: { code: 'CONFLICT_ROOM_CHANGE_BLOCKED', message: 'Nothing was changed', details: { operation: 'archive', blocked } } })
    );
    const error = await setupApi.bulkArchiveRooms({ room_ids: ['1'], reason: 'x' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('CONFLICT_ROOM_CHANGE_BLOCKED');
    expect(error.details.blocked).toEqual(blocked);
  });
});
