/**
 * Signal utilities shared across all webview apps.
 *
 * Re-exports from @lit-labs/signals and provides helpers
 * for extracting fields from monolithic signals.
 */

import { SignalWatcher, signal, Signal } from '@lit-labs/signals';

export { SignalWatcher, signal, Signal };

/**
 * Selector: extracts a field from a monolithic signal.
 * Only propagates when the selected value's reference changes.
 * Works with Mutative's structural sharing — unchanged branches
 * keep their reference, so Object.is() correctly skips propagation.
 */
export function select<S, T>(
  source: Signal.State<S>,
  selector: (state: S) => T,
): Signal.Computed<T> {
  return new Signal.Computed(() => selector(source.get()));
}

/** Any signal with a `.get()` method (State or Computed). */
type AnySignal<T> = Signal.State<T> | Signal.Computed<T>;

/**
 * Derive a computed from multiple signal inputs.
 * Replaces the `void x.get()` pattern for explicit multi-signal dependency tracking.
 */
export function combine<Inputs extends readonly AnySignal<any>[], R>(
  inputs: [...Inputs],
  fn: (
    ...args: {
      [K in keyof Inputs]: Inputs[K] extends AnySignal<infer T> ? T : never;
    }
  ) => R,
): Signal.Computed<R> {
  return new Signal.Computed(() => fn(...(inputs.map((s) => s.get()) as any)));
}
