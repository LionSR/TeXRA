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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slice?.entries, width],
  );
  // Reserve one row for the footer hint strip.
  const viewRows = Math.max(1, availableRows - 1);
  const maxOffset = Math.max(0, lines.length - viewRows);
  // Open pinned to the bottom — the latest output is what the user just asked
  // to inspect.
  const [offset, setOffset] = useState(maxOffset);
  // While at the bottom, follow new output as it streams in (mid-run); once the
  // user scrolls up, hold position so reading isn't yanked. Scrolling back to
  // the bottom re-arms following.
  const [followBottom, setFollowBottom] = useState(true);

  function scrollTo(next: number): void {
    const clamped = Math.max(0, Math.min(maxOffset, next));
    setOffset(clamped);
    setFollowBottom(clamped >= maxOffset);
  }

  // React to content growth / resize: follow the tail when armed, otherwise
  // just clamp so the offset never points past the end.
  useEffect(() => {
    setOffset((current) =>
      followBottom ? maxOffset : Math.min(current, maxOffset),
    );
  }, [maxOffset, followBottom]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 't')) onClose();
    else if (key.downArrow) scrollTo(offset + 1);
    else if (key.upArrow) scrollTo(offset - 1);
    else if (key.pageDown) scrollTo(offset + viewRows);
    else if (key.pageUp) scrollTo(offset - viewRows);
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
            <Text key={offset + index} wrap="truncate-end">
              {line || ' '}
            </Text>
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
