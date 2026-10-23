import { describe, it, expect } from 'vitest';
import { STEPS, autoStatus, computeProgress, buildProbes, loadManualTicks, saveManualTicks, storageKey } from '../gettingStarted.js';
import { getGuide } from '../guides.js';

const ok = (value) => ({ status: 'fulfilled', value });
const failed = { status: 'rejected', reason: new Error('403') };

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, data };
}

describe('autoStatus', () => {
  const step = { checks: ['rooms', 'rateCodes'] };
  it('is done only when every check is true', () => {
    expect(autoStatus(step, { rooms: true, rateCodes: true })).toBe('done');
  });
  it('is todo when any check is false, even if another is unknown', () => {
    expect(autoStatus(step, { rooms: false, rateCodes: null })).toBe('todo');
  });
  it('is unknown (never todo) when a check could not be read', () => {
    expect(autoStatus(step, { rooms: true })).toBe('unknown');
  });
  it('is manual for a step with no checks', () => {
    expect(autoStatus({ checks: [] }, {})).toBe('manual');
  });
});

describe('computeProgress', () => {
  it('counts auto-done and hand-ticked steps and names the first undone one', () => {
    const progress = computeProgress({ property: true }, { 'first-test': true });
    expect(progress.doneCount).toBe(2);
    expect(progress.total).toBe(STEPS.length);
    expect(progress.next.id).toBe('rooms-and-rates');
    expect(progress.complete).toBe(false);
  });
  it('lets a hand tick cover a step the role cannot check', () => {
    const progress = computeProgress({ payoutAccount: null }, { payments: true });
    expect(progress.steps.find((s) => s.id === 'payments').done).toBe(true);
  });
  it('is complete when everything is ticked', () => {
    const manual = Object.fromEntries(STEPS.map((s) => [s.id, true]));
    const progress = computeProgress({}, manual);
    expect(progress.complete).toBe(true);
    expect(progress.next).toBeNull();
  });
});

describe('buildProbes', () => {
  const progress = ok({ steps: [
    { key: 'property', complete: true }, { key: 'room-types', complete: true }, { key: 'rooms', complete: false },
    { key: 'rate-codes', complete: true }, { key: 'taxes', complete: false }, { key: 'users', complete: true },
  ] });
  it('reads setup progress, lists and approvers', () => {
    const probes = buildProbes({
      progress, subaccount: ok({ subaccount_code: 'x' }), outlets: ok([{ id: 1 }]), terminals: ok([]),
      menuItems: ok([{ id: 1 }]), approvers: ok([{ id: '1', hasPin: false }, { id: '2', hasPin: true }]),
    });
    expect(probes).toMatchObject({ property: true, roomTypes: true, rooms: false, rateCodes: true, taxes: false, staff: true, payoutAccount: true, outlets: true, terminals: false, menuItems: true, approvalPin: true });
  });
  it('treats no subaccount as not done, and no PIN among approvers as not done', () => {
    const probes = buildProbes({ progress, subaccount: ok(null), outlets: ok([]), terminals: ok([]), menuItems: ok([]), approvers: ok([{ id: '1', hasPin: false }]) });
    expect(probes.payoutAccount).toBe(false);
    expect(probes.approvalPin).toBe(false);
  });
  it('reports a failed or forbidden read as unknown, not as not done', () => {
    const probes = buildProbes({ progress: failed, subaccount: failed, outlets: failed, terminals: ok('oops'), menuItems: failed, approvers: failed });
    expect(Object.values(probes).every((v) => v === null)).toBe(true);
  });
});

describe('manual ticks storage', () => {
  it('round-trips and is keyed per user and property', () => {
    const storage = memoryStorage();
    const key = storageKey('7', '3');
    saveManualTicks(key, { property: true }, storage);
    expect(loadManualTicks(key, storage)).toEqual({ property: true });
    expect(loadManualTicks(storageKey('8', '3'), storage)).toEqual({});
  });
  it('ignores garbage, unknown steps and non-true values', () => {
    const key = storageKey('1', '1');
    expect(loadManualTicks(key, memoryStorage({ [key]: 'not json' }))).toEqual({});
    expect(loadManualTicks(key, memoryStorage({ [key]: JSON.stringify({ property: true, bogus: true, taxes: 'yes' }) }))).toEqual({ property: true });
  });
  it('survives blocked storage', () => {
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(loadManualTicks('k', broken)).toEqual({});
    expect(() => saveManualTicks('k', { property: true }, broken)).not.toThrow();
  });
});

describe('the guides behind the steps', () => {
  it('has a guide for every step with the required parts, and every linked guide exists', () => {
    for (const step of STEPS) {
      const guide = getGuide(step.guide);
      expect(guide, step.guide).toBeTruthy();
      expect(guide.source).toContain('## You are done when');
      expect(guide.source).toContain('## What it is for');
      if (step.problems) expect(getGuide(step.problems), step.problems).toBeTruthy();
      for (const [, slug] of guide.source.matchAll(/\]\(help:([^)]+)\)/g)) expect(getGuide(slug), slug).toBeTruthy();
    }
  });
  it('links each step that has a problems guide to it from the guide text', () => {
    for (const step of STEPS.filter((s) => s.problems)) {
      expect(getGuide(step.guide).source, step.guide).toContain(`(help:${step.problems})`);
    }
  });
});
