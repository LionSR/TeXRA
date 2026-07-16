// Full-output transcript viewer (ctrl+t).
//
// The finalized scrollback and live region only ever show a head+tail slice of
// tool output (see toolRenderers `elideOutputLines`). This foreground surface
// renders the active stream's entries untruncated and scrollable so the user
// can read everything the `… +N lines` marker collapsed.

import { useEffect, useMemo, useState } from 'react';

import { Box, Text, useInput } from 'ink';

import { isEmptyUsage } from '@shared/schemas';
import { formatRoundStageLabel } from '@shared/streams/streamStatusDisplay';
import { formatCompactTokenCount } from '@utils/core';

import {
  isEscapeInput,
  isJumpToBottomInput,
  isJumpToTopInput,
} from '../input/inputKeys';
import { COLOR_HINT } from '../ui/colors';
import { KeyHints } from '../ui/KeyHints';
import {
  initialTranscriptScrollState,
  maxTranscriptScrollOffset,
  scrollTranscriptToOffset,
  syncTranscriptScrollState,
} from '../state/transcriptScroll';
import { transcriptToLines } from '../state/transcriptLines';
import type { StreamSlice } from '../state/cliState';

export interface TranscriptViewerProps {
  readonly slice: StreamSlice | undefined;
  readonly width: number;
  readonly availableRows: number;
  readonly onClose: () => void;
  /** Optional header label naming the stream being viewed (e.g. the subagent
   *  label) so a scoped viewer makes clear whose transcript this is. */
  readonly title?: string;
}

export function TranscriptViewer({
  slice,
  width,
  availableRows,
  onClose,
  title,
}: TranscriptViewerProps): React.JSX.Element {
  const lines = useMemo(
    () => transcriptToLines(slice, Math.max(1, width)),
    // Key on slice.entries, not the whole slice: syncStreamLog hands back a
    // fresh slice object every ~16ms tick, but the entries array stays the
    // same reference when nothing was promoted. Keying on entries skips the
    // O(N) re-flatten on status-only ticks during streaming.
    [slice?.entries, width],
  );
  const usage = slice?.cumulativeUsage;
  const headerText = [
    title,
    formatRoundStageLabel(slice?.roundStage),
    usage && !isEmptyUsage(usage)
      ? `${formatCompactTokenCount(usage.inputTokens)} in / ${formatCompactTokenCount(usage.outputTokens)} out`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  // Reserve one row for the footer hint strip, plus one for the title header
  // when present, so the scrollable region never overflows availableRows.
  const titleRows = headerText ? 1 : 0;
  const viewRows = Math.max(1, availableRows - 1 - titleRows);
  // Open pinned to the bottom — the latest output is what the user just asked
  // to inspect.
  const [{ offset }, setScrollState] = useState(() =>
    initialTranscriptScrollState({ lineCount: lines.length, viewRows }),
  );

  function scrollTo(next: number | ((currentOffset: number) => number)): void {
    setScrollState((current) => {
      const requested =
        typeof next === 'function' ? next(current.offset) : next;
      return scrollTranscriptToOffset(
        { lineCount: lines.length, viewRows },
        requested,
      );
    });
  }

  // React to content growth / resize: follow the tail when armed, otherwise
  // just clamp so the offset never points past the end.
  useEffect(() => {
    setScrollState((current) =>
      syncTranscriptScrollState(current, { lineCount: lines.length, viewRows }),
    );
  }, [lines.length, viewRows]);

  useInput((input, key) => {
    if (isEscapeInput(input, key) || (key.ctrl && input.toLowerCase() === 't'))
      onClose();
    else if (key.downArrow) scrollTo((current) => current + 1);
    else if (key.upArrow) scrollTo((current) => current - 1);
    else if (key.pageDown) scrollTo((current) => current + viewRows);
    else if (key.pageUp) scrollTo((current) => current - viewRows);
    else if (isJumpToTopInput(input)) scrollTo(0);
    else if (isJumpToBottomInput(input))
      scrollTo(
        maxTranscriptScrollOffset({ lineCount: lines.length, viewRows }),
      );
  });

  const visible = lines.slice(offset, offset + viewRows);
  const lastVisibleLine = Math.min(lines.length, offset + viewRows);

  return (
    <Box flexDirection="column" width={width}>
      {headerText ? (
        <Text bold color={COLOR_HINT} wrap="truncate-end">
          {headerText}
        </Text>
      ) : null}
      <Box flexDirection="column" overflowY="hidden">
        {lines.length === 0 ? (
          <Text dimColor>(no transcript yet)</Text>
        ) : (
          // Ink collapses an empty-string Text to zero height; the space keeps
          // blank separator rows between entries visible.
          visible.map((line, index) => (
            <Text key={offset + index}>{line || ' '}</Text>
          ))
        )}
      </Box>
      <KeyHints
        confirmCancel={false}
        hints={[
          { key: '↑/↓', action: 'scroll' },
          { key: 'PgUp/PgDn', action: 'page' },
          { key: 'g/G', action: 'top/bottom' },
          {
            key: 'Esc',
            action:
              lines.length > 0
                ? `close (${lastVisibleLine}/${lines.length})`
                : 'close',
          },
        ]}
      />
    </Box>
  );
}
