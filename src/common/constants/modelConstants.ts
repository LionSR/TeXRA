/**
 * Model handler configuration constants.
 *
 * Single source of truth for API beta versions, token limits,
 * and model-specific configuration across model handlers.
 */

import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';

// =============================================================================
// Anthropic API Beta Versions
// =============================================================================

/** Beta flag for 1M context window support */
export const ANTHROPIC_CONTEXT_1M_BETA: AnthropicBeta = 'context-1m-2025-08-07';

/** Beta flag for files API support */
export const ANTHROPIC_FILES_API_BETA: AnthropicBeta = 'files-api-2025-04-14';

/** Beta flag for Sonnet 3.7 128k output support */
export const ANTHROPIC_SONNET_37_OUTPUT_BETA: AnthropicBeta =
  'output-128k-2025-02-19';

/** Beta flag for interleaved thinking support */
export const ANTHROPIC_INTERLEAVED_THINKING_BETA: AnthropicBeta =
  'interleaved-thinking-2025-05-14';

/** Beta flag for context management support */
export const ANTHROPIC_CONTEXT_MANAGEMENT_BETA: AnthropicBeta =
  'context-management-2025-06-27';

// =============================================================================
// Token Limits and Context Windows
// =============================================================================

/** Anthropic 1M context window size */
export const ANTHROPIC_1M_CONTEXT_WINDOW = 1_000_000;

/** Maximum blocks that can have cache control applied */
export const ANTHROPIC_MAX_CACHE_CONTROLLED_BLOCKS = 4;

/** DeepSeek official API maximum output tokens */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 8192;

// =============================================================================
// Default Model Handler Limits
// =============================================================================

/** Default maximum continuation rounds */
export const DEFAULT_CONTINUE_LIMIT = 10;

/** Default input token limit */
export const DEFAULT_INPUT_TOKEN_LIMIT = 1_500_000;

/** Factor applied to context window to determine max output tokens */
export const DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

// =============================================================================
// Token Buffer and Calculation Constants
// =============================================================================

/** Buffer reserved for token calculations */
export const MODEL_TOKEN_BUFFER = 5000;

/** Minimum tokens reserved for completion */
export const MODEL_MIN_COMPLETION_TOKENS = 100;

/** Factor applied for thinking budget calculations (50% of max output) */
export const THINKING_BUDGET_FACTOR = 0.5;

/** Default thinking budget for streaming requests */
export const THINKING_BUDGET_STREAMING = 32768;

/** Default thinking budget for non-streaming requests */
export const THINKING_BUDGET_NON_STREAMING = 4096;

/** Multiplier applied for cache creation cost calculations */
export const CACHE_CREATION_COST_MULTIPLIER = 1.25;
