import { Data } from 'effect';

/**
 * Base class for runtime errors raised by the agent layer.
 *
 * Host-neutral (lives in `@common/errors`) so any host can reference it.
 * Specific subclasses should be added only when a concrete thrower and
 * catcher exist for them — anything else duplicates the existing
 * `ProviderError` schema and `isUserAbort` machinery.
 */
export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentError';
  }
}

/**
 * No route can carry a model call now: its credential is missing or cannot
 * be read, the subscription session needs a sign-in, the editor offers no
 * Copilot route, or the model is unknown or unavailable. A failure of the
 * harness's own model access, never a vendor's (that is llm's `ModelError`).
 * `missing-api-key` is the one reason a host acts on (it offers the key
 * setting); every other reason is read as its message.
 */
export class RouteUnavailable extends Data.TaggedError('RouteUnavailable')<{
  readonly reason: 'missing-api-key' | 'unavailable';
  readonly message: string;
  readonly cause?: unknown;
}> {
  /** `cause`, read as the reason no route can carry the call. */
  static of(cause: Error): RouteUnavailable {
    return new RouteUnavailable({
      reason: 'unavailable',
      message: cause.message,
      cause,
    });
  }
}
