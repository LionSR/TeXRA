/**
 * OpenRouter stream normalizer.
 *
 * OpenRouter uses an OpenAI-compatible API with custom reasoning fields.
 * This normalizer reuses the OpenAI normalizer with a custom reasoning extractor.
 *
 * Key behaviors:
 * - Uses reasoning_details array (OpenRouter normalized format) or
 *   reasoning_content (native DeepSeek/other models)
 * - Otherwise identical to OpenAI streaming
 */

import type { StreamEvent } from '../streamEventSchema';
import type { NormalizerOptions } from '../types';
import {
  normalizeOpenAIStreamWithCustomExtractor,
  type OpenAIChatCompletionStream,
} from './openaiNormalizer';
import { openRouterReasoningExtractor } from './reasoningExtractors';

// Re-export the extractor for convenience
export { openRouterReasoningExtractor } from './reasoningExtractors';

/**
 * Normalize OpenRouter stream to unified events.
 *
 * Uses the OpenAI normalizer with OpenRouter's custom reasoning extractor.
 *
 * @param stream - OpenRouter chat completion stream (OpenAI-compatible)
 * @param options - Normalizer options
 * @returns Async generator of normalized stream events
 */
export async function* normalizeOpenRouterStream(
  stream: OpenAIChatCompletionStream,
  options: NormalizerOptions = {},
): AsyncGenerator<StreamEvent> {
  // Use OpenAI normalizer with OpenRouter's custom reasoning extractor
  // Override provider to 'openrouter' if not set
  const normalizedOptions: NormalizerOptions = {
    ...options,
    provider: options.provider ?? 'openrouter',
  };

  yield* normalizeOpenAIStreamWithCustomExtractor(
    stream,
    normalizedOptions,
    openRouterReasoningExtractor,
  );
}
