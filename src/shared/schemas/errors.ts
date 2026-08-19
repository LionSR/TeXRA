import { z } from 'zod';

/** Stream diagnostics for debugging Anthropic streaming failures */
const StreamDiagnosticsSchema = z.object({
  thinkingChars: z.number().prefault(0),
  textChars: z.number().prefault(0),
  toolInputChars: z.number().prefault(0),
  blockTypesSeen: z.array(z.string()).prefault([]),
  eventsProcessed: z.number().prefault(0),
  lastEventType: z.string().nullable().prefault(null),
  elapsedSecs: z.number().prefault(0),
  secsSinceLastEvent: z.number().prefault(0),
  finalized: z.boolean().prefault(false),
  /** Whether a message_start event was received from the API */
  messageStartReceived: z.boolean().prefault(false),
  /** Whether a message_stop event was received from the API */
  messageStopReceived: z.boolean().prefault(false),
  /** Stop reason from message_delta (e.g. 'end_turn', 'tool_use', 'max_tokens') */
  stopReason: z.string().nullable().prefault(null),
  /** Anthropic message ID from message_start (e.g. 'msg_01XFD...') */
  anthropicMessageId: z.string().nullable().prefault(null),
});

export type StreamDiagnostics = z.infer<typeof StreamDiagnosticsSchema>;

/** Reason a credential/quota is exhausted, requiring user action before an
 *  identical retry can succeed. The reasons are mutually exclusive — a single
 *  error is classified as exactly one — which is why this is a discriminant
 *  rather than independent booleans. `isCredentialExhausted` below answers the
 *  combined "exhausted for any reason" question. */
export const ExhaustionReasonSchema = z.enum([
  /** The upstream provider account itself is out of credit/quota — the key
   *  the user has IS the broken one, so a new key is required. */
  'upstream-credit',
  /** A ChatGPT-subscription (Codex) request was rejected because the plan's
   *  usage quota is exhausted; accepting the switch disables the "prefer
   *  ChatGPT subscription" preference.
   *  Remark: permanently flipping prefer-off is not always ideal — when the
   *  quota later resets, the user may forget to turn the preference back on. */
  'chatgpt-subscription',
  /** A GitHub Copilot request was rejected because the subscription quota is
   *  exhausted. */
  'copilot-subscription',
  /** A Kimi Code (Moonshot coding-subscription) request was rejected because
   *  the membership's usage quota is exhausted; accepting the switch disables
   *  the "Prefer Kimi Code" preference so dual-backend Kimi models re-route
   *  through the Moonshot open-platform API key. */
  'kimi-code-subscription',
  /** A GLM Coding Plan request was rejected because the plan's usage quota is
   *  exhausted; accepting the switch turns off the Coding Plan toggle so GLM
   *  requests route through the regular pay-as-you-go endpoint. */
  'glm-coding-plan',
  /** A Grok (xAI SuperGrok) subscription request was rejected because the
   *  plan's usage quota is exhausted; accepting the switch disables the
   *  "prefer Grok subscription" preference so xAI models re-route through
   *  the stored xAI API key. */
  'xai-subscription',
]);
export type ExhaustionReason = z.infer<typeof ExhaustionReasonSchema>;

/**
 * Migrates the legacy `retryable`/exhaustion-boolean fields on a raw provider
 * error value into the canonical `userRetryable`/`exhaustionReason` shape.
 * Used both as the `z.preprocess` step for schemas below and directly by
 * `normalizeProviderError` (`@common/errors/sdkError/providerErrorFormat`) so
 * a cached `ProviderError` — attached before this migration ran, e.g. from a
 * resumed flow's raw persisted state — is normalized the same way a freshly
 * formatted error is, instead of being returned with legacy fields intact.
 *
 * The pre-refactor independent `isCredentialExhausted` /
 * `isUpstreamCreditDepleted` / `isChatGptSubscriptionLimited` booleans are
 * still present in error data persisted to disk by older TeXRA versions (stream
 * logs are unversioned JSON reparsed on later loads). Priority mirrors the
 * original derivation order in `formatProviderHttpError`: ChatGPT-subscription
 * and upstream-credit were independently detected and OR'd into
 * `isCredentialExhausted` alongside the (now-removed) relay-limit condition.
 * A legacy record with only the bare `isCredentialExhausted: true` therefore
 * has no surviving reason to map to, and normalizes with no
 * `exhaustionReason` at all rather than an invented one.
 */
export function normalizeLegacyProviderErrorFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  let record = value as Record<string, unknown>;

  if (!('userRetryable' in record) && typeof record.retryable === 'boolean') {
    const { retryable, ...rest } = record;
    record = { ...rest, userRetryable: retryable };
  }

  if ('exhaustionReason' in record) {
    return record;
  }

  const hasLegacyExhaustionFlags =
    'isCredentialExhausted' in record ||
    'isUpstreamCreditDepleted' in record ||
    'isChatGptSubscriptionLimited' in record;
  if (!hasLegacyExhaustionFlags) {
    return record;
  }

  const {
    isCredentialExhausted,
    isUpstreamCreditDepleted,
    isChatGptSubscriptionLimited,
    ...rest
  } = record;

  let exhaustionReason: ExhaustionReason | undefined;
  if (isChatGptSubscriptionLimited === true) {
    exhaustionReason = 'chatgpt-subscription';
  } else if (isUpstreamCreditDepleted === true) {
    exhaustionReason = 'upstream-credit';
  }
  // A bare `isCredentialExhausted: true` used to reconstruct as 'relay-limit'.
  // That member is gone with the relay, and there is no other reason it could
  // have meant, so the record keeps its message and simply carries no
  // exhaustion classification. The legacy booleans are dropped either way.
  return exhaustionReason === undefined ? rest : { ...rest, exhaustionReason };
}

/** Core error details from a provider/SDK */
const ProviderErrorObjectSchema = z.object({
  message: z.string(),
  statusCode: z.int().optional(),
  statusText: z.string().optional(),
  provider: z.string().optional(),
  /** True when the user should be offered a retry button. This gates the
   *  manual retry UI — it does NOT mean the retry loop will auto-retry. The
   *  auto-retry decision is made separately by `shouldAutoRetry`, which
   *  excludes credentialExhausted/auth errors even when `userRetryable` is
   *  true (because they need user action — a key swap or new API key —
   *  before any retry makes sense). */
  userRetryable: z.boolean(),
  /** Reason the credential/quota is exhausted (upstream provider credit
   *  depletion, or a subscription usage limit). Auto-
   *  retry is skipped and the retry panel offers a "Use your own API key"
   *  button for any of these. Use the `isCredentialExhausted` helper below
   *  for the combined check. */
  exhaustionReason: ExhaustionReasonSchema.optional(),
  requestId: z.string().optional(),
  /** True when the underlying failure was "no usable credential", detected via
   *  the typed marker at its one throw site. Carried explicitly because the
   *  retry-state flatten drops the Error object (and its Symbol metadata), and
   *  the classifier is deliberately marker-only for this kind. */
  missingApiKey: z.literal(true).optional(),
  /** True when the failure was an internally-tagged context-window overflow.
   *  Same rationale as `missingApiKey`: internal preflight throws carry the
   *  verdict as a typed marker, and their messages match no provider prose
   *  pattern, so the flatten must carry it explicitly. */
  contextWindow: z.literal(true).optional(),
  rawErrorBody: z.unknown().optional(),
  streamDiagnostics: StreamDiagnosticsSchema.optional(),
  /** Tail of text generated before a streaming failure. Present when the
   *  stream produced any text before dying — lets the caller show it to the
   *  user or construct a continuation prompt on retry. Producers truncate
   *  to a few KB before attaching; this schema is inferred only, not parsed
   *  at runtime, so size enforcement is the producer's responsibility. */
  partialText: z.string().optional(),
});
export type ProviderError = z.infer<typeof ProviderErrorObjectSchema>;

/** Context about where/when the error occurred */
const ErrorContextSchema = z.object({
  operation: z.string().optional(),
  model: z.string().optional(),
});
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

/** Complete error log data - combines provider error with context */
export const ErrorLogDataSchema = z.preprocess(
  normalizeLegacyProviderErrorFields,
  ProviderErrorObjectSchema.extend({
    // Compose the shared operation/model context pair from ErrorContextSchema
    // so adding a field there propagates to the flattened log-row shape instead
    // of silently diverging (mirrors the omit-based RetryErrorInfoSchema).
    ...ErrorContextSchema.shape,
    rawMessage: z.string().optional(),
  }),
);
export type ErrorLogData = z.infer<typeof ErrorLogDataSchema>;

/** Provider error with all fields optional for event transport */
export const ProviderErrorPartialSchema = z.preprocess(
  normalizeLegacyProviderErrorFields,
  ProviderErrorObjectSchema.partial(),
);
export type ProviderErrorPartial = z.infer<typeof ProviderErrorPartialSchema>;

/** Single source of truth for "auto-retry should be skipped because the
 *  credential/quota is exhausted". Derived from `exhaustionReason` rather than
 *  stored as its own field, so the two cannot drift out of sync. */
export function isCredentialExhausted(
  errorDetails: Pick<ProviderError, 'exhaustionReason'> | undefined | null,
): boolean {
  return errorDetails?.exhaustionReason !== undefined;
}

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
export const RetryErrorInfoSchema = z.preprocess(
  normalizeLegacyProviderErrorFields,
  ProviderErrorObjectSchema.omit({ rawErrorBody: true }),
);
export type RetryErrorInfo = z.infer<typeof RetryErrorInfoSchema>;

/** Project a full ProviderError onto the retry-state record by dropping the
 *  bulky `rawErrorBody`; every other field carries over unchanged. */
export function toRetryErrorInfo(err: ProviderError): RetryErrorInfo {
  const { rawErrorBody, ...rest } = err;
  return rest;
}
