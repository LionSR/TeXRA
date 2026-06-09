/**
 * Clamp `value` to the inclusive range [`min`, `max`].
 * When `min > max` the lower bound wins and the result equals `min`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp `index` into `[0, length - 1]`.
 * Returns 0 when `length <= 0` so the result is always a valid array index.
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return clamp(index, 0, length - 1);
}
