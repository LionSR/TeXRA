/**
 * Clamp `value` to the inclusive range [`min`, `max`].
 * When `min > max` the lower bound wins and the result equals `min`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
