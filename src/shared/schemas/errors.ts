import { z } from 'zod';

/** Stream diagnostics for debugging Anthropic streaming failures */
export const StreamDiagnosticsSchema = z.object({
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
  return {
    ...data,
    userRetryable: data.retryable,
  };
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
   *  retry-state path cannot determine the relay verdict. */
  isRelayError: z.boolean().optional(),
  /** True when the credential (relay monthly limit OR upstream provider
   *  account) has been exhausted. Auto-retry is skipped for these errors
   *  and the retry panel offers a "Use your own API key" button. */
  isCredentialExhausted: z.boolean().optional(),
  /** True when the upstream provider account itself is out of credit
   *  (Anthropic 400 "credit balance is too low"). Distinguishes the
   *  "the key I have IS the broken one" case from relay monthly limit,
   *  where the stored personal key is fine. The auto-resume handler
   *  uses this to require a new key rather than reusing the depleted
   *  stored credential. */
  isUpstreamCreditDepleted: z.boolean().optional(),
  /** True when a ChatGPT-subscription (Codex) request was rejected because the
   *  plan's usage quota is exhausted. Like the relay monthly limit it is a
   *  credential exhaustion (auto-retry suppressed, "Use your own API key"
   *  offered), but accepting that switch disables the "prefer ChatGPT
   *  subscription" preference and retries through the OpenAI API key rather
   *  than disabling relay. */
  isChatGptSubscriptionLimited: z.boolean().optional(),
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
  normalizeProviderErrorRetryFlag,
  ProviderErrorObjectSchema,
);
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/** Context about where/when the error occurred */
export const ErrorContextSchema = z.object({
  operation: z.string().optional(),
  model: z.string().optional(),
});
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

/** Complete error log data - combines provider error with context */
export const ErrorLogDataSchema = z.preprocess(
  normalizeProviderErrorRetryFlag,
  ProviderErrorObjectSchema.extend(ErrorContextSchema.shape).extend({
    rawMessage: z.string().optional(),
  }),
);
export type ErrorLogData = z.infer<typeof ErrorLogDataSchema>;

/** Provider error with all fields optional for event transport */
export const ProviderErrorPartialSchema = z.preprocess(
  normalizeProviderErrorRetryFlag,
  ProviderErrorObjectSchema.partial(),
);
export type ProviderErrorPartial = z.infer<typeof ProviderErrorPartialSchema>;

/** Single source of truth for "this error is a ChatGPT-subscription (Codex)
 *  usage-limit rejection". Both hosts (VS Code progress view, CLI approval
 *  policy) branch on this to switch the retry from the relay/personal-key path
 *  to disabling the subscription preference. Accepts any error shape carrying
 *  the flag (full `ProviderError`, `ProviderErrorPartial`, or `RetryErrorInfo`)
 *  so the predicate stays the one place that owns the verdict. */
export function isChatGptSubscriptionLimitError(
  errorDetails:
    | Pick<ProviderError, 'isChatGptSubscriptionLimited'>
    | undefined
    | null,
): boolean {
  return errorDetails?.isChatGptSubscriptionLimited === true;
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
  normalizeProviderErrorRetryFlag,
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
