// Full-output transcript viewer (ctrl+t).
//
// The finalized scrollback and live region only ever show a head+tail slice of
// tool output (see toolRenderers `elideOutputLines`). This foreground surface
// renders the active stream's entries untruncated and scrollable so the user
// can read everything the `… +N lines` marker collapsed.

import { useEffect, useMemo, useState } from 'react';

import { Box, Text, useInput } from 'ink';

import { KeyHints } from '../ui/KeyHints';
import { transcriptToLines } from '../state/transcriptLines';
import type { StreamSlice } from '../state/cliState';

export interface TranscriptViewerProps {
  readonly slice: StreamSlice | undefined;
  readonly width: number;
  readonly availableRows: number;
  readonly onClose: () => void;
}

interface ScrollState {
  readonly offset: number;
  readonly followBottom: boolean;
}

export function TranscriptViewer({
  slice,
  width,
  availableRows,
  onClose,
}: TranscriptViewerProps): React.JSX.Element {
  const lines = useMemo(
    () => transcriptToLines(slice, Math.max(1, width)),
    // Key on slice.entries, not the whole slice: syncStreamLog hands back a
    // fresh slice object every ~16ms tick, but the entries array stays the
    // same reference when nothing was promoted. Keying on entries skips the
    // O(N) re-flatten on status-only ticks during streaming.
    [slice?.entries, width],
  );
  // Reserve one row for the footer hint strip.
  const viewRows = Math.max(1, availableRows - 1);
  const maxOffset = Math.max(0, lines.length - viewRows);
  // Open pinned to the bottom — the latest output is what the user just asked
  // to inspect.
  const [{ offset }, setScrollState] = useState<ScrollState>(() => ({
    offset: maxOffset,
    followBottom: true,
  }));

  function clampOffset(next: number): number {
    return Math.max(0, Math.min(maxOffset, next));
  }

  function scrollTo(next: number | ((currentOffset: number) => number)): void {
    setScrollState((current) => {
      const requested =
        typeof next === 'function' ? next(current.offset) : next;
      const offset = clampOffset(requested);
      return { offset, followBottom: offset >= maxOffset };
    });
  }

  // React to content growth / resize: follow the tail when armed, otherwise
  // just clamp so the offset never points past the end.
  useEffect(() => {
    setScrollState((current) => {
      const offset = current.followBottom
        ? maxOffset
        : Math.min(current.offset, maxOffset);
      return offset === current.offset ? current : { ...current, offset };
    });
  }, [maxOffset]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === 't')) onClose();
    else if (key.downArrow) scrollTo((current) => current + 1);
    else if (key.upArrow) scrollTo((current) => current - 1);
    else if (key.pageDown) scrollTo((current) => current + viewRows);
    else if (key.pageUp) scrollTo((current) => current - viewRows);
    else if (input === 'g') scrollTo(0);
    else if (input === 'G') scrollTo(maxOffset);
  });

  const visible = lines.slice(offset, offset + viewRows);
  const lastVisibleLine = Math.min(lines.length, offset + viewRows);

  return (
    <Box flexDirection="column" width={width}>
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
