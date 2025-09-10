/**
 * Get the base name of a path across platforms.
 * @param {string} filePath - Path to evaluate
 * @returns {string} Basename of the provided path
 */
export function getBasename(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.pop() || '';
}
