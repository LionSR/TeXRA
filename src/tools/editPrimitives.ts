// Local imports - tools
import { ToolError } from '@shared/schemas/toolResult';

/**
 * Shared literal string-edit primitives for the file-editing tools
 * (TextEditorTool, EditFileTool, MemoryTool).
 *
 * These deliberately avoid `String.prototype.replace`: its replacement string
 * interprets the special patterns `$$`, `$&`, `` $` ``, `$'`, and `$<name>`,
 * which silently corrupt any `new_str` that legitimately contains `$` — a
 * routine occurrence in LaTeX and code. Replacing via `indexOf`/`slice` (or
 * `split`/`join`) inserts the replacement verbatim.
 */

/**
 * Replace the first literal occurrence of `oldStr` with `newStr`.
 *
 * `newStr` is inserted verbatim — replacement patterns are NOT interpreted.
 * Returns the content unchanged when `oldStr` does not occur; callers that
 * require a match should validate occurrences first (see {@link countOccurrences}).
 */
export function replaceFirstLiteral(
  content: string,
  oldStr: string,
  newStr: string,
): string {
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    return content;
  }
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

/**
 * Replace every literal occurrence of `oldStr` with `newStr`.
 *
 * `newStr` is inserted verbatim — replacement patterns are NOT interpreted.
 * `oldStr` must be non-empty; an empty needle throws to avoid the pathological
 * `''.split('')` behavior.
 */
export function replaceAllLiteral(
  content: string,
  oldStr: string,
  newStr: string,
): string {
  if (oldStr.length === 0) {
    throw new ToolError(
      'replaceAllLiteral requires a non-empty search string.',
    );
  }
  return content.split(oldStr).join(newStr);
}

/**
 * 1-indexed line numbers of every line that contains `needle`. Used to build
 * the "not unique — found in lines X, Y" guidance when a search string matches
 * more than once.
 */
export function findOccurrenceLineNumbers(
  content: string,
  needle: string,
): number[] {
  return content
    .split('\n')
    .flatMap((line, index) => (line.includes(needle) ? [index + 1] : []));
}
