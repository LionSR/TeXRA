/**
 * Unified streaming event schema for all model providers.
 *
 * This module defines the normalized event types that all provider-specific
 * streams are converted to. The unified schema enables:
 * - Consistent consumption across all providers
 * - Type-safe event handling
 * - Simplified testing with mock event streams
 *
 * All providers normalize their SDK-specific events to these types via
 * normalizer generators in ./normalizers/
 */

import { z } from 'zod';

import { NormalizedUsageSchema } from '@agent/types/NormalizedUsage';

import { WebSearchResultEntrySchema } from './types';

// ============================================================================
// Content Streaming Events
// ============================================================================

/**
 * Thinking/reasoning content delta.
 * Emitted as the model generates internal reasoning (Claude thinking, o1 reasoning, etc.)
 */
export const ThinkingEventSchema = z.object({
  type: z.literal('thinking'),
  /** Incremental thinking text */
  delta: z.string(),
  /**
   * Block index for providers with interleaved content (Anthropic).
   * Used to track separate thinking phases when thinking is interrupted by other content.
   */
  blockIndex: z.number().optional(),
});

/**
 * Output content delta.
 * Emitted as the model generates visible output text.
 */
export const ContentEventSchema = z.object({
  type: z.literal('content'),
  /** Incremental output text */
  delta: z.string(),
  /**
   * Block index for providers with interleaved content (Anthropic).
   * Used to determine if text blocks are consecutive (should share stream).
   */
  blockIndex: z.number().optional(),
});

// ============================================================================
// Tool Call Events
// ============================================================================

/**
 * Tool call initiated.
 * Emitted when the model starts a tool/function call.
 */
export const ToolCallStartEventSchema = z.object({
  type: z.literal('tool_call_start'),
  /** Unique identifier for this tool call */
  id: z.string(),
  /** Name of the tool being called */
  name: z.string(),
  /**
   * Index for providers that stream tool calls with indices (OpenAI).
   * Used to correlate delta events with the correct tool call.
   */
  index: z.number().optional(),
});

/**
 * Tool call arguments delta.
 * Emitted as tool call arguments are streamed.
 */
export const ToolCallDeltaEventSchema = z.object({
  type: z.literal('tool_call_delta'),
  /** Tool call ID this delta belongs to */
  id: z.string(),
  /** Incremental JSON arguments string */
  arguments: z.string(),
});

/**
 * Tool call completed.
 * Emitted when a tool call's arguments are fully received.
 */
export const ToolCallDoneEventSchema = z.object({
  type: z.literal('tool_call_done'),
  /** Tool call ID that completed */
  id: z.string(),
});

// ============================================================================
// Server Tool Events (Native Tools)
// ============================================================================

/**
 * Web search status for native search tools.
 */
export const WebSearchStatusSchema = z.enum([
  'in_progress',
  'completed',
  'failed',
]);

/**
 * Web search result from native search tools (Anthropic, OpenAI).
 * Emitted when the provider executes a web search.
 */
export const WebSearchEventSchema = z.object({
  type: z.literal('web_search'),
  /** Unique identifier for this search call (for deduplication) */
  callId: z.string(),
  /** The search query executed */
  query: z.string(),
  /** Search result entries */
  results: z.array(WebSearchResultEntrySchema),
  /** Current status of the search */
  status: WebSearchStatusSchema,
  /** Provider that executed the search */
  provider: z.enum(['anthropic', 'openai']),
});

// ============================================================================
// Completion Events
// ============================================================================

/**
 * Usage statistics.
 * Emitted when usage data is available (typically at stream end).
 */
export const UsageEventSchema = z.object({
  type: z.literal('usage'),
  /** Normalized usage statistics */
  usage: NormalizedUsageSchema,
});

/**
 * Provider-agnostic stop reason.
 * Normalized from provider-specific stop reasons.
 */
export const NormalizedStopReasonSchema = z.enum([
  'stop', // Natural end (end_turn, stop, STOP)
  'max_tokens', // Output limit reached
  'tool_use', // Tool call requires execution
  'content_filter', // Content filtered
  'error', // Error occurred
  'unknown', // Unrecognized reason
]);

