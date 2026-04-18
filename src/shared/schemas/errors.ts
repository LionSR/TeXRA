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

/** Core error details from a provider/SDK */
const ProviderErrorSchema = z.object({
  message: z.string(),
  statusCode: z.int().optional(),
  statusText: z.string().optional(),
  provider: z.string().optional(),
  retryable: z.boolean(),
  isRelayError: z.boolean(),
  requestId: z.string().optional(),
  rawErrorBody: z.unknown().optional(),
  streamDiagnostics: StreamDiagnosticsSchema.optional(),
  /** Tail of text generated before a streaming failure (capped). Present when
   *  the stream produced any text before dying — lets the caller show it to
   *  the user or construct a continuation prompt on retry. */
  partialText: z.string().optional(),
});
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/** Context about where/when the error occurred */
export const ErrorContextSchema = z.object({
  operation: z.string().optional(),
  model: z.string().optional(),
});
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

/** Complete error log data - combines provider error with context */
export const ErrorLogDataSchema = ProviderErrorSchema.extend(
  ErrorContextSchema.shape,
).extend({
  rawMessage: z.string().optional(),
});
export type ErrorLogData = z.infer<typeof ErrorLogDataSchema>;

/** Provider error with all fields optional for event transport */
export const ProviderErrorPartialSchema = ProviderErrorSchema.partial();
export type ProviderErrorPartial = z.infer<typeof ProviderErrorPartialSchema>;

/** Minimal error info for retry state tracking */
export const RetryErrorInfoSchema = ProviderErrorSchema.pick({
  message: true,
  retryable: true,
});
export type RetryErrorInfo = z.infer<typeof RetryErrorInfoSchema>;
