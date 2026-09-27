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

/** Plays the chime once. Returns true when a sound was scheduled. */
export function playAlertBeep() {
  try {
    const ctx = audioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const start = ctx.currentTime + 0.01;
    [
      [880, 0],
      [1320, 0.18],
    ].forEach(([frequency, offset]) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start + offset);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.3, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.17);
    });
    return true;
  } catch {
    return false;
  }
}
