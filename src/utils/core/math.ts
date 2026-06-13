/**
 * Clamp `value` to the inclusive range [`min`, `max`].
 * When `min > max` the lower bound wins and the result equals `min`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp `value` to optional bounds. Each bound is applied only when defined.
 * Equivalent to `clamp` when both are provided and `min <= max`; a no-op when neither is.
 */
export function clampOptional(
  value: number,
  min?: number,
  max?: number,
): number {
  let result = value;
  if (min != null) result = Math.max(min, result);
  if (max != null) result = Math.min(max, result);
  return result;
}

/**
 * Clamp `index` into `[0, length - 1]`.
 * Returns 0 when `length <= 0` so the result is always a valid array index.
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return clamp(index, 0, length - 1);
}

/**
 * Round `value` to `decimals` decimal places, returning a number.
 * Equivalent to `Number(value.toFixed(decimals))` but expresses intent clearly.
 */
export function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}
