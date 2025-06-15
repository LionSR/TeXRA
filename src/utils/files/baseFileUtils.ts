/**
 * Utilities for determining effective base files for comparisons and operations.
 */

/**
 * Get the effective base file for comparison operations.
 * Returns the explicit base file if available, otherwise falls back to the original
 * file if it differs from the current file.
 *
 * @param base - The explicit base file path (may be null)
 * @param original - The original source file path (may be null)
 * @param current - The current generated file path
 * @returns The effective base file path or null if no suitable base exists
 */
export function getEffectiveBaseFile(
  base: string | null | undefined,
  original: string | null | undefined,
  current: string,
): string | null {
  // Use explicit base if available
  if (base) {
    return base;
  }

  // Use original as base if it exists and differs from current
  if (original && original !== current) {
    return original;
  }

  return null;
}
