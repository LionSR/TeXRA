// Third-party imports
import { structuredPatch, type StructuredPatchHunk } from 'diff';

// Local imports - common
import { createLog } from '@logger/logUtils';

const log = createLog('unifiedDiff');

/** Unchanged lines kept on each side of a change, matching `diff -u`. */
const DIFF_CONTEXT_LINES = 3;

/**
 * Upper bound on a single diff computation.
 *
 * jsdiff has no default bound, so without this a pathological pair of large,
 * wholly-dissimilar documents could occupy the event loop indefinitely.
 */
const DIFF_TIMEOUT_MS = 5000;

/** Split text into lines, dropping the empty entry after a trailing newline. */
function toLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/**
 * Unified-diff hunks between two texts — the one diff engine behind every
 * count, every rendered diff body, and every patch note in the product.
 *
 * On timeout this reports a whole-file replacement rather than an empty diff:
 * "everything changed" is a true (if verbose) description of the edit, while
 * an empty hunk list would read as "nothing changed". The `warn` names the
 * cause so a degraded diff is never silent.
 */
export function buildDiffHunks(
  oldText: string,
  newText: string,
): StructuredPatchHunk[] {
  // The file names only appear in the `---`/`+++` header, which callers that
  // want one build themselves from a path they already hold.
  const patch = structuredPatch('a', 'b', oldText, newText, '', '', {
    context: DIFF_CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (patch) return patch.hunks;

  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  log.warn(
    `Diff exceeded ${DIFF_TIMEOUT_MS}ms ` +
      `(${oldLines.length} → ${newLines.length} lines); ` +
      `reporting it as a whole-file replacement.`,
  );
  return [
    {
      oldStart: 1,
      oldLines: oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ],
    },
  ];
}

/**
 * The one hunk-header policy. `,1` ranges are omitted, the form `diff -u` and
 * `git diff` emit.
 */
export function formatHunkHeader(hunk: StructuredPatchHunk): string {
  const range = (start: number, lines: number) =>
    lines === 1 ? String(start) : `${start},${lines}`;
  return `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`;
}

/** Hunks as unified-diff text lines, each hunk preceded by its header. */
export function formatHunkLines(
  hunks: readonly StructuredPatchHunk[],
): string[] {
  return hunks.flatMap((hunk) => [formatHunkHeader(hunk), ...hunk.lines]);
}

/**
 * Unified-diff body between two texts, or undefined when they are identical.
 *
 * Carries no `---`/`+++` file header: every consumer already names the file in
 * its own surrounding prose.
 */
export function unifiedDiffText(
  oldText: string,
  newText: string,
): string | undefined {
  if (oldText === newText) return undefined;
  const hunks = buildDiffHunks(oldText, newText);
  return hunks.length > 0 ? formatHunkLines(hunks).join('\n') : undefined;
}
