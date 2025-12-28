/**
 * Custom reasoning extractors for OpenAI-compatible providers.
 *
 * These extractors are used with normalizeOpenAIStreamWithCustomExtractor()
 * to handle provider-specific reasoning content formats.
 *
 * The default extractor handles `reasoning_content` field (OpenAI o1, DeepSeek).
 * Additional extractors are provided for providers with different formats.
 */

import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

import type { ReasoningExtractor } from './openaiNormalizer';

/**
 * Extended delta type with reasoning fields.
 */
interface ReasoningDelta {
  content?: string | null;
  reasoning_content?: string | Array<{ type: string; text?: string }>;
}

/**
 * Extract reasoning text from reasoning_content field.
 * Handles both string and array formats.
 */
function extractReasoningText(
  content: ReasoningDelta['reasoning_content'],
): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((item) => item.text ?? '').join('');
}

/**
 * Default reasoning extractor for OpenAI o1 and DeepSeek models.
 * Extracts from the `reasoning_content` field.
 */
export const defaultReasoningExtractor: ReasoningExtractor = (
  chunk: ChatCompletionChunk,
): string => {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta as ReasoningDelta;
  if (!('reasoning_content' in delta)) return '';

  return extractReasoningText(delta.reasoning_content);
};

/**
 * Kimi reasoning extractor.
 * Kimi uses the same `reasoning_content` field as DeepSeek.
 */
export const kimiReasoningExtractor: ReasoningExtractor =
  defaultReasoningExtractor;

/**
 * DeepSeek reasoning extractor.
 * DeepSeek uses the `reasoning_content` field.
 */
export const deepSeekReasoningExtractor: ReasoningExtractor =
  defaultReasoningExtractor;

/**
 * OpenRouter reasoning_details array item types.
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
interface ReasoningDetailItem {
  type: 'reasoning.text' | 'reasoning.summary' | 'reasoning.encrypted';
  id?: string | null;
  format?: string;
  index?: number;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string | null;
}

/**
 * Extended delta type with OpenRouter reasoning fields.
 */
interface OpenRouterReasoningDelta {
  content?: string | null;
  reasoning_details?: ReasoningDetailItem[] | string;
  reasoning_content?: string;
}

/**
 * Extracts text content from OpenRouter reasoning_details array.
 */
function extractTextFromReasoningDetails(
  details: ReasoningDetailItem[] | unknown,
): string {
  if (!Array.isArray(details)) {
    if (typeof details === 'string') return details;
    return '';
  }

  const textParts: string[] = [];
  for (const item of details) {
    if (!item || typeof item !== 'object') continue;

    switch (item.type) {
      case 'reasoning.text':
        if (item.text) textParts.push(item.text);
        break;
      case 'reasoning.summary':
        if (item.summary) textParts.push(item.summary);
        break;
      case 'reasoning.encrypted':
        // Skip encrypted content
        break;
    }
  }

  return textParts.join('');
}

/**
 * OpenRouter reasoning extractor.
 * Handles both:
 * - reasoning_details: array of objects (OpenRouter normalized format)
 * - reasoning_content: string (native DeepSeek/other models via OpenRouter)
 */
export const openRouterReasoningExtractor: ReasoningExtractor = (
  chunk: ChatCompletionChunk,
): string => {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta as OpenRouterReasoningDelta;

  // Try reasoning_details first (OpenRouter normalized format)
  if ('reasoning_details' in delta && delta.reasoning_details) {
    return extractTextFromReasoningDetails(delta.reasoning_details);
  }

  // Fall back to reasoning_content (native format for some models)
  if ('reasoning_content' in delta && delta.reasoning_content) {
    return delta.reasoning_content;
  }

  return '';
};
