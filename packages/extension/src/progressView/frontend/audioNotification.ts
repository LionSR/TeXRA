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
  } catch (error) {
    // Autoplay restrictions and audio-device absence are expected and not
    // fatal, but surface the cause so a regressing AudioContext path is not
    // invisible.
    console.warn('Failed to play completion sound:', error);
  }
}
