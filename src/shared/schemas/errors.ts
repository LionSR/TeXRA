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

function normalizeProviderErrorRetryFlag(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const data = value as Record<string, unknown>;
  if ('userRetryable' in data || typeof data.retryable !== 'boolean') {
    return value;
  }
  // Drop the legacy key rather than merely adding `userRetryable` alongside
  // it: callers that use this migration directly (not just as a
  // z.preprocess step ahead of an object schema that would otherwise strip
  // it) must not see a stale `retryable` field on the result.
  const { retryable, ...rest } = data;
  return {
    ...rest,
    userRetryable: retryable,
  };
}

/** Reason a credential/quota is exhausted, requiring user action before an
 *  identical retry can succeed. The reasons are mutually
 *  exclusive — a single error is classified as exactly one — which is why
 *  this is a discriminant rather than independent booleans (see
 *  `isCredentialExhausted` below for the pre-refactor combined check). */
export const ExhaustionReasonSchema = z.enum([
  /** Relay monthly spending limit reached; the stored personal key is fine. */
  'relay-limit',
  /** The upstream provider account itself is out of credit/quota — the key
   *  the user has IS the broken one, so a new key is required. */
  'upstream-credit',
  /** A ChatGPT-subscription (Codex) request was rejected because the plan's
   *  usage quota is exhausted; accepting the switch disables the "prefer
   *  ChatGPT subscription" preference rather than disabling relay. */
  'chatgpt-subscription',
  /** A GitHub Copilot request was rejected because the subscription quota is
   *  exhausted. */
  'copilot-subscription',
]);
export type ExhaustionReason = z.infer<typeof ExhaustionReasonSchema>;

/** Migrates the pre-refactor independent `isCredentialExhausted` /
 *  `isUpstreamCreditDepleted` / `isChatGptSubscriptionLimited` booleans (still
 *  present in error data persisted to disk by older TeXRA versions — stream
 *  logs are unversioned JSON reparsed on later loads) into `exhaustionReason`.
 *  Priority mirrors the original derivation order in `formatProviderHttpError`:
 *  ChatGPT-subscription and upstream-credit were independently detected and
 *  OR'd into `isCredentialExhausted` alongside the relay-limit condition, so a
 *  legacy record with only `isCredentialExhausted: true` set reconstructs as
 *  `'relay-limit'`. */
function normalizeLegacyExhaustionFlags(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const data = value as Record<string, unknown>;
  if ('exhaustionReason' in data) {
    return value;
  }
  const hasLegacyFlags =
    'isCredentialExhausted' in data ||
    'isUpstreamCreditDepleted' in data ||
    'isChatGptSubscriptionLimited' in data;
  if (!hasLegacyFlags) {
    return value;
  }
  const {
    isCredentialExhausted,
    isUpstreamCreditDepleted,
    isChatGptSubscriptionLimited,
    ...rest
  } = data;
  let exhaustionReason: ExhaustionReason | undefined;
  if (isChatGptSubscriptionLimited === true) {
    exhaustionReason = 'chatgpt-subscription';
  } else if (isUpstreamCreditDepleted === true) {
    exhaustionReason = 'upstream-credit';
  } else if (isCredentialExhausted === true) {
    exhaustionReason = 'relay-limit';
  }
  return exhaustionReason === undefined ? rest : { ...rest, exhaustionReason };
}

/**
 * Migrates the legacy `retryable`/exhaustion-boolean fields on a raw provider
 * error value into the canonical `userRetryable`/`exhaustionReason` shape.
 * Used both as the `z.preprocess` step for schemas below and directly by
 * `normalizeProviderError` (`@common/errors/sdkError/providerErrorFormat`) so
 * a cached `ProviderError` — attached before this migration ran, e.g. from a
 * resumed flow's raw persisted state — is normalized the same way a freshly
 * formatted error is, instead of being returned with legacy fields intact.
 */
