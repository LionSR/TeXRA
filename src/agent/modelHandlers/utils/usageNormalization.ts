/**
 * Shared utilities for normalizing usage statistics across model handlers.
 *
 * These helpers ensure consistent behavior across all providers while
 * respecting provider-specific token naming conventions (see handler
 * implementations for details on each provider's native format).
 */

/**
 * Calculate cache percentage from cached and total input tokens.
 * Returns undefined if no caching occurred (to avoid storing 0 values).
 *
 * @param cachedTokens - Number of tokens served from cache
 * @param totalInputTokens - Total input tokens (must be > 0)
 * @returns Percentage cached (0-100), or undefined if no caching
 */
export function computeCachePercentage(
  cachedTokens: number,
  totalInputTokens: number,
): number | undefined {
  if (totalInputTokens <= 0 || cachedTokens <= 0) return undefined;
  return (cachedTokens / totalInputTokens) * 100;
}

/**
 * Convert a numeric value to undefined if zero/falsy.
 * Used to avoid storing 0 values in optional fields.
 *
 * @param value - Numeric value to convert
 * @returns The value if truthy, undefined otherwise
 */
export function nonZeroOrUndefined(
  value: number | undefined,
): number | undefined {
  return value || undefined;
}
