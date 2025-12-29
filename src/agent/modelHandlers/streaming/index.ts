/**
 * Unified streaming module for model handlers.
 *
 * This module provides a consistent streaming abstraction across all providers:
 * - Normalized event types (StreamEvent)
 * - Provider-specific normalizers
 *
 * Usage:
 * ```typescript
 * // In a model handler:
 * const normalizedStream = normalizeAnthropicStream(sdkStream, options);
 * const result = await this.consumeNormalizedStream(normalizedStream);
 * return result.response.raw;
 * ```
 */

// Schema and event types
export {
  // Schemas
  StreamEventSchema,
  ThinkingEventSchema,
  ContentEventSchema,
  ToolCallStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallDoneEventSchema,
  WebSearchEventSchema,
  WebSearchStatusSchema,
  UsageEventSchema,
  NormalizedResponseSchema,
  NormalizedStopReasonSchema,
  DoneEventSchema,
  ErrorEventSchema,
  // Types
  type StreamEvent,
  type ThinkingEvent,
  type ContentEvent,
  type ToolCallStartEvent,
  type ToolCallDeltaEvent,
  type ToolCallDoneEvent,
  type WebSearchEvent,
  type WebSearchStatus,
  type UsageEvent,
  type NormalizedResponse,
  type NormalizedStopReason,
  type DoneEvent,
  type ErrorEvent,
  // Type guards
  isThinkingEvent,
  isContentEvent,
  isToolCallStartEvent,
  isToolCallDeltaEvent,
  isToolCallDoneEvent,
  isWebSearchEvent,
  isUsageEvent,
  isDoneEvent,
  isErrorEvent,
} from './streamEventSchema';

// Shared types
export {
  // Schemas
  WebSearchResultEntrySchema,
  // Types
  type WebSearchResultEntry,
  type NormalizerOptions,
  type NormalizedStream,
  type StreamNormalizer,
  type StreamConsumptionResult,
  // State types (for normalizer implementations)
  type AnthropicNormalizerState,
  type OpenAINormalizerState,
  type GoogleNormalizerState,
  type OpenAIResponseNormalizerState,
} from './types';

// Normalizers
export {
  normalizeAnthropicStream,
  type AnthropicMessageStream,
} from './normalizers/anthropicNormalizer';

export {
  normalizeOpenAIStream,
  normalizeOpenAIStreamWithCustomExtractor,
  defaultReasoningExtractor,
  type OpenAIChatCompletionStream,
  type ReasoningExtractor,
} from './normalizers/openaiNormalizer';

export {
  normalizeGoogleStream,
  type GoogleContentStream,
} from './normalizers/googleNormalizer';

export {
  normalizeOpenRouterStream,
  openRouterReasoningExtractor,
} from './normalizers/openrouterNormalizer';

export {
  normalizeOpenAIResponseStream,
  type OpenAIResponseStream,
} from './normalizers/openaiResponseNormalizer';

// Reasoning extractors for OpenAI-compatible providers
export {
  kimiReasoningExtractor,
  deepSeekReasoningExtractor,
} from './normalizers/reasoningExtractors';

// Direct streaming (bypasses EventBus)
export {
  DirectStreamPoster,
  type StreamPoster,
  type WebviewMessagePoster,
} from './DirectStreamPoster';

export { streamPosterRegistry } from './StreamPosterRegistry';
