/**
 * The alert chime for pop-up notifications (user-requested: "there is no
 * sound beep"). Two short rising tones, generated with the Web Audio API so
 * no audio file ships or has to load — it works on an offline terminal.
 *
 * Browsers only let a page make sound after the person has interacted with
 * it (a click or key press). A signed-in staff member always has — they
 * typed their password — but a page restored from a reload may not have
 * been touched yet; then the context stays suspended and this is silent
 * until the next click, never an error. `unlockAlertSound()` is called on
 * the first interaction to resume it early.
 *
 * Never throws: a missing or blocked audio device must not break the bell.
 */

let context = null;

function audioContext() {
  if (context) return context;
  const Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/** Resume a suspended context — call from a user gesture. */
export function unlockAlertSound() {
  try {
    const ctx = audioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch {
    // Silent by design.
  }
}

/** One enveloped tone on `ctx` (attack to `peak`, decay over `duration`). */
function scheduleTone(ctx, { frequency, type = 'sine', at, duration, peak }) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.01);
}

/** Runs `play(ctx, startTime)` on the shared context; false (never an error) when there is no audio. */
function withAudio(play) {
  try {
    const ctx = audioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    play(ctx, ctx.currentTime + 0.01);
    return true;
  } catch {
    return false;
  }
}

/** Plays the chime once. Returns true when a sound was scheduled. */
export function playAlertBeep() {
  return withAudio((ctx, at) => {
    scheduleTone(ctx, { frequency: 880, at, duration: 0.16, peak: 0.3 });
    scheduleTone(ctx, { frequency: 1320, at: at + 0.18, duration: 0.16, peak: 0.3 });
  });
}

/** Supermarket camera scanning: a short high blip when the product was added, a low buzz when it was not. */
const SCAN_TONES = { ok: { frequency: 1760, duration: 0.09, type: 'sine' }, error: { frequency: 220, duration: 0.28, type: 'square' } };

export function playScanTone(kind = 'ok') {
  return withAudio((ctx, at) => scheduleTone(ctx, { ...(SCAN_TONES[kind] ?? SCAN_TONES.ok), at, peak: 0.25 }));
}
