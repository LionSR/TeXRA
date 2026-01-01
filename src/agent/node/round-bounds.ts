/**
 * Round bounds checking - single source of truth.
 */

/**
 * Check if a round index is at or beyond the limit.
 *
 * @param roundIndex - Round index to check (0-based)
 * @param totalRounds - Total rounds configured
 * @returns true if roundIndex >= totalRounds (out of bounds)
 */
export function isRoundAtOrBeyondLimit(
  roundIndex: number,
  totalRounds: number,
): boolean {
  return roundIndex >= totalRounds;
}
