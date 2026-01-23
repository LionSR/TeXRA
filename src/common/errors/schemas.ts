/**
 * Canonical error schemas - SINGLE SOURCE OF TRUTH
 *
 * All error-related types in the codebase should derive from these schemas.
 * This file has NO internal project imports to avoid circular dependencies.
 *
 * Schema hierarchy:
 * - ProviderErrorSchema: Core error from provider/SDK (base)
 * - ErrorContextSchema: Where/when the error occurred (composition)
 * - ErrorLogDataSchema: Combined for logging (extends both)
 */

import { z } from 'zod';

// ============================================================================
// Core Provider Error Schema
// ============================================================================

/**
 * Core error details from a provider/SDK.
 * This is THE canonical error schema - all other error types derive from this.
 *
 * Used by:
 * - formatProviderHttpError() return type
 * - Retry request UI (errorDetails)
 * - Progress view error display
 */
/**
 * Stream diagnostics for debugging Anthropic streaming failures.
 * Shows what was received before the stream errored.
 *
 * Uses prefault() for sensible defaults - allows partial creation
 * while ensuring all fields are present in output.
 */
export const StreamDiagnosticsSchema = z.object({
  /** Characters of thinking content received */
  thinkingChars: z.number().prefault(0),
  /** Characters of text content received */
  textChars: z.number().prefault(0),
  /** Characters of tool input JSON received */
  toolInputChars: z.number().prefault(0),
  /** Block types seen (e.g., ['thinking', 'text']) */
  blockTypesSeen: z.array(z.string()).prefault([]),
  /** Total events processed */
  eventsProcessed: z.number().prefault(0),
  /** Last event type (e.g., 'content_block_delta') */
  lastEventType: z.string().nullable().prefault(null),
  /** Seconds since stream started */
  elapsedSecs: z.number().prefault(0),
  /** Seconds since last event (stall detection) */
  secsSinceLastEvent: z.number().prefault(0),
  /** Whether handler was finalized */
  finalized: z.boolean().prefault(false),
});

export type StreamDiagnostics = z.infer<typeof StreamDiagnosticsSchema>;

export const ProviderErrorSchema = z.object({
  /** Human-readable error message (includes HTTP prefix when applicable) */
  message: z.string(),
  /** HTTP status code reported by the provider, when present */
  statusCode: z.int().optional(),
  /** HTTP status text (e.g., "Not Found", "Too Many Requests") */
  statusText: z.string().optional(),
  /** Provider identifier (openai, anthropic, google, kimi) */
  provider: z.string().optional(),
  /**
   * Whether the error can be retried:
   * - Connection errors (timeout, network) → true
   * - Server errors (5xx) and rate limits (429) → true
   * - User abort, auth errors, bad requests → false
   */
  retryable: z.boolean(),
  /**
   * Whether error originated from relay service.
   * Relay errors have `_relay` field in rawErrorBody.
   */
  isRelayError: z.boolean(),
  /** Provider request ID for support debugging */
  requestId: z.string().optional(),
  /** Raw error body from provider API response */
  rawErrorBody: z.unknown().optional(),
  /**
   * Stream diagnostics for Anthropic streaming failures.
   * Shows what was received before the stream errored (thinking chars, text chars, etc.)
   */
  streamDiagnostics: StreamDiagnosticsSchema.optional(),
});

/** Core error details from a provider/SDK */
export type ProviderError = z.infer<typeof ProviderErrorSchema>;

// ============================================================================
// Error Context Schema (for composition)
// ============================================================================

/**
 * Context about where/when the error occurred.
 * Separate from error details for clean composition.
 */
export const ErrorContextSchema = z.object({
  /** Operation that failed (e.g., "Model invocation", "Tool-use call") */
  operation: z.string().optional(),
  /** Model being used when error occurred */
  model: z.string().optional(),
});

/** Context about where/when the error occurred */
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

// ============================================================================
// Error Log Data Schema (composed)
// ============================================================================

/**
 * Complete error log data - combines provider error with context.
 * Used for progress view logging via AgentLogger.
 */
export const ErrorLogDataSchema = ProviderErrorSchema.extend({
  /** Operation that failed */
  operation: z.string().optional(),
  /** Model being used */
  model: z.string().optional(),
  /** Original error message before formatting (if different from message) */
  rawMessage: z.string().optional(),
});

/** Complete error data for logging */
export type ErrorLogData = z.infer<typeof ErrorLogDataSchema>;

// ============================================================================
// Partial Schema for Event Bus (optional fields for transport)
// ============================================================================

/**
 * Provider error with all fields optional for event transport.
 * Used when passing error details through the event bus where
 * some fields may not be present.
 */
export const ProviderErrorPartialSchema = ProviderErrorSchema.partial();

/** Provider error with optional fields */
export type ProviderErrorPartial = z.infer<typeof ProviderErrorPartialSchema>;

// ============================================================================
// Minimal Error Info Schema (for flow state persistence)
// ============================================================================

/**
 * Minimal error info for retry state tracking.
 * Subset of ProviderError fields needed for flow control and persistence.
 *
 * Used by cycle flows to track last error across retry attempts.
 * This is intentionally minimal - full error details are logged separately.
 */
export const RetryErrorInfoSchema = ProviderErrorSchema.pick({
  message: true,
  retryable: true,
});

/** Minimal error info for flow state */
export type RetryErrorInfo = z.infer<typeof RetryErrorInfoSchema>;