/**
 * Normalized response structure.
 * Contains the final aggregated response data.
 */
export const NormalizedResponseSchema = z.object({
  /** Final output text */
  text: z.string(),
  /** Accumulated thinking/reasoning text (if any) */
  thinking: z.string().optional(),
  /** Tool calls extracted from response */
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.string(),
      }),
    )
    .optional(),
  /** Normalized stop reason */
  stopReason: NormalizedStopReasonSchema,
  /** Usage statistics (if available) */
  usage: NormalizedUsageSchema.optional(),
  /**
   * Raw provider response for cases where additional data is needed.
   * Typed as unknown to avoid coupling to provider-specific types.
   */
  raw: z.unknown().optional(),
});

/**
 * Stream completion event.
 * Emitted when streaming is complete with the final response.
 */
export const DoneEventSchema = z.object({
  type: z.literal('done'),
  /** The complete normalized response */
  response: NormalizedResponseSchema,
});

// ============================================================================
// Error Event
// ============================================================================

/**
 * Stream error event.
 * Emitted when an error occurs during streaming.
 */
export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  /** Error message */
  message: z.string(),
  /** Error code (if available) */
  code: z.string().optional(),
  /** Whether the stream can be retried */
  retryable: z.boolean().optional(),
});

// ============================================================================
// Union Schema
// ============================================================================

/**
 * Discriminated union of all stream event types.
 * Use this for type-safe event handling with switch statements.
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  ThinkingEventSchema,
  ContentEventSchema,
  ToolCallStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallDoneEventSchema,
  WebSearchEventSchema,
  UsageEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
]);

// ============================================================================
// Type Exports (inferred from schemas)
// ============================================================================

export type ThinkingEvent = z.infer<typeof ThinkingEventSchema>;
export type ContentEvent = z.infer<typeof ContentEventSchema>;
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;
export type ToolCallDeltaEvent = z.infer<typeof ToolCallDeltaEventSchema>;
export type ToolCallDoneEvent = z.infer<typeof ToolCallDoneEventSchema>;
export type WebSearchEvent = z.infer<typeof WebSearchEventSchema>;
export type WebSearchStatus = z.infer<typeof WebSearchStatusSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type NormalizedStopReason = z.infer<typeof NormalizedStopReasonSchema>;
export type NormalizedResponse = z.infer<typeof NormalizedResponseSchema>;
export type DoneEvent = z.infer<typeof DoneEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type StreamEvent = z.infer<typeof StreamEventSchema>;

// ============================================================================
// Type Guards
// ============================================================================

/** Type guard for thinking events */
export function isThinkingEvent(event: StreamEvent): event is ThinkingEvent {
  return event.type === 'thinking';
}

/** Type guard for content events */
export function isContentEvent(event: StreamEvent): event is ContentEvent {
  return event.type === 'content';
}

/** Type guard for tool call start events */
export function isToolCallStartEvent(
  event: StreamEvent,
): event is ToolCallStartEvent {
  return event.type === 'tool_call_start';
}

/** Type guard for tool call delta events */
export function isToolCallDeltaEvent(
  event: StreamEvent,
): event is ToolCallDeltaEvent {
  return event.type === 'tool_call_delta';
}

/** Type guard for tool call done events */
export function isToolCallDoneEvent(
  event: StreamEvent,
): event is ToolCallDoneEvent {
  return event.type === 'tool_call_done';
}

/** Type guard for web search events */
export function isWebSearchEvent(event: StreamEvent): event is WebSearchEvent {
  return event.type === 'web_search';
}

/** Type guard for usage events */
export function isUsageEvent(event: StreamEvent): event is UsageEvent {
  return event.type === 'usage';
}

/** Type guard for done events */
export function isDoneEvent(event: StreamEvent): event is DoneEvent {
  return event.type === 'done';
}

/** Type guard for error events */
export function isErrorEvent(event: StreamEvent): event is ErrorEvent {
  return event.type === 'error';
}
