import {
  attachFlowAutoRetryRequired,
  attachPartialText,
} from './errorMetadata';

/**
 * Minimal shape of a provider SDK stream that emits a `connect` event once the
 * HTTP response has begun. The Anthropic (`beta.messages.stream`) and OpenAI
 * (`chat.completions.stream`, `responses.stream`) streams match this surface.
 * OpenRouter is intentionally NOT tracked through here: its SDK emits no
 * `connect` event, so its handler keeps a manual `streamConnected` flag instead.
 * Both `on` and `off` are optional so the `typeof … === 'function'` guards in
 * {@link trackStreamConnect} stay type-consistent: the OpenAI Responses stream
 * reaches here through a wrapper that may not expose the emitter methods, and
 * the pre-refactor handler guarded against exactly that.
 */
export interface ConnectTrackableStream {
  on?(event: 'connect', listener: () => void): unknown;
  off?(event: 'connect', listener: () => void): unknown;
}

export interface StreamConnectTracker {
  /** True once the stream has emitted its `connect` event. */
  isConnected(): boolean;
  /** Removes the `connect` listener; safe to call in a `finally`. */
  cleanup(): void;
}

/**
 * Tracks whether a provider stream reached its `connect` event. The connected
 * signal distinguishes a pre-response failure (still inside the SDK's own retry
 * boundary) from a mid-stream failure (which the flow layer must retry itself),
 * so it feeds the `retryEligible` argument of {@link annotateStreamFailure}.
 *
 * Replaces the `let streamConnected = false; const onConnect = …; stream.on(…)`
 * boilerplate that each streaming handler previously hand-wired.
 */
export function trackStreamConnect(
  stream: ConnectTrackableStream,
): StreamConnectTracker {
  let connected = false;
  // `live` gates the flag independently of listener removal: a stream that has
  // no `off` cannot be detached, so after cleanup a late `connect` event would
  // otherwise still flip `connected`. Gating keeps the tracker inert once
  // cleaned up, whether or not the listener could actually be removed.
  let live = true;
  const onConnect = (): void => {
    if (live) connected = true;
  };
  if (typeof stream.on === 'function') {
    stream.on('connect', onConnect);
  }
  return {
    isConnected: () => connected,
    cleanup: () => {
      live = false;
      if (typeof stream.off === 'function') {
        stream.off('connect', onConnect);
      }
    },
  };
}

/**
 * Annotates a mid-stream failure before it propagates: lifts the partial text
 * generated before the failure onto the error (so the retry UI can show the
 * tail) and, when the failure fell outside the SDK's retry boundary, marks it
 * for flow-level auto-retry.
 *
 * `partialTail` may be empty — {@link attachPartialText} no-ops on empty input.
 * `retryEligible` is the per-provider "did we get far enough to owe a retry"
 * decision (typically stream-connected OR partial-text-present); keeping it an
 * explicit argument lets each handler add provider-specific terms (e.g. the
 * Responses handler's `streamEventObserved`) while the attach policy stays here.
 */
export function annotateStreamFailure(
  err: unknown,
  partialTail: string,
  retryEligible: boolean,
): void {
  attachPartialText(err, partialTail);
  if (retryEligible) {
    attachFlowAutoRetryRequired(err);
  }
}
