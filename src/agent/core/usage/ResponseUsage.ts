// Third-party imports
import type { Usage as AnthropicUsage } from '@anthropic-ai/sdk/resources/messages';
import type { Interactions } from '@google/genai';
import type { CompletionUsage } from 'openai/resources/completions';
import type { ResponseUsage as OpenAIResponseUsage } from 'openai/resources/responses/responses';
import type { ChatUsage as OpenRouterChatUsage } from '@openrouter/sdk/models';

/**
 * Extended OpenAI usage type with additional fields used by various providers.
 *
 * This interface extends the `CompletionUsage` type from the OpenAI SDK to include
 * additional metrics required by DeepSeek and other providers.
 *
 * Fields:
 * - `prompt_cache_hit_tokens` (optional): Represents the number of tokens retrieved
 *   from the prompt cache during a completion request. This is specific to DeepSeek's
 *   caching mechanism, which aims to optimize performance by reusing previously
 *   processed prompts. A higher value indicates greater cache utilization.
 * - `prompt_cache_miss_tokens` (optional): Represents the number of prompt tokens
 *   that missed DeepSeek's prompt cache and are billed at the full input rate.
 */
export interface ExtendedCompletionUsage extends CompletionUsage {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/**
 * Union of native usage payloads from different providers.
 * This is the raw usage object returned by each provider's API.
 *
 * - ExtendedCompletionUsage: OpenAI Chat Completions API (includes DeepSeek extension)
 * - OpenAIResponseUsage: OpenAI Responses API
 * - AnthropicUsage: Anthropic Messages API
 * - Interactions.Usage: Google Gemini API
 */
type NativeUsagePayload =
  | ExtendedCompletionUsage
  | OpenAIResponseUsage
  | AnthropicUsage
  | Interactions.Usage
  | OpenRouterChatUsage;

/**
 * Provider usage type for API responses.
 * Same as NativeUsagePayload but allows null/undefined for cases where
 * the provider doesn't return usage data.
 */
export type ProviderUsage = NativeUsagePayload | null | undefined;
