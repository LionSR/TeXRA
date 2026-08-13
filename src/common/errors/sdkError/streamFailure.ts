import { attachPartialText } from './errorMetadata';

/**
 * Hooks for {@link handleStreamingFailure}, the shared tail of the mid-stream
 * failure skeleton every provider handler's streaming catch block runs:
 * finalize the in-flight progress streams, compute the partial-output tail,
 * optionally enrich or log the error, then annotate it and rethrow.
 *
 * Each hook is a thin accessor over state the handler already computed in its
 * own catch block (stream diagnostics and aggregator buffers). This function
 * does not own stream consumption or recovery. One carve-out
 * this deliberately does NOT try to unify (see callers for the exact
 * preserved behavior):
 *  - OpenAI Responses' `recover` path (polling fallback after an unhandled
 *    SSE event) is attempted at two points *inside* the handler's own try
 *    block, before this function's catch-tail ever runs; it only fires here
 *    if recovery itself also failed.
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
   * Optional provider-specific error enrichment (tagging, wrapping, debug/warn
   * logging) run after the tail is computed and before partial text is attached.
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
  attachPartialText(decorated, partialTail);
  throw decorated;
}
