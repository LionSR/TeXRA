/**
 * Extract the base name (filename) from a file path.
 * Handles platform-specific separators (\ on Windows, / on Unix).
 *
 * @param {string} filePath - Path to evaluate (can be absolute or relative)
 * @returns {string} Base name of the file/directory
 * @example
 * getBasename('/home/user/document.pdf') // returns 'document.pdf'
 * getBasename('C:\\Users\\file.txt')     // returns 'file.txt'
 * getBasename('/path/to/')               // returns 'to'
 * getBasename('/')                       // returns ''
 */
export function getBasename(filePath) {
  if (!filePath) return '';

  // Normalize path separators to forward slashes
  const normalized = filePath.replace(/\\/g, '/');

  // Remove trailing slashes except for root
  const cleaned = normalized.replace(/\/+$/, '') || '/';

  // Handle root path
  if (cleaned === '/') return '';

  // Split and get last part
  const parts = cleaned.split('/');
  return parts.at(-1) || '';
}
