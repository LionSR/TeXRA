import { Schema } from 'effect';

import {
  DeclinableUsageRouteSchema,
  LaunchNoticeSchema,
} from '@shared/schemas';

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
  /** A refused launch's notice (an unknown model, an unknown agent), which
   *  the launch's caller shows in place of the generic error. */
  notice: Schema.optional(LaunchNoticeSchema),
}) {}

/**
 * No route can carry a model call now: its credential is missing or cannot
 * be read, the subscription session needs a sign-in, or the model is unknown
 * or unavailable. A failure of the
 * harness's own model access, never a vendor's (that is llm's `ModelError`).
 * `missing-api-key` is the one reason a host acts on (it offers the key
 * setting); every other reason is read as its message, which for a
 * subscription session is the session's own failure, worded with its route
 * and remedy by `providerErrorOf`.
 */
export class RouteUnavailable extends Schema.TaggedError<RouteUnavailable>()(
  'RouteUnavailable',
  {
    reason: Schema.Literals(['missing-api-key', 'unavailable']),
    message: Schema.String,
    /** A signed-in subscription that could not bill the call: its route,
     *  and whether only a fresh sign-in can help (else it may recover). */
    session: Schema.optional(
      Schema.Struct({
        route: DeclinableUsageRouteSchema.pick([
          'chatgpt-subscription',
          'xai-subscription',
        ]),
        needsReauth: Schema.Boolean,
      }),
    ),
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
