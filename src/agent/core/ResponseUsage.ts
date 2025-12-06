// Third-party imports
import { z } from 'zod';
import type {
  Usage as AnthropicUsage,
  CacheCreation,
  ServerToolUsage,
} from '@anthropic-ai/sdk/resources/messages';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { CompletionUsage } from 'openai/resources/completions';
import type { ResponseUsage as OpenAIResponseUsage } from 'openai/resources/responses/responses';

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
 */
export interface ExtendedCompletionUsage extends CompletionUsage {
  prompt_cache_hit_tokens?: number;
}

/**
 * Union of native usage payloads from different providers.
 * This is the raw usage object returned by each provider's API.
 *
 * - ExtendedCompletionUsage: OpenAI Chat Completions API (includes DeepSeek extension)
 * - OpenAIResponseUsage: OpenAI Responses API
 * - AnthropicUsage: Anthropic Messages API
 * - GenerateContentResponseUsageMetadata: Google Gemini API
 */
export type NativeUsagePayload =
  | ExtendedCompletionUsage
  | OpenAIResponseUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

/**
 * Provider usage type for API responses.
 * Same as NativeUsagePayload but allows null/undefined for cases where
 * the provider doesn't return usage data.
 */
export type ProviderUsage = NativeUsagePayload | null | undefined;

// Re-export SDK types for use in model handlers
export type {
  CompletionUsage,
  AnthropicUsage,
  CacheCreation,
  ServerToolUsage,
  GenerateContentResponseUsageMetadata,
  OpenAIResponseUsage,
};

/** Base interface for common response usage metrics across all model providers. */
export interface ResponseUsageBase {
  totalInputTokens: number;
  totalOutputTokens: number;
  percentageCached: number;
  cost: number;
  responseTime: number;
}

/** OpenAI-specific response usage metrics with detailed token breakdowns. */
export interface OpenAIAPIResponseUsage extends ResponseUsageBase {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  accepted_prediction_tokens: number | null;
  rejected_prediction_tokens: number | null;
  // Some providers expose tool-use tokens via the OpenAI-compatible interface.
  tool_use_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number | null;
    rejected_prediction_tokens?: number | null;
  };
}

/** Anthropic-specific response usage metrics with cache statistics. */
export interface AnthropicAPIResponseUsage extends ResponseUsageBase {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  /** Breakdown of cache creation tokens by TTL (5m vs 1h) */
  cache_creation: CacheCreation | null;
  /** Server tool usage statistics (e.g., web search requests) */
  server_tool_use: ServerToolUsage | null;
  /** Service tier used for the request (standard, priority, or batch) */
  service_tier: 'standard' | 'priority' | 'batch' | null;
  // Optional field surfaced by compatibility layers that expose tool-use costs.
  tool_use_tokens?: number;
}

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/** Schema for base response usage metrics. */
export const ResponseUsageBaseSchema = z.object({
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  percentageCached: z.number(),
  cost: z.number(),
  responseTime: z.number(),
});

/** Schema for prompt token details (OpenAI). */
const PromptTokensDetailsSchema = z
  .object({
    cached_tokens: z.number().optional(),
  })
  .passthrough()
  .optional();

/** Schema for completion token details (OpenAI). */
const CompletionTokensDetailsSchema = z
  .object({
    reasoning_tokens: z.number().optional(),
    accepted_prediction_tokens: z.number().nullable().optional(),
    rejected_prediction_tokens: z.number().nullable().optional(),
  })
  .passthrough()
  .optional();

/** Schema for cache creation (Anthropic). */
const CacheCreationSchema = z
  .object({
    ephemeral_1m_input_tokens: z.number().optional(),
    ephemeral_5m_input_tokens: z.number().optional(),
  })
  .passthrough()
  .nullable();

/** Schema for server tool usage (Anthropic). */
const ServerToolUsageSchema = z
  .object({
    web_search_requests: z.number().optional(),
  })
  .passthrough()
  .nullable();

/**
 * Schema for UsageSummary (legacy format).
 * Uses type guards for validation to match the interface types exactly.
 * More permissive than strict schema validation for backward compatibility.
 */
