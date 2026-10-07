import type { ReactiveController, ReactiveControllerHost } from 'lit';

/**
 * Lit reactive controller that re-renders its host on a fixed interval,
 * exposing the timestamp of the last tick for relative/elapsed-time
 * rendering.
 *
 * ```typescript
 * private readonly ticker = new TickerController(this, 1000);
 *
 * render() {
 *   const elapsed = formatDuration(this.ticker.now - this.startTime);
 *   ...
 * }
 * ```
 */
export class TickerController implements ReactiveController {
  private _now = Date.now();
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly intervalMs: number,
  ) {
    host.addController(this);
  }

  /** Timestamp (ms) as of the last tick or `refresh()` call. */
  get now(): number {
    return this._now;
  }

  hostConnected(): void {
    this.refresh();
    this._timer = setInterval(() => this.refresh(), this.intervalMs);
  }

  hostDisconnected(): void {
    if (this._timer !== undefined) clearInterval(this._timer);
    this._timer = undefined;
  }

  /** Re-sync `now` immediately, outside the regular interval. */
  refresh(): void {
    this._now = Date.now();
    this.host.requestUpdate();
  }
}
