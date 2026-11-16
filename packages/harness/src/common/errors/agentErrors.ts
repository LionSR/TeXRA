import { Predicate, Schema } from 'effect';

import {
  LaunchNoticeSchema,
  ModelFailureSchema,
  ResumeBlockedSchema,
  SubscriptionSessionFailureSchema,
} from '@shared/schemas';

/**
 * A runtime failure of the agent layer: a run that ended failed, a launch
 * that could not be built, or a model call that failed as its rows record it.
 *
 * Host-neutral, so any host can reference it.
 * A more specific error should be added only when a concrete thrower and
 * catcher exist for it — anything else duplicates the existing
 * `ModelFailure` verdict.
 */
export class AgentError extends Schema.TaggedError<AgentError>()('AgentError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  /** A model failure as the run's rows record it (the run ended on it, or a
   *  helper call raised it), which a host reads in place of this message's
   *  words. */
  failure: Schema.optional(ModelFailureSchema),
}) {}

/**
 * A launch refused before its run exists, for an input its caller supplied:
 * an unknown agent or model (each with the `notice` a host shows in place of
 * the message), a persona or configuration its schema rejects, or a run id
 * already in use.
 */
export class LaunchRefused extends Schema.TaggedError<LaunchRefused>()(
  'LaunchRefused',
  {
    message: Schema.String,
    notice: Schema.optional(LaunchNoticeSchema),
  },
) {}

/**
 * An agent this process cannot run now: missing from the catalog, or from
 * a plugin that is off or not trusted as it is now (`blocked`, which names
 * the agent or the plugin), with the launch's reason as its message. A
 * launch reports it as its refusal; a resume refuses with `blocked`, and
 * the run stays interrupted until a later resume finds it back.
 */
export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()(
  'AgentUnavailable',
  { blocked: ResumeBlockedSchema, message: Schema.String },
) {}

/**
 * No route can carry a model call now: its credential is missing or cannot
 * be read, the subscription session needs a sign-in, or the model is unknown
 * or unavailable. A failure of the
 * harness's own model access, never a vendor's (that is llm's `ModelError`).
 * A missing key is the one fact a host acts on (it offers the key
 * setting); any other failure is read as its message, which for a
 * subscription session is the session's own failure, recorded with its
 * route and remedy (`session`) on the run's `route` failure.
 */
export class RouteUnavailable extends Schema.TaggedError<RouteUnavailable>()(
  'RouteUnavailable',
  {
    /** The route's credential is not set anywhere the run reads. */
    missingApiKey: Schema.optional(Schema.Literal(true)),
    message: Schema.String,
    /** A signed-in subscription that could not bill the call: its route,
     *  and whether only a fresh sign-in can help (else it may recover). */
    session: Schema.optional(SubscriptionSessionFailureSchema),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** `cause`, read as the reason no route can carry the call. */
  static of(cause: Error): RouteUnavailable {
    return new RouteUnavailable({ message: cause.message, cause });
  }

  /**
   * A subscription session that could not be read or renewed, as its facts:
   * the route that could not bill, the session's own failure, and whether
   * only a fresh sign-in helps (the sign-in error's `needsReauth`). The one
   * place either path that reads a session decides it.
   */
  static ofSession(
    route: (typeof SubscriptionSessionFailureSchema.Type)['route'],
    error: Error,
  ): RouteUnavailable {
    return new RouteUnavailable({
      message: error.message,
      session: {
        route,
        needsReauth:
          Predicate.hasProperty(error, 'needsReauth') &&
          error.needsReauth === true,
      },
      cause: error,
    });
  }
}
