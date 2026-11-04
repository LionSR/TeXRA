import { Schema, Struct } from 'effect';

import { DeclinableUsageRouteSchema } from './usage';

/** A route that bills a signed-in subscription session (ChatGPT, Grok). */
export const SubscriptionSessionRouteSchema = DeclinableUsageRouteSchema.pick([
  'chatgpt-subscription',
  'xai-subscription',
]);

/** A provider failure's one classification: a missing key, an overflowed
 *  window, the account's own credit run out (the key in use is the broken
 *  one, so only a new key helps), a used-up plan, or a subscription session
 *  that could not bill. */
export const ProviderErrorClassificationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals([
      'missing-api-key',
      'context-window',
      'upstream-credit',
    ]),
  }),
  /** A used-up plan, named by the route that bills through it (a retry can
   *  decline that route for the run, so the model goes on with the user's
   *  own key), with what the provider said of it: its tier in the provider's
   *  own word (ChatGPT's `plus`), and how long until the quota resets, from
   *  the moment it refused. */
  Schema.Struct({
    kind: DeclinableUsageRouteSchema,
    planType: Schema.optional(Schema.String),
    resetsInMs: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
  /** A signed-in subscription that could not bill the call: its route,
   *  whether only a fresh sign-in can help (else it may recover), and the
   *  session's own failure. */
  Schema.Struct({
    kind: Schema.Literal('subscription-session'),
    route: SubscriptionSessionRouteSchema,
    needsReauth: Schema.Boolean,
    sessionError: Schema.String,
  }),
]);
export type ProviderErrorClassification =
  (typeof ProviderErrorClassificationSchema)['Type'];

/** Core error details from a provider/SDK */
const ProviderErrorObjectSchema = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.optional(Schema.Int),
  statusText: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  /** The provider failure's one canonical classification. Absent for ordinary
   *  provider, transport, abort, and local-I/O failures. */
  classification: Schema.optional(ProviderErrorClassificationSchema),
  requestId: Schema.optional(Schema.String),
  rawErrorBody: Schema.optional(Schema.Unknown),
  /** Tail of the text the model streamed before the attempt failed, written
   *  by `failureInfo` from what the run loop had already received.
   *  Lets the retry surface show the user that the work so far is not lost.
   *  The producer truncates to a few KB; this schema is inferred only, not
   *  parsed at runtime, so size enforcement stays the producer's. */
  partialText: Schema.optional(Schema.String),
});
/** A provider failure as a host reads it: the retry record with its raw body. */
export type ProviderError = typeof ProviderErrorObjectSchema.Type;

/**
 * Minimal error info for retry state tracking.
 *
 * Structurally this is exactly a {@link ProviderError} without `rawErrorBody`
 * (large, not worth persisting in retry state) — that optional field is the
 * sole difference between the two shapes, so they round-trip by narrowing
 * (drop `rawErrorBody`) and widening (it stays absent). Deriving the schema
 * with `.omit()` keeps it from drifting out of sync with
 * `ProviderErrorObjectSchema` as new error fields are added.
 */
export const RetryErrorInfoSchema = ProviderErrorObjectSchema.mapFields(
  Struct.omit(['rawErrorBody']),
);
export type RetryErrorInfo = typeof RetryErrorInfoSchema.Type;

/** Context about where/when the error occurred */
const ErrorContextSchema = Schema.Struct({
  operation: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type ErrorContext = typeof ErrorContextSchema.Type;

/**
 * Complete error log data. `decodeLogPayload` reads it with
 * `onExcessProperty: 'error'`: a stream log still carrying the retired
 * independent classification markers must fail loudly rather than have them
 * stripped into a classification-less row that reads as an ordinary provider
 * failure.
 */
export const ErrorLogDataSchema = RetryErrorInfoSchema.mapFields(
  Struct.assign({
    // Compose the shared operation/model context pair from ErrorContextSchema
    // so adding a field there propagates to the flattened log-row shape instead
    // of silently diverging.
    ...ErrorContextSchema.fields,
    rawMessage: Schema.optional(Schema.String),
  }),
);
export type ErrorLogData = typeof ErrorLogDataSchema.Type;

/** Project a full ProviderError onto the retry-state record by dropping the
 *  bulky `rawErrorBody`; every other field carries over unchanged. */
export function toRetryErrorInfo(err: ProviderError): RetryErrorInfo {
  const { rawErrorBody, ...rest } = err;
  return rest;
}
