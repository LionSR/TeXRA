// Unified-diff renderer for edit-approval modals + tool cards.
//
// Phase 2 produces line-by-line `diff` hunks coloured with ink Text
// (green added / red removed / dim context). `cli-highlight`-based syntax
// highlighting is wired in alongside markdown rendering in Phase 3.

import { Box, Text } from 'ink';
import { structuredPatch, type StructuredPatchHunk } from 'diff';

import { wrapAnsiToWidth } from './ansiWrap';

export type Hunk = StructuredPatchHunk;

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly hunks: number;
}

const NO_NEWLINE_MARKER = '\\';
const MIN_DIFF_WIDTH = 20;
const DEFAULT_DIFF_WIDTH = 74;

/** Compute hunks once; callers reuse for both stats and the renderer. */
export function buildHunks(
  fileLabel: string,
  original: string,
  proposed: string,
): Hunk[] {
  return structuredPatch(fileLabel, fileLabel, original, proposed, '', '', {
    context: 3,
  }).hunks;
}

export function statsFromHunks(hunks: readonly Hunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const first = line[0];
      if (first === '+') added += 1;
      else if (first === '-') removed += 1;
    }
  }
  return { added, removed, hunks: hunks.length };
}

export interface DiffViewProps {
  readonly hunks: readonly Hunk[];
  /** Maximum context lines per hunk before truncating; 0 = no truncation. */
  readonly maxHunkLines?: number;
  readonly width?: number;
}

export function DiffView(props: DiffViewProps): React.JSX.Element {
  const max = props.maxHunkLines ?? 0;
  const width = Math.max(MIN_DIFF_WIDTH, props.width ?? DEFAULT_DIFF_WIDTH);

  return (
    <Box flexDirection="column">
      {props.hunks.map((hunk, hi) => {
        // `\ No newline at end of file` is a synthetic marker; not part of
        // the actual diff content.
        const lines = hunk.lines.filter(
          (line) => !line.startsWith(NO_NEWLINE_MARKER),
        );
        const visible = max > 0 ? lines.slice(0, max) : lines;
        const remaining = max > 0 ? lines.length - max : 0;
        const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        return (
          <Box key={`${hi}-${hunk.oldStart}`} flexDirection="column">
            <Text dimColor>{wrapAnsiToWidth(hunkHeader, width)}</Text>
            {visible.map((line, li) => (
              <DiffLine key={li} line={line} width={width} />
            ))}
            {remaining > 0 ? (
              <Text dimColor>… {remaining} more lines</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function DiffLine({
  line,
  width,
}: {
  readonly line: string;
  readonly width: number;
}): React.JSX.Element {
  const wrapped = wrapAnsiToWidth(line, width);
  const marker = line[0];
  if (marker === '+') return <Text color="green">{wrapped}</Text>;
  if (marker === '-') return <Text color="red">{wrapped}</Text>;
  return <Text dimColor>{wrapped}</Text>;
}
