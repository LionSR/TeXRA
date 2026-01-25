/**
 * Extract the base name (filename) from a file path.
 * Handles platform-specific separators (\ on Windows, / on Unix).
 *
 * @example
 * getBasename('/home/user/document.pdf') // returns 'document.pdf'
 * getBasename('C:\\Users\\file.txt')     // returns 'file.txt'
 * getBasename('/path/to/')               // returns 'to'
 * getBasename('/')                       // returns ''
 */
export function getBasename(filePath: string | undefined | null): string {
  if (!filePath) return '';

  // Normalize path separators to forward slashes
  const normalized = filePath.replace(/\\/g, '/');

  // Remove trailing slashes except for root
  const cleaned = normalized.replace(/\/+$/, '') || '/';

  // Handle root path
  if (cleaned === '/') return '';

  // Split and get last part
  const parts = cleaned.split('/');
  return parts.at(-1) ?? '';
}
