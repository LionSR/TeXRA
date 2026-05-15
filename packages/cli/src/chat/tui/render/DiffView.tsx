// Unified-diff renderer for edit-approval modals + tool cards.
//
// Phase 2 produces line-by-line `diff` hunks coloured with ink Text
// (green added / red removed / dim context). `cli-highlight`-based syntax
// highlighting is wired in alongside markdown rendering in Phase 3.

import { Box, Text } from 'ink';
import { structuredPatch, type StructuredPatchHunk } from 'diff';

type Hunk = StructuredPatchHunk;

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly hunks: number;
}

export interface DiffViewProps {
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly fileLabel: string;
  /** Maximum context lines per hunk before truncating; 0 = no truncation. */
  readonly maxHunkLines?: number;
}

const NO_NEWLINE_MARKER = '\\';

function buildHunks(
  fileLabel: string,
  original: string,
  proposed: string,
): Hunk[] {
  return structuredPatch(fileLabel, fileLabel, original, proposed, '', '', {
    context: 3,
  }).hunks;
}

function statsFromHunks(hunks: readonly Hunk[]): DiffStats {
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

export function diffStats(
  originalContent: string,
  proposedContent: string,
): DiffStats {
  return statsFromHunks(buildHunks('', originalContent, proposedContent));
}

export function DiffView(props: DiffViewProps): React.JSX.Element {
  const hunks = buildHunks(
    props.fileLabel,
    props.originalContent,
    props.proposedContent,
  );
  const max = props.maxHunkLines ?? 0;

  return (
    <Box flexDirection="column">
      {hunks.map((hunk, hi) => {
        // `\ No newline at end of file` is a synthetic marker; not part of
        // the actual diff content.
        const lines = hunk.lines.filter(
          (line) => !line.startsWith(NO_NEWLINE_MARKER),
        );
        const visible = max > 0 ? lines.slice(0, max) : lines;
        const remaining = max > 0 ? lines.length - max : 0;
        return (
          <Box key={`${hi}-${hunk.oldStart}`} flexDirection="column">
            <Text dimColor>
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
              {hunk.newLines} @@
            </Text>
            {visible.map((line, li) => (
              <DiffLine key={li} line={line} />
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

function DiffLine({ line }: { line: string }): React.JSX.Element {
  const marker = line[0];
  if (marker === '+') return <Text color="green">{line}</Text>;
  if (marker === '-') return <Text color="red">{line}</Text>;
  return <Text dimColor>{line}</Text>;
}
