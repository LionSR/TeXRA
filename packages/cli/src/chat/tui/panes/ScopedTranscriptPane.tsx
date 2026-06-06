import { useEffect, useMemo, useRef, useState } from 'react';

import { Box, Text, useInput } from 'ink';

import {
  clampTranscriptScrollOffset,
  initialTranscriptScrollState,
  moveTranscriptScrollState,
  syncTranscriptScrollState,
  type TranscriptScrollState,
} from '../state/transcriptScroll';
import { transcriptToLines } from '../state/transcriptLines';
import type { StreamSlice } from '../state/cliState';

export interface ScopedTranscriptPaneProps {
  readonly slice: StreamSlice | undefined;
  readonly width: number;
  readonly maxRows: number;
  readonly isActive?: boolean;
}

export function scopedTranscriptVisibleLines({
  lines,
  offset,
  viewRows,
}: {
  readonly lines: readonly string[];
  readonly offset: number;
  readonly viewRows: number;
}): readonly string[] {
  return lines.slice(offset, offset + viewRows);
}

export function ScopedTranscriptPane({
  isActive = true,
  maxRows,
  slice,
  width,
}: ScopedTranscriptPaneProps): React.JSX.Element | null {
  const cols = Math.max(1, Math.floor(width));
  const lines = useMemo(
    () => transcriptToLines(slice, cols),
    [slice?.entries, slice?.streamId, cols],
  );
  const streamId = slice?.streamId;
  const viewRows = Math.max(1, Math.floor(maxRows));
  const previousStreamId = useRef(streamId);
  const [scrollState, setScrollState] = useState<TranscriptScrollState>(() =>
    initialTranscriptScrollState({ lineCount: lines.length, viewRows }),
  );

  useEffect(() => {
    const scrollWindow = {
      lineCount: lines.length,
      viewRows,
    };
    setScrollState((current) => {
      if (previousStreamId.current !== streamId) {
        previousStreamId.current = streamId;
        return initialTranscriptScrollState(scrollWindow);
      }
      return syncTranscriptScrollState(current, scrollWindow);
    });
  }, [lines.length, streamId, viewRows]);

  function scrollBy(deltaRows: number): void {
    const scrollWindow = {
      lineCount: lines.length,
      viewRows,
    };
    setScrollState((current) =>
      moveTranscriptScrollState(current, scrollWindow, deltaRows),
    );
  }

  useInput(
    (_input, key) => {
      if (key.pageUp) scrollBy(-viewRows);
      else if (key.pageDown) scrollBy(viewRows);
    },
    { isActive },
  );

  if (maxRows <= 0) return null;
  if (lines.length === 0) {
    return (
      <Box height={1}>
        <Text dimColor>(no transcript yet)</Text>
      </Box>
    );
  }

  const visibleRows = Math.min(viewRows, lines.length);
  const renderOffset = clampTranscriptScrollOffset(
    scrollState.offset,
    { lineCount: lines.length, viewRows: visibleRows },
  );
  const visible = scopedTranscriptVisibleLines({
    lines,
    offset: renderOffset,
    viewRows: visibleRows,
  });

  return (
    <Box flexDirection="column" height={visibleRows} overflowY="hidden">
      {visible.map((line, index) => (
        <Text key={renderOffset + index}>{line || ' '}</Text>
      ))}
    </Box>
  );
}
