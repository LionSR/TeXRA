import { normalizeLineEndings } from '@utils/text/stringUtils';

const FENCE = '---';

export type FrontmatterFenceSplit =
  | { kind: 'ok'; frontmatterText: string; body: string }
  | { kind: 'no-opening-fence' }
  | { kind: 'no-closing-fence' };

/**
 * Split a `---`-delimited frontmatter block off the front of file content.
 * Both delimiters must be `---` on their own line; line endings are
 * normalized first so a CRLF-edited file still matches. Callers decide how
 * to react to each failure kind and whether to trim the returned body.
 */
export function splitFrontmatterFence(content: string): FrontmatterFenceSplit {
  const lines = normalizeLineEndings(content).split('\n');
  if (lines[0] !== FENCE) {
    return { kind: 'no-opening-fence' };
  }

  const closeIndex = lines.indexOf(FENCE, 1);
  if (closeIndex < 0) {
    return { kind: 'no-closing-fence' };
  }

  return {
    kind: 'ok',
    frontmatterText: lines.slice(1, closeIndex).join('\n'),
    body: lines.slice(closeIndex + 1).join('\n'),
  };
}
