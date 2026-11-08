/**
 * Browser-safe path basics on 'pathe', a dependency-free reimplementation of
 * node:path: this module is reached from browser code through
 * `@texra-ai/harness/schemas`. Real filesystem-path semantics (containment,
 * `.`/`..` resolution) are `@utils/core/pathCore`'s, which needs node:path.
 */
import { basename as pathBasename, extname as pathExtname } from 'pathe';

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
  return pathBasename(normalizeFilePath(filePath));
}

/**
 * Basename without its final extension (`'notes'` for `'dir/notes.md'`).
 * Dotfiles keep their name (`'.gitignore'` → `'.gitignore'`).
 */
export function getFileStem(filePath: string | undefined | null): string {
  const base = getBasename(filePath);
  // pathe's extname() misreads a dotfile's leading dot as an extension
  // marker once a directory prefix is present (e.g. '/home/user/.bashrc'),
  // even though it gets bare '.bashrc' right — so compute it against the
  // basename alone, never the full path.
  return pathBasename(base, pathExtname(base));
}
