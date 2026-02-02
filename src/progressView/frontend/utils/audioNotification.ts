/**
 * Audio notification utilities.
 */

/**
 * Plays a short system beep to notify the user that a run has completed.
 */
export function playCompletionSound(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
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
