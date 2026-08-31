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
  /** LEGACY: relay monthly spending limit. The relay was removed 2026-08
   *  (docs/proposals/2026-08-18-relay-removal-and-recovery.md); the member
   *  stays because persisted stream logs are reparsed on load and the legacy
   *  migration below reconstructs it. Delete after 2026-11. */
  'relay-limit',
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

/** Mutually exclusive provider-error classifications. The two runtime kinds
 * share AgentErrorKind's spelling; exhaustion members retain the actionable
 * route reason as the discriminant itself. */
const ProviderErrorClassificationSchema = z.object({
  kind: z.union([
    z.literal('missing-api-key'),
    z.literal('context-window'),
    ExhaustionReasonSchema,
  ]),
});
export type ProviderErrorClassification = z.infer<
  typeof ProviderErrorClassificationSchema
>;

/**
 * Normalizes persisted provider errors at the storage readers below. Older
 * records carried independent classification markers; preserve their original
 * runtime precedence (missing API key, context window, then exhaustion) while
 * exposing only the canonical classification downstream.
 */
function normalizeLegacyProviderErrorFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  let record = value as Record<string, unknown>;

  if (!('userRetryable' in record) && typeof record.retryable === 'boolean') {
    const { retryable, ...rest } = record;
    record = { ...rest, userRetryable: retryable };
  }

  const legacyClassificationKeys = [
    'exhaustionReason',
    'missingApiKey',
    'contextWindow',
    'isCredentialExhausted',
    'isUpstreamCreditDepleted',
    'isChatGptSubscriptionLimited',
  ] as const;
  const hasLegacyClassification = legacyClassificationKeys.some((key) =>
    Object.hasOwn(record, key),
  );
  if ('classification' in record) {
    return hasLegacyClassification
      ? { ...record, classification: { kind: undefined } }
      : record;
  }

  const {
    exhaustionReason,
    missingApiKey,
    contextWindow,
    isCredentialExhausted,
    isUpstreamCreditDepleted,
    isChatGptSubscriptionLimited,
    ...rest
  } = record;

  let kind: ProviderErrorClassification['kind'] | undefined;
  if (missingApiKey === true) {
    kind = 'missing-api-key';
  } else if (contextWindow === true) {
    kind = 'context-window';
  } else if (exhaustionReason !== undefined) {
    kind = exhaustionReason as ProviderErrorClassification['kind'];
  } else if (isChatGptSubscriptionLimited === true) {
    kind = 'chatgpt-subscription';
  } else if (isUpstreamCreditDepleted === true) {
    kind = 'upstream-credit';
  } else if (isCredentialExhausted === true) {
    kind = 'relay-limit';
  }

  if (!hasLegacyClassification) return record;

  // Preserve malformed present values as a parse failure rather than silently
  // treating corrupted persisted data as unclassified.
  if (
    (missingApiKey !== undefined && missingApiKey !== true) ||
    (contextWindow !== undefined && contextWindow !== true) ||
    (isCredentialExhausted !== undefined &&
      typeof isCredentialExhausted !== 'boolean') ||
    (isUpstreamCreditDepleted !== undefined &&
      typeof isUpstreamCreditDepleted !== 'boolean') ||
    (isChatGptSubscriptionLimited !== undefined &&
      typeof isChatGptSubscriptionLimited !== 'boolean')
  ) {
    return { ...rest, classification: { kind: undefined } };
  }

  return kind === undefined ? rest : { ...rest, classification: { kind } };
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
  /** The provider failure's one canonical classification. Absent for ordinary
   *  provider, transport, abort, and local-I/O failures. */
  classification: ProviderErrorClassificationSchema.optional(),
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
/** Canonical current ProviderError metadata. Unknown fields are rejected so
 * legacy or mixed records cannot enter the runtime metadata cache. */
export const ProviderErrorSchema = ProviderErrorObjectSchema.strict();
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/** Context about where/when the error occurred */
const ErrorContextSchema = z.object({
  operation: z.string().optional(),
  model: z.string().optional(),
});
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

/** Complete error log data, including the compatibility reader for unversioned
 * stream logs written before the canonical classification shipped. Remove the
 * preprocess after 2026-11-30, when those records have aged out. */
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

/** Canonical provider error with all fields optional for event transport. */
export const ProviderErrorPartialSchema =
  ProviderErrorObjectSchema.partial().strict();
export type ProviderErrorPartial = z.infer<typeof ProviderErrorPartialSchema>;

/** Recover the actionable exhaustion reason from the canonical classification. */
export function getExhaustionReason(
  errorDetails: Pick<ProviderError, 'classification'> | undefined | null,
): ExhaustionReason | undefined {
  const kind = errorDetails?.classification?.kind;
  return ExhaustionReasonSchema.safeParse(kind).success
    ? (kind as ExhaustionReason)
    : undefined;
}

/** Whether an identical retry needs a credential or route change first. */
export function isCredentialExhausted(
  errorDetails: Pick<ProviderError, 'classification'> | undefined | null,
): boolean {
  return getExhaustionReason(errorDetails) !== undefined;
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
export const RetryErrorInfoSchema = ProviderErrorObjectSchema.omit({
  rawErrorBody: true,
}).strict();
export type RetryErrorInfo = z.infer<typeof RetryErrorInfoSchema>;

/** Persisted retry-state reader for records written before the canonical
 * classification shipped. Remove after 2026-11-30, when those records have
 * aged out. Current runtime and IPC schemas must remain migration-free. */
export const PersistedRetryErrorInfoSchema = z.preprocess(
  normalizeLegacyProviderErrorFields,
  RetryErrorInfoSchema,
);

/** Project a full ProviderError onto the retry-state record by dropping the
 *  bulky `rawErrorBody`; every other field carries over unchanged. */
export function toRetryErrorInfo(err: ProviderError): RetryErrorInfo {
  const { rawErrorBody, ...rest } = err;
  return rest;
}
