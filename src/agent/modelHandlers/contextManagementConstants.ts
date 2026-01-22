/**
 * Shared constants for context management across model handlers.
 * Single source of truth for compaction/truncation settings.
 */

/**
 * Default compaction threshold percentage.
 * When context utilization exceeds this percentage of the model's context window,
 * context management (compaction, truncation, or clearing) is triggered.
 *
 * This value must match the default in package.json for:
 * - texra.model.compactionThresholdPercent
 *
 * Set to 0 to disable context management entirely.
 */
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 75;

/**
 * Minimum completion tokens to ensure the model can produce output.
 * Used when reducing max tokens due to context pressure.
 */
export const MIN_COMPLETION_TOKENS = 100;

/**
 * Safety buffer subtracted from available tokens.
 * Used by handlers that perform exact token counting (Anthropic, Google).
 */
export const TOKEN_SAFETY_BUFFER = 10;

/**
 * Larger safety buffer for heuristic token counting (OpenAI).
 * Accounts for estimation uncertainty.
 */
export const HEURISTIC_TOKEN_BUFFER = 5000;

/**
 * Maximum character length for tool result text sent to models.
 * Tool results exceeding this limit return an error to prevent context window overflow.
 * Set to 200KB (200,000 characters) which is roughly 50,000-66,000 tokens depending on content.
 */
export const MAX_TOOL_RESULT_TEXT_LENGTH = 200_000;

/**
 * Compute reduced max tokens when context pressure requires adjustment.
 * Ensures minimum completion tokens while respecting available space.
 *
 * @param availableTokens - Tokens available for output (contextWindow - inputTokens)
 * @param tokenBuffer - Safety buffer to subtract (default: TOKEN_SAFETY_BUFFER)
 * @returns Reduced max tokens value (minimum 1)
 */
export function computeReducedMaxTokens(
  availableTokens: number,
  tokenBuffer: number = TOKEN_SAFETY_BUFFER,
): number {
  // If no space available, force to minimum (1 token)
  if (availableTokens <= 0) {
    return 1;
  }

  // Apply buffer and enforce minimum
  const buffered = availableTokens - tokenBuffer;

  // If buffered value is below minimum, use all available space (skip buffer)
  if (buffered < MIN_COMPLETION_TOKENS) {
    return Math.max(1, availableTokens);
  }

  return Math.max(MIN_COMPLETION_TOKENS, buffered);
}
