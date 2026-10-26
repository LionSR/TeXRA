import { Schema } from 'effect';

/**
 * A runtime failure of the agent layer: a launch it refuses or a run that
 * ended failed.
 *
 * Host-neutral, so any host can reference it.
 * A more specific error should be added only when a concrete thrower and
 * catcher exist for it — anything else duplicates the existing
 * `ProviderError` schema and `isUserAbort` machinery.
 */
export class AgentError extends Schema.TaggedError<AgentError>()('AgentError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * No route can carry a model call now: its credential is missing or cannot
 * be read, the subscription session needs a sign-in, the editor offers no
 * Copilot route, or the model is unknown or unavailable. A failure of the
 * harness's own model access, never a vendor's (that is llm's `ModelError`).
 * `missing-api-key` is the one reason a host acts on (it offers the key
 * setting); every other reason is read as its message.
 */
export class RouteUnavailable extends Schema.TaggedError<RouteUnavailable>()(
  'RouteUnavailable',
  {
    reason: Schema.Literals(['missing-api-key', 'unavailable']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** `cause`, read as the reason no route can carry the call. */
  static of(cause: Error): RouteUnavailable {
    return new RouteUnavailable({
      reason: 'unavailable',
      message: cause.message,
      cause,
    });
  }
}
