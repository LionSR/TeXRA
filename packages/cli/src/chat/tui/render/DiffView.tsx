// Unified-diff renderer for edit-approval modals + tool cards.
//
// Phase 2 produces line-by-line `diff` hunks and colors them with picocolors
// (green added / red removed / dim context). `cli-highlight`-based syntax
// highlighting is wired in alongside markdown rendering in Phase 3.

import { Box, Text } from 'ink';
import { createPatch, structuredPatch } from 'diff';

export interface DiffViewProps {
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly fileLabel: string;
  /** Maximum context lines per hunk before truncating; 0 = no truncation. */
  readonly maxHunkLines?: number;
}

export function DiffView(props: DiffViewProps): React.JSX.Element {
  const patch = structuredPatch(
    props.fileLabel,
    props.fileLabel,
    props.originalContent,
    props.proposedContent,
    '',
    '',
    { context: 3 },
  );
  const max = props.maxHunkLines ?? 0;

  return (
    <Box flexDirection="column">
      {patch.hunks.map((hunk, hi) => {
        const lines = max > 0 ? hunk.lines.slice(0, max) : hunk.lines;
        const truncated = max > 0 && hunk.lines.length > max;
        return (
          <Box key={`${hi}-${hunk.oldStart}`} flexDirection="column">
            <Text dimColor>
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
              {hunk.newLines} @@
            </Text>
            {lines.map((line, li) => (
              <DiffLine key={li} line={line} />
            ))}
            {truncated ? (
              <Text dimColor>
                … {hunk.lines.length - max} more lines (Ctrl-O to expand)
              </Text>
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

/** Quick stats summary (e.g. `+12 / −7 · 3 hunks`) for embedded chrome. */
export function diffStats(
  originalContent: string,
  proposedContent: string,
): { added: number; removed: number; hunks: number } {
  const patch = createPatch('', originalContent, proposedContent);
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) hunks += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed, hunks };
}
