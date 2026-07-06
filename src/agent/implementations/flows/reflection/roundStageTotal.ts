/**
 * Widen a round stage's `total` for a granted compile-repair round (#7077):
 * that round opens with `roundIndex === totalRounds` (one past the
 * configured last round), so without this the progress badge would render
 * an over-total "Round 3 of 2".
 */
export function computeRoundStageTotal(
  totalRounds: number,
  roundIndex: number,
): number {
  return Math.max(totalRounds, roundIndex + 1);
}
