/**
 * Audio notification utilities.
 */

/**
 * Plays a short system beep to notify the user that a run has completed.
 */
export function playCompletionSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 150);
  } catch {
    // Ignore errors (e.g., autoplay restrictions)
  }
}
