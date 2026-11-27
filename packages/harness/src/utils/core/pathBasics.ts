/**
 * Browser-safe path basics on 'pathe', a dependency-free reimplementation of
 * node:path: this module is reached from browser code through
 * `@texra-ai/worldline/schemas`. Real filesystem-path semantics (containment,
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
 * The file path a `file:` URL names, or `null` when `url` is not one or its
 * percent-escapes are malformed. A Windows drive path follows one extra
 * slash, and a network share's server is the host (`//server/share/x`);
 * `localhost` names this machine, as an empty host does.
 *
 * @example
 * filePathOfFileUrl('file:///home/a%20b.pdf')   // '/home/a b.pdf'
 * filePathOfFileUrl('file:///C:/Users/a.pdf')   // 'C:/Users/a.pdf'
 * filePathOfFileUrl('file://server/share/a')    // '//server/share/a'
 */
export function filePathOfFileUrl(url: string): string | null {
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== 'file:') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    // A malformed percent-escape names no file path.
    return null;
  }
  if (parsed.hostname && parsed.hostname !== 'localhost')
    return `//${parsed.hostname}${pathname}`;
  return pathname.replace(/^\/([A-Za-z]:)/, '$1');
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

/**
 * A path's extension in lowercase (`'.tex'` for `'Paper.TEX'`), read from its
 * base name so a dotfile (`'/home/user/.bashrc'`) has none.
 */
export function getExtensionLowercase(filePath: string): string {
  return pathExtname(getBasename(filePath)).toLowerCase();
}

/**
 * Whether a path has the given extension, ignoring case.
 *
 * @example
 * hasExtension('notes.md', '.md') // true
 * hasExtension('Notes.MD', '.md') // true
 * hasExtension('notes.pdf', '.md') // false
 */
export function hasExtension(filePath: string, extension: string): boolean {
  return getExtensionLowercase(filePath) === extension.toLowerCase();
}
