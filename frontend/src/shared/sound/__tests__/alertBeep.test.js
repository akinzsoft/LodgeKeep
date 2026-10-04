import { describe, it, expect, vi, afterEach } from 'vitest';

async function freshModule() {
  vi.resetModules();
  return import('../alertBeep.js');
}

function fakeAudioContext() {
  const oscillators = [];
  class FakeContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = {};
      this.resume = vi.fn(() => Promise.resolve());
    }
    createOscillator() {
      const osc = { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(osc);
      return osc;
    }
    createGain() {
      return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    }
  }
  return { FakeContext, oscillators };
}

describe('alertBeep', () => {
  afterEach(() => {
    delete window.AudioContext;
  });

  it('is silent — never an error — where the browser has no audio', async () => {
    delete window.AudioContext;
    const { playAlertBeep, unlockAlertSound } = await freshModule();
    expect(playAlertBeep()).toBe(false);
    expect(() => unlockAlertSound()).not.toThrow();
  });

  it('schedules a two-tone chime and resumes a suspended context', async () => {
    const { FakeContext, oscillators } = fakeAudioContext();
    window.AudioContext = FakeContext;
    const { playAlertBeep } = await freshModule();
    expect(playAlertBeep()).toBe(true);
    expect(oscillators).toHaveLength(2);
    expect(oscillators.map((osc) => osc.frequency.setValueAtTime.mock.calls[0][0])).toEqual([880, 1320]);
    expect(oscillators.every((osc) => osc.start.mock.calls.length === 1 && osc.stop.mock.calls.length === 1)).toBe(true);
  });

  it('never throws when the audio device fails', async () => {
    window.AudioContext = class {
      constructor() {
        throw new Error('no device');
      }
    };
    const { playAlertBeep } = await freshModule();
    expect(playAlertBeep()).toBe(false);
  });

  it('plays one short high tone for a scan that was added and one low tone for one that was not', async () => {
    const { FakeContext, oscillators } = fakeAudioContext();
    window.AudioContext = FakeContext;
    const { playScanTone } = await freshModule();
    expect(playScanTone('ok')).toBe(true);
    expect(playScanTone('error')).toBe(true);
    expect(oscillators.map((osc) => [osc.type, osc.frequency.setValueAtTime.mock.calls[0][0]])).toEqual([
      ['sine', 1760],
      ['square', 220],
    ]);
  });

  it('scan tones are silent, never an error, without audio', async () => {
    delete window.AudioContext;
    const { playScanTone } = await freshModule();
    expect(playScanTone('ok')).toBe(false);
  });
});
