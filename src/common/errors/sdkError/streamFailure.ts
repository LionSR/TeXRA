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

/**
 * Drives an async-iterable provider stream, invoking `consume` once per chunk.
 * A named extraction of the `for await (const chunk of stream) { ... }` loop
 * every iterate-based streaming handler (OpenRouter, GoogleGenAI, and the
 * event loop inside OpenAI Responses) previously hand-wrote inline. Handlers
 * whose SDK drives consumption through its own event emitter instead of a
 * plain async iterable (Anthropic's `attachToStream`, OpenAI chat completions'
 * `stream.on('chunk', ...)`) do not use this — their "consume" hook is the
 * listener they register directly with the SDK.
 */
export async function consumeStreamChunks<TChunk>(
  stream: AsyncIterable<TChunk>,
  consume: (chunk: TChunk) => void,
): Promise<void> {
  for await (const chunk of stream) {
    consume(chunk);
  }
}

/**
 * Hooks for {@link handleStreamingFailure}, the shared tail of the mid-stream
 * failure skeleton every provider handler's streaming catch block runs:
 * finalize the in-flight progress streams, compute the partial-output tail,
 * optionally enrich/tag/log the error, then annotate it and rethrow.
 *
 * Each hook is a thin accessor over state the handler already computed in its
 * own catch block (stream diagnostics, aggregator buffers, connect trackers)
 * — this function does not own stream consumption or recovery. Two carve-outs
 * this deliberately does NOT try to unify (see callers for the exact
 * preserved behavior):
 *  - OpenAI Responses' `recover` path (polling fallback after an unhandled
 *    SSE event) is attempted at two points *inside* the handler's own try
 *    block, before this function's catch-tail ever runs; it only fires here
 *    if recovery itself also failed.
 *  - Each handler's `retryEligible` formula is preserved verbatim (they
 *    differ three ways today: `connected||tail`, `connected||observed||tail`,
 *    and GoogleGenAI's hardcoded `false`) — this function does not compute or
 *    default the formula, only applies whatever the handler decided.
 */
export interface StreamingFailureHooks {
  /**
   * Finalizes in-flight progress streams so the progress view does not hang
   * in a loading state (expected to be idempotent). Omit when the handler
   * already finalizes unconditionally in a `finally` block (Anthropic).
   */
  finalizeOnError?: () => void;
  /** Extracts the capped partial-output tail to attach to the error. */
  partialTail: () => string;
  /**
   * Per-handler retry-eligibility formula, given the already-computed tail.
   * Preserve each handler's exact current formula — do not unify.
   */
  retryEligible: (partialTail: string) => boolean;
  /**
   * Optional provider-specific error enrichment (tagging, wrapping, debug/warn
   * logging) run after the tail is computed and before `annotateStreamFailure`.
   * Returns the error to annotate and rethrow (the same reference if no
   * wrapping is needed).
   */
  decorateError?: (err: unknown, partialTail: string) => unknown;
}

/**
 * Runs the shared mid-stream failure skeleton: finalize → tail → decorate →
 * annotate → rethrow. Call this as the last step of a provider handler's
 * streaming catch block, in place of the previously hand-duplicated sequence.
 */
export function handleStreamingFailure(
  err: unknown,
  hooks: StreamingFailureHooks,
): never {
  hooks.finalizeOnError?.();
  const partialTail = hooks.partialTail();
  const decorated = hooks.decorateError
    ? hooks.decorateError(err, partialTail)
    : err;
  annotateStreamFailure(
    decorated,
    partialTail,
    hooks.retryEligible(partialTail),
  );
  throw decorated;
}
