// Unified-diff renderer for edit-approval modals + tool cards.
//
// Phase 2 produces line-by-line `diff` hunks coloured with ink Text
// (green added / red removed / dim context). `cli-highlight`-based syntax
// highlighting is wired in alongside markdown rendering in Phase 3.

import { Box, Text } from 'ink';
import { structuredPatch, type StructuredPatchHunk } from 'diff';

import { wrapAnsiToWidth } from './ansiWrap';

export type Hunk = StructuredPatchHunk;

export interface InlinePatchGroup {
  readonly fileLabel: string;
  readonly hunks: readonly Hunk[];
}

export interface DiffDisplayLine {
  readonly kind: 'added' | 'context' | 'header' | 'removed' | 'overflow';
  readonly text: string;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function editCandidate(
  input: unknown,
  fallbackFileLabel: string,
):
  | {
      readonly fileLabel: string;
      readonly oldText: string;
      readonly newText: string;
    }
  | undefined {
  if (!isRecord(input)) return undefined;
  const oldText = stringField(input, ['old_string', 'old_str']);
  const newText = stringField(input, ['new_string', 'new_str']);
  if (oldText === undefined || newText === undefined) return undefined;
  return {
    fileLabel: stringField(input, ['path', 'file_path']) ?? fallbackFileLabel,
    oldText,
    newText,
  };
}

export function editPatchHunks(input: unknown): readonly Hunk[] | undefined {
  const candidate = editCandidate(input, 'edit');
  if (!candidate) return undefined;
  const hunks = buildHunks(
    candidate.fileLabel,
    candidate.oldText,
    candidate.newText,
  );
  return hunks.length > 0 ? hunks : undefined;
}

export function editPatchGroups(
  input: unknown,
): readonly InlinePatchGroup[] | undefined {
  if (!isRecord(input)) return undefined;
  const fileLabel = stringField(input, ['path', 'file_path']) ?? 'edit';
  const edits = input.edits;
  const candidates = Array.isArray(edits)
    ? edits.map((edit) => editCandidate(edit, fileLabel))
    : [editCandidate(input, fileLabel)];

  const groups = candidates.flatMap((candidate) => {
    if (!candidate) return [];
    const hunks = buildHunks(
      candidate.fileLabel,
      candidate.oldText,
      candidate.newText,
    );
    return hunks.length > 0 ? [{ fileLabel: candidate.fileLabel, hunks }] : [];
  });
  return groups.length > 0 ? groups : undefined;
}

export function diffDisplayLines(
  hunks: readonly Hunk[],
  maxHunkLines = 0,
): DiffDisplayLine[] {
  return hunks.flatMap((hunk) => {
    const lines = hunk.lines.filter(
      (line) => !line.startsWith(NO_NEWLINE_MARKER),
    );
    const visible = maxHunkLines > 0 ? lines.slice(0, maxHunkLines) : lines;
    const remaining = maxHunkLines > 0 ? lines.length - maxHunkLines : 0;
    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    const rendered: DiffDisplayLine[] = [
      { kind: 'header', text: hunkHeader },
      ...visible.map((line): DiffDisplayLine => {
        const marker = line[0];
        if (marker === '+') return { kind: 'added', text: line };
        if (marker === '-') return { kind: 'removed', text: line };
        return { kind: 'context', text: line };
      }),
    ];
    if (remaining > 0) {
      rendered.push({
        kind: 'overflow',
        text: `… ${remaining} more lines`,
      });
    }
    return rendered;
  });
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
        const lines = diffDisplayLines([hunk], max);
        return (
          <Box key={`${hi}-${hunk.oldStart}`} flexDirection="column">
            {lines.map((line, li) => (
              <DiffLine key={li} line={line} width={width} />
            ))}
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
  readonly line: DiffDisplayLine;
  readonly width: number;
}): React.JSX.Element {
  const wrapped = wrapAnsiToWidth(line.text, width);
  if (line.kind === 'added') return <Text color="green">{wrapped}</Text>;
  if (line.kind === 'removed') return <Text color="red">{wrapped}</Text>;
  return <Text dimColor>{wrapped}</Text>;
}
