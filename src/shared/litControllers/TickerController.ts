import { createTicker, type Ticker } from '@utils/core';
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
  private _ticker: Ticker | undefined;

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
    this._tick();
    this._ticker = createTicker(this.intervalMs, () => this._tick());
  }

  hostDisconnected(): void {
    this._ticker?.dispose();
    this._ticker = undefined;
  }

  /** Re-sync `now` immediately, outside the regular interval. */
  refresh(): void {
    this._tick();
  }

  private _tick(): void {
    this._now = Date.now();
    this.host.requestUpdate();
  }
}
