import { Result, Schema, Struct } from 'effect';

import { DeclinableUsageRouteSchema } from './usage';

/** The upstream provider account itself is out of credit/quota — the key the
 *  user has IS the broken one, so a new key is required. */
const UpstreamCreditSchema = Schema.Literal('upstream-credit');

/** Reason a credential/quota is exhausted, requiring user action before an
 *  identical retry can succeed. The reasons are mutually exclusive — a single
 *  error is classified as exactly one — which is why this is a discriminant
 *  rather than independent booleans. `getExhaustionReason` below answers the
 *  combined "exhausted for any reason" question. A used-up plan is named by
 *  the route that bills through it; the retry can decline that route for the
 *  run, so the model goes on with its own provider key (the regular
 *  pay-as-you-go endpoint, for the GLM Coding Plan). */
const ExhaustionReasonSchema = Schema.Union([
  UpstreamCreditSchema,
  DeclinableUsageRouteSchema,
]);
export type ExhaustionReason = typeof ExhaustionReasonSchema.Type;

/** A route that bills a signed-in subscription session (ChatGPT, Grok). */
export const SubscriptionSessionRouteSchema = DeclinableUsageRouteSchema.pick([
  'chatgpt-subscription',
  'xai-subscription',
]);

/** Mutually exclusive provider-error classifications. The two runtime kinds
 * share AgentErrorKind's spelling; exhaustion members retain the actionable
 * route reason as the discriminant itself. */
export const ProviderErrorClassificationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Union([
      Schema.Literals(['missing-api-key', 'context-window']),
      UpstreamCreditSchema,
    ]),
  }),
  /** A used-up plan, with what the provider said of it: its tier in the
   *  provider's own word (ChatGPT's `plus`), and how long until the quota
   *  resets, from the moment it refused. */
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
  /** True when the user should be offered a retry button. This gates the
   *  manual retry UI — it does NOT mean the retry loop will auto-retry. The
   *  automatic resend is decided separately, from the model error's own
   *  `retryable` (`failedNext` in `agent/runtime/run/invocation.ts`), which is
   *  false for authentication and quota errors even when `userRetryable` is
   *  true (they need user action — a key swap or new API key — before any
   *  retry makes sense). */
  userRetryable: Schema.Boolean,
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
/** Canonical current ProviderError metadata. The metadata cache decodes it
 *  with `onExcessProperty: 'error'`, so a legacy or mixed record never
 *  enters it. */
export const ProviderErrorSchema = ProviderErrorObjectSchema;
export type ProviderError = typeof ProviderErrorSchema.Type;

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

/** Recover the actionable exhaustion reason from the canonical classification. */
export function getExhaustionReason(
  errorDetails: Pick<ProviderError, 'classification'> | undefined | null,
): ExhaustionReason | undefined {
  const parsed = Schema.decodeUnknownResult(ExhaustionReasonSchema)(
    errorDetails?.classification?.kind,
  );
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}

/** Whether retrying past the automatic attempts needs a credential or route
 *  change first: an exhausted credential, or a 401 or 403. */
export function isCredentialRetryFailure(
  errorDetails:
    Pick<ProviderError, 'classification' | 'statusCode'> | undefined,
): boolean {
  return (
    getExhaustionReason(errorDetails) !== undefined ||
    errorDetails?.statusCode === 401 ||
    errorDetails?.statusCode === 403
  );
}

/** Project a full ProviderError onto the retry-state record by dropping the
 *  bulky `rawErrorBody`; every other field carries over unchanged. */
export function toRetryErrorInfo(err: ProviderError): RetryErrorInfo {
  const { rawErrorBody, ...rest } = err;
  return rest;
}
