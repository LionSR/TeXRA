import { Result, Schema, Struct } from 'effect';

/** Reason a credential/quota is exhausted, requiring user action before an
 *  identical retry can succeed. The reasons are mutually exclusive — a single
 *  error is classified as exactly one — which is why this is a discriminant
 *  rather than independent booleans. `getExhaustionReason` below answers the
 *  combined "exhausted for any reason" question. */
const ExhaustionReasonSchema = Schema.Literals([
  /** The upstream provider account itself is out of credit/quota — the key
   *  the user has IS the broken one, so a new key is required. */
  'upstream-credit',
  /** A ChatGPT-subscription (Codex) request was rejected because the plan's
   *  usage quota is exhausted; accepting the switch turns off "ChatGPT
   *  subscription" so the retry uses the OpenAI API key.
   *  Remark: permanently flipping it off is not always ideal — when the
   *  quota later resets, the user may forget to turn it back on. */
  'chatgpt-subscription',
  /** A GitHub Copilot request was rejected because the subscription quota is
   *  exhausted. */
  'copilot-subscription',
  /** A Kimi Code (Moonshot coding-subscription) request was rejected because
   *  the membership's usage quota is exhausted; accepting the switch turns off
   *  "Kimi Code subscription" so dual-backend Kimi models re-route through the
   *  Moonshot open-platform API key. */
  'kimi-code-subscription',
  /** A GLM Coding Plan request was rejected because the plan's usage quota is
   *  exhausted; accepting the switch turns off the Coding Plan toggle so GLM
   *  requests route through the regular pay-as-you-go endpoint. */
  'glm-coding-plan',
  /** A Grok (xAI SuperGrok) subscription request was rejected because the
   *  plan's usage quota is exhausted; accepting the switch turns off "Grok
   *  subscription" so xAI models re-route through the stored xAI API key. */
  'xai-subscription',
]);
export type ExhaustionReason = typeof ExhaustionReasonSchema.Type;

/** Mutually exclusive provider-error classifications. The two runtime kinds
 * share AgentErrorKind's spelling; exhaustion members retain the actionable
 * route reason as the discriminant itself. */
const ProviderErrorClassificationSchema = Schema.Struct({
  kind: Schema.Union([
    Schema.Literal('missing-api-key'),
    Schema.Literal('context-window'),
    ExhaustionReasonSchema,
  ]),
});
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
   *  auto-retry decision is made separately by `shouldAutoRetry`, which
   *  excludes credentialExhausted/auth errors even when `userRetryable` is
   *  true (because they need user action — a key swap or new API key —
   *  before any retry makes sense). */
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
/** Canonical current ProviderError metadata. Unknown fields are rejected so
 * legacy or mixed records cannot enter the runtime metadata cache. */
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
 * Complete error log data. Strict, like every sibling provider-error schema:
 * a stream log still carrying the retired independent classification markers
 * must fail loudly rather than have them stripped into a classification-less
 * row that reads as an ordinary provider failure.
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
