// Third-party imports
import type { Usage as AnthropicUsage } from '@anthropic-ai/sdk/resources/messages';
import type { Interactions } from '@google/genai';
import type { CompletionUsage } from 'openai/resources/completions';
import type { ResponseUsage as OpenAIResponseUsage } from 'openai/resources/responses/responses';
import type { ChatUsage as OpenRouterChatUsage } from '@openrouter/sdk/models';

/**
 * Raw provider wire-format usage types. Lives beside {@link ModelHandlerContracts}
 * (not in `core/usage/`) because it's the same kind of thing as the tool-call
 * SDK types there: a plain data contract between `ModelHandler`/`IModelHandler`
 * and each provider's SDK, not a normalized domain value.
 *
 * Raw usage no longer crosses into core flows. `ModelHandler` normalizes the
 * primary response path, while helper-model integrations may still pass it
 * through their own boundary. `core/usage/` (the value-object layer:
 * `RunUsageAccumulator`) sees only `NormalizedUsage`.
 */

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
 * Provider usage type for API responses.
 * Union of native usage payloads from different providers, allowing
 * null/undefined when the provider doesn't return usage data.
 */
export type ProviderUsage =
  | ExtendedCompletionUsage
  | OpenAIResponseUsage
  | AnthropicUsage
  | Interactions.Usage
  | OpenRouterChatUsage
  | null
  | undefined;
