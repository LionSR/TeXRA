// Third-party imports
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
});
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

/** Context about where/when the error occurred */
export const ErrorContextSchema = z.object({
  operation: z.string().optional(),
  model: z.string().optional(),
});
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

/** Complete error log data - combines provider error with context */
export const ErrorLogDataSchema = ProviderErrorSchema.extend({
  operation: z.string().optional(),
  model: z.string().optional(),
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
