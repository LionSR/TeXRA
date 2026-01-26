/**
 * Plays lightweight audio notifications for progress view events.
 */
export class AudioNotificationService {
  playCompletionBeep(): void {
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
}
