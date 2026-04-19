/**
 * Generic async-event source contract.
 *
 * An `AsyncEventSource` pushes text events into the caller's hands out-of-band.
 * The first concrete implementation is GitHub PR activity polling; the interface
 * is kept sparse so other async inputs (build-completion notifiers, external
 * collaboration endpoints, etc.) can reuse the same wiring into the follow-up
 * queue without growing GitHub-specific assumptions into the agent runtime.
 */

export interface Disposable {
  dispose(): void;
}

export interface AsyncEventSource {
  /**
   * Begin receiving events for `key`. Duplicate subscriptions for the same key
   * should coalesce into a single upstream poll; the returned disposable is
   * per-caller and only stops delivery to that caller's callback.
   */
  subscribe(key: string, onEvent: (text: string) => void): Disposable;

  /** Currently tracked subscription keys, for debugging / settings UI. */
  activeKeys(): readonly string[];
}