export const UsageSummarySchema = z.custom<
  OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null
>(
  (value): value is OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | null => {
    if (value === null) return true;
    if (typeof value !== 'object') return false;
    // Check for discriminating fields
    const obj = value as Record<string, unknown>;
    // OpenAI format has prompt_tokens
    if ('prompt_tokens' in obj && typeof obj.prompt_tokens === 'number') {
      return true;
    }
    // Anthropic format has input_tokens
    if ('input_tokens' in obj && typeof obj.input_tokens === 'number') {
      return true;
    }
    return false;
  },
  {
    message: 'Invalid UsageSummary format: expected OpenAI or Anthropic usage object or null',
  },
);

/**
 * Type guard to check if usage is OpenAI format.
 */
export function isOpenAIUsageFormat(
  usage: unknown,
): usage is OpenAIAPIResponseUsage {
  return (
    typeof usage === 'object' &&
    usage !== null &&
    'prompt_tokens' in usage &&
    typeof (usage as Record<string, unknown>).prompt_tokens === 'number'
  );
}

/**
 * Type guard to check if usage is Anthropic format.
 */
export function isAnthropicUsageFormat(
  usage: unknown,
): usage is AnthropicAPIResponseUsage {
  return (
    typeof usage === 'object' &&
    usage !== null &&
    'input_tokens' in usage &&
    typeof (usage as Record<string, unknown>).input_tokens === 'number'
  );
}

// ----------------------------------------------------------------------------
// Native Usage Payload Schemas (raw API responses)
// ----------------------------------------------------------------------------

/**
 * Schema for NativeUsagePayload union.
 * Uses type guard validation to match the interface types exactly.
 * More permissive than strict schema validation for backward compatibility.
 */
export const NativeUsagePayloadSchema = z.custom<NativeUsagePayload>(
  (value): value is NativeUsagePayload => {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;

    // OpenAI Chat Completions (has prompt_tokens and completion_tokens)
    if (
      'prompt_tokens' in obj &&
      typeof obj.prompt_tokens === 'number' &&
      'completion_tokens' in obj &&
      typeof obj.completion_tokens === 'number'
    ) {
      return true;
    }

    // OpenAI Responses API or Anthropic (has input_tokens and output_tokens)
    if (
      'input_tokens' in obj &&
      typeof obj.input_tokens === 'number' &&
      'output_tokens' in obj &&
      typeof obj.output_tokens === 'number'
    ) {
      return true;
    }

    // Google Gemini (has promptTokenCount or candidatesTokenCount)
    if (
      ('promptTokenCount' in obj && typeof obj.promptTokenCount === 'number') ||
      ('candidatesTokenCount' in obj &&
        typeof obj.candidatesTokenCount === 'number') ||
      ('totalTokenCount' in obj && typeof obj.totalTokenCount === 'number')
    ) {
      return true;
    }

    return false;
  },
  {
    message:
      'Invalid NativeUsagePayload format: expected usage object from OpenAI, Anthropic, or Google',
  },
);

/**
 * Identifies which provider a native usage payload belongs to.
 */
export function identifyNativeUsageProvider(
  usage: unknown,
): 'openai-chat' | 'openai-response' | 'anthropic' | 'google' | null {
  if (typeof usage !== 'object' || usage === null) return null;

  const obj = usage as Record<string, unknown>;

  // Check for Google (has promptTokenCount)
  if ('promptTokenCount' in obj || 'candidatesTokenCount' in obj) {
    return 'google';
  }

  // Check for OpenAI Responses API (has input_tokens but no prompt_tokens)
  if (
    'input_tokens' in obj &&
    'output_tokens' in obj &&
    !('prompt_tokens' in obj) &&
    !('cache_read_input_tokens' in obj)
  ) {
    return 'openai-response';
  }

  // Check for Anthropic (has input_tokens and potentially cache fields)
  if ('input_tokens' in obj && 'output_tokens' in obj) {
    return 'anthropic';
  }

  // Check for OpenAI Chat (has prompt_tokens and completion_tokens)
  if ('prompt_tokens' in obj && 'completion_tokens' in obj) {
    return 'openai-chat';
  }

  return null;
}
