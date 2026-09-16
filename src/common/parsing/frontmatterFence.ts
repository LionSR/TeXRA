import { normalizeLineEndings } from '@utils/text/stringUtils';

// Matches a line that is exactly `---`, tolerant of a trailing `\r` so a
// CRLF-edited file still fences correctly. `$` in multiline mode also
// matches end-of-string, so a fence line need not be newline-terminated.
const FENCE_LINE_RE = () => /^---\r?(?:\n|$)/gm;

export type FrontmatterFenceSplit =
  | { kind: 'ok'; frontmatterText: string; body: string }
  | { kind: 'no-opening-fence' }
  | { kind: 'no-closing-fence' };

/**
 * Split a `---`-delimited frontmatter block off the front of file content.
 * Both delimiters must be `---` on their own line. Only fence-line matching
 * and the returned `frontmatterText` are line-ending-normalized; `body` is a
 * raw substring of the original content, so its bytes (including any CRLF)
 * round-trip unchanged for callers that write it back to disk.
 */
export function splitFrontmatterFence(content: string): FrontmatterFenceSplit {
  const fenceLineRe = FENCE_LINE_RE();
  const opening = fenceLineRe.exec(content);
  if (!opening || opening.index !== 0) {
    return { kind: 'no-opening-fence' };
  }

  fenceLineRe.lastIndex = opening[0].length;
  const closing = fenceLineRe.exec(content);
  if (!closing) {
    return { kind: 'no-closing-fence' };
  }

  return {
    kind: 'ok',
    frontmatterText: normalizeLineEndings(
      content.slice(opening[0].length, closing.index),
    ),
    body: content.slice(closing.index + closing[0].length),
  };
}