export function normalizeLegacyProviderErrorFields(value: unknown): unknown {
  return normalizeLegacyExhaustionFlags(normalizeProviderErrorRetryFlag(value));
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
  /** True when the error is known to come from the relay. Omitted when the
   *  retry-state path cannot determine the relay verdict. Independent of
   *  `exhaustionReason` — a relay error can be a transient 5xx with no
   *  exhaustion, and an exhaustion can be direct-to-provider (upstream credit
   *  depletion) with no relay involved. */
  isRelayError: z.boolean().optional(),
  /** Reason the credential/quota is exhausted (relay monthly limit, upstream
   *  provider credit depletion, or a subscription usage limit). Auto-
   *  retry is skipped and the retry panel offers a "Use your own API key"
   *  button for any of these. Use the `isCredentialExhausted` helper below
   *  for the pre-refactor combined boolean check. */
  exhaustionReason: ExhaustionReasonSchema.optional(),
  requestId: z.string().optional(),
  rawErrorBody: z.unknown().optional(),
  streamDiagnostics: StreamDiagnosticsSchema.optional(),
  /** Tail of text generated before a streaming failure. Present when the
   *  stream produced any text before dying — lets the caller show it to the
   *  user or construct a continuation prompt on retry. Producers truncate
   *  to a few KB before attaching; this schema is inferred only, not parsed
   *  at runtime, so size enforcement is the producer's responsibility. */
  partialText: z.string().optional(),
});
const ProviderErrorSchema = z.preprocess(
  normalizeLegacyProviderErrorFields,
  ProviderErrorObjectSchema,
);
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/** Context about where/when the error occurred */
const ErrorContextSchema = z.object({
  operation: z.string().optional(),
  model: z.string().optional(),
});
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

/** Complete error log data - combines provider error with context */
export const ErrorLogDataSchema = z.preprocess(
  normalizeLegacyProviderErrorFields,
  ProviderErrorObjectSchema.extend(ErrorContextSchema.shape).extend({
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

/** Single source of truth for "this error is a ChatGPT-subscription (Codex)
 *  usage-limit rejection". Both hosts (VS Code progress view, CLI approval
 *  policy) branch on this to switch the retry from the relay/personal-key path
 *  to disabling the subscription preference. Accepts any error shape carrying
 *  the field (full `ProviderError`, `ProviderErrorPartial`, or `RetryErrorInfo`)
 *  so the predicate stays the one place that owns the verdict. */
export function isChatGptSubscriptionLimitError(
  errorDetails: Pick<ProviderError, 'exhaustionReason'> | undefined | null,
): boolean {
  return errorDetails?.exhaustionReason === 'chatgpt-subscription';
}

/** Single source of truth for "the upstream provider account itself is out of
 *  credit/quota" — the key the user has IS the broken one, so the auto-resume
 *  handler must require a new key rather than reusing the depleted stored
 *  credential (unlike relay-limit exhaustion, where the stored personal key
 *  is fine). */
export function isUpstreamCreditDepletedError(
  errorDetails: Pick<ProviderError, 'exhaustionReason'> | undefined | null,
): boolean {
  return errorDetails?.exhaustionReason === 'upstream-credit';
}

/** Single source of truth for "auto-retry should be skipped because the
 *  credential/quota is exhausted" — the combined check the pre-refactor
 *  `isCredentialExhausted` boolean used to store directly. Kept as a derived
 *  predicate (not a stored field) so the exhaustion reasons cannot drift
 *  out of sync with it. */
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
 * (drop `rawErrorBody`) and widening (it stays absent) rather than by
 * re-listing the field set in three places. Deriving the schema with `.omit()`
 * keeps it from drifting out of sync with `ProviderErrorObjectSchema` as new
 * error fields are added.
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

/** Reconstruct a ProviderError from retry-state info. `rawErrorBody` is absent
 *  and `isRelayError` stays `undefined` when it was absent, so
 *  `normalizeProviderError` does not read a wrong relay verdict from the cached
 *  shape. */
export function toProviderErrorFromRetry(info: RetryErrorInfo): ProviderError {
  return { ...info };
}
