/**
 * Unified streaming module for model handlers.
 *
 * This module provides a consistent streaming abstraction across all providers:
 * - Normalized event types (StreamEvent)
 * - Provider-specific normalizers
 * - Shared stream consumer
 *
 * Usage:
 * ```typescript
 * import { StreamConsumer, StreamEvent } from '@agent/modelHandlers/streaming';
 *
 * // In a model handler:
 * const consumer = new StreamConsumer(this.logger, options);
 * const response = await consumer.consume(normalizedStream);
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
  type StreamConsumerOptions,
  type NormalizedStream,
  type StreamNormalizer,
  type StreamFactory,
  type StreamConsumptionResult,
  // State types (for normalizer implementations)
  type AnthropicNormalizerState,
  type OpenAINormalizerState,
  type GoogleNormalizerState,
  type OpenAIResponseNormalizerState,
} from './types';

// StreamConsumer
export { StreamConsumer } from './StreamConsumer';

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

// TODO: Implement remaining normalizers
// export { normalizeGoogleStream } from './normalizers/googleNormalizer';
// export { normalizeOpenAIResponseStream } from './normalizers/openaiResponseNormalizer';
// export { normalizeOpenRouterStream } from './normalizers/openrouterNormalizer';
