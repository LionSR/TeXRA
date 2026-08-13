import { structuredPatch, type StructuredPatchHunk } from 'diff';

/** Compute unified-diff hunks once for both text and Ink renderers. */
export function buildHunks(
  fileLabel: string,
  original: string,
  proposed: string,
): StructuredPatchHunk[] {
  return structuredPatch(fileLabel, fileLabel, original, proposed, '', '', {
    context: 3,
  }).hunks;
}

/** Render a unified-diff hunk header without redundant `,1` ranges. */
export function formatHunkHeader(hunk: StructuredPatchHunk): string {
  const range = (start: number, lines: number) =>
    lines === 1 ? String(start) : `${start},${lines}`;
  return `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`;
}
