/**
 * Normalize a file path to forward slashes for consistent comparisons.
 */
export function normalizeFilePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

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

  const normalized = normalizeFilePath(filePath);
  const cleaned = normalized.replace(/\/+$/, '') || '/';

  if (cleaned === '/') return '';

  return cleaned.split('/').at(-1) ?? '';
}

/**
 * Basename without its final extension (`'paper'` for `'dir/paper.tex'`).
 * Dotfiles keep their name (`'.gitignore'` → `'.gitignore'`).
 */
export function getFileStem(filePath: string | undefined | null): string {
  const fileName = getBasename(filePath);
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}
