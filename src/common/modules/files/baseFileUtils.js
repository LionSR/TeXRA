/**
 * Determine the effective base file for diff/compare operations.
 * Prefers the explicit base path when present and otherwise falls back
 * to the original path when it differs from the current file.
 *
 * @param {string|null|undefined} base - Explicit base file path, if provided.
 * @param {string|null|undefined} original - Original source path for the file.
 * @param {string} current - Current generated file path.
 * @returns {string|null} Effective base path or null when none applies.
 */
export function getEffectiveBaseFile(base, original, current) {
  if (base) {
    return base;
  }

  if (original && original !== current) {
    return original;
  }

  return null;
}
