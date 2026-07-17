// CLI-native tool-call row: paints the styled-line model from toolRenderers.
// The spans carry all styling; the only rich block is the patch preview,
// which renders through DiffView instead of its plain-text projection.

import { memo } from 'react';
import { Box, Text } from 'ink';

import { type NormalizedToolUse } from '@shared/schemas';

import { DiffView } from '../render/DiffView';
import { clipToWidth } from '../render/terminalText';
import { TOOL_OUTPUT_CORNER } from '../ui/glyphs';
import {
  toolUseMarginBottomRows,
  toolUseStyledLines,
  type ToolDisplayLine,
} from './toolRenderers';

/** Combined left padding of the two nested boxes wrapping the patch diff. */
const PATCH_PREVIEW_INDENT = 4;
const PATCH_PREVIEW_FALLBACK_WIDTH = 80;

function PatchPreview({
  groups,
  maxRows,
  width,
}: {
  readonly groups: Extract<ToolDisplayLine, { kind: 'patch' }>['groups'];
  readonly maxRows?: number;
  readonly width?: number;
}): React.JSX.Element {
  // The diff sits under two nested `paddingLeft={2}` boxes; derive its width
  // from the real terminal so the full-row bands fill exactly the available
  // columns instead of padding to a fixed default and wrapping on narrow
  // terminals. `DiffView` floors this at its own minimum.
  const diffWidth =
    (width ?? PATCH_PREVIEW_FALLBACK_WIDTH) - PATCH_PREVIEW_INDENT;
  const labelWidth = (width ?? PATCH_PREVIEW_FALLBACK_WIDTH) - 2;
  return (
    <Box
      flexDirection="column"
      height={maxRows}
      overflowY={maxRows === undefined ? undefined : 'hidden'}
      paddingLeft={2}
    >
      {groups.map((group, index) => (
        <Box key={`${group.fileLabel}-${index}`} flexDirection="column">
          <Text dimColor>
            {clipToWidth(
              `${TOOL_OUTPUT_CORNER} ${group.fileLabel}`,
              labelWidth,
            )}
          </Text>
          <Box flexDirection="column" paddingLeft={2}>
            <DiffView
              hunks={group.hunks}
              maxDisplayLines={
                maxRows === undefined ? undefined : Math.max(1, maxRows - 1)
              }
              width={diffWidth}
            />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

type ToolDisplaySpan = Extract<
  ToolDisplayLine,
  { kind: 'row' }
>['spans'][number];

/** Translate semantic span styles to Ink's Text properties. */
export function toolDisplaySpanTextProps(span: ToolDisplaySpan): {
  readonly bold: boolean | undefined;
  readonly color: string | undefined;
  readonly dimColor: boolean;
} {
  return {
    bold: span.bold,
    color: span.color,
    dimColor: span.dim === true && span.color === undefined,
  };
}

interface ToolDisplayViewportLine {
  readonly index: number;
  readonly line: ToolDisplayLine;
  readonly maxRows?: number;
}

function toolDisplayLineRows(line: ToolDisplayLine): number {
  return line.kind === 'patch' ? line.textLines.length : 1;
}

function toolDisplayViewport(
  lines: readonly ToolDisplayLine[],
  maxRows: number | undefined,
): readonly ToolDisplayViewportLine[] {
  const indexed = lines.map((line, index) => ({ index, line }));
  if (maxRows === undefined) return indexed;

  let remainingRows = Math.max(1, Math.floor(maxRows));
  const visible: ToolDisplayViewportLine[] = [];
  for (const item of indexed.toReversed()) {
    const lineRows = toolDisplayLineRows(item.line);
    visible.unshift({
      ...item,
      ...(lineRows > remainingRows ? { maxRows: remainingRows } : {}),
    });
    remainingRows -= Math.min(lineRows, remainingRows);
    if (remainingRows === 0) break;
  }
  return visible;
}

// Memoized: tool-use objects stay reference-identical across stream-sync
// ticks unless their status/result changed, so streaming text deltas skip
// re-rendering every settled tool row in the live region.
export const ToolUseRow = memo(function ToolUseRow({
  maxRows,
  omitHeader,
  showOutput,
  toolUse,
  width,
}: {
  readonly maxRows?: number;
  readonly omitHeader?: boolean;
  readonly showOutput?: boolean;
  readonly toolUse: NormalizedToolUse;
  readonly width?: number;
}): React.JSX.Element {
  const allLines = toolUseStyledLines(toolUse, { showOutput, width });
  const lines = omitHeader === true ? allLines.slice(1) : allLines;
  const viewport = toolDisplayViewport(lines, maxRows);
  return (
    <Box
      flexDirection="column"
      marginBottom={
        maxRows === undefined ? toolUseMarginBottomRows(toolUse) : 0
      }
    >
      {viewport.map(({ index, line, maxRows: lineMaxRows }) =>
        line.kind === 'patch' ? (
          <PatchPreview
            key={index}
            groups={line.groups}
            maxRows={lineMaxRows}
            width={width}
          />
        ) : (
          <Box
            key={index}
            flexDirection="row"
            flexWrap="nowrap"
            paddingLeft={omitHeader === true || index !== 0 ? 2 : 0}
          >
            {line.spans.map((span, spanIndex) => (
              <Text key={spanIndex} {...toolDisplaySpanTextProps(span)}>
                {span.text}
              </Text>
            ))}
          </Box>
        ),
      )}
    </Box>
  );
});
