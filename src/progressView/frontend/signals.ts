/**
 * Signal utilities for the progress view.
 *
 * Re-exports from @lit-labs/signals and provides a `select()` helper
 * for extracting fields from a monolithic signal.
 */

import { SignalWatcher, signal, computed, Signal } from '@lit-labs/signals';

export { SignalWatcher, signal, computed, Signal };

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
