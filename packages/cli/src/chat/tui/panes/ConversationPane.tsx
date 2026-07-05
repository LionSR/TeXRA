// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box, Text } from 'ink';

import { activeStreamId as activeStreamIdSignal } from '../state/cliState/focusSlice';
import { streams as streamsSignal } from '../state/cliState/streamsSlice';
import {
  thinkingIndicatorVisible,
  type ConversationEntry,
} from '../state/cliState/types';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { useSignal } from '../state/useSignal';
import { THINKING_MARKER } from '../ui/glyphs';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import {
  BoundedTranscriptEntry,
  LiveTranscriptEntry,
  TranscriptEntry,
} from './TranscriptEntry';
import { ToolUseRow } from './ToolUseRow';
import { splitTranscriptEntries } from './transcriptEntries';
import {
  estimateTranscriptEntryRows,
  selectTranscriptEntriesForViewport,
} from './transcriptViewport';

const DEFAULT_TRANSCRIPT_ROWS = 24;
const MIN_PENDING_ROWS = 1;
const THINKING_DOTS = ['.', '..', '...'] as const;

/**
 * Liveness row for the hidden reasoning phase: the model is working but
 * nothing streams into the transcript, so the pane shows that thinking is
 * happening (never the thinking text itself). Animated off the shared 1 Hz
 * ticker — an autonomous 80 ms spinner would repaint the whole live region
 * at ~12 Hz during exactly the phase where nothing else is streaming, while
 * the shared tick batches with the StatusBar's elapsed-seconds render.
 */
function ThinkingRow(): React.JSX.Element {
  const now = useLiveNowMs(true);
  const dots = THINKING_DOTS[Math.floor(now / 1000) % THINKING_DOTS.length];
  return (
    <Box>
      <Text dimColor>
        {THINKING_MARKER} Thinking{dots}
      </Text>
    </Box>
  );
}

export interface ConversationPaneProps {
  readonly width?: number;
  readonly maxRows?: number;
  readonly colorEnabled?: boolean;
}

function renderConversationPaneEntry({
  colorEnabled,
  entry,
  rowLimit,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: ConversationEntry;
  readonly rowLimit?: number;
  readonly width?: number;
}): React.JSX.Element | null {
  // When the newest entry alone overflows the pane, the bounded renderer is the
  // paint contract. Apply it before role/mode branches so sizing and painting
  // stay in lockstep.
  const content = ((): React.JSX.Element | null => {
    if (rowLimit !== undefined) {
      return (
        <BoundedTranscriptEntry
          colorEnabled={colorEnabled}
          entry={entry}
          maxRows={rowLimit}
          width={width}
        />
      );
    }
    if (entry.role === 'tool') {
      return <ToolUseRow toolUse={entry.toolUse} width={width} />;
    }
    if (entry.role === 'assistant') {
      return <LiveTranscriptEntry entry={entry} width={width} />;
    }
    if (entry.role === 'user') {
      return (
        <TranscriptEntry
          colorEnabled={colorEnabled}
          entry={entry}
          fillWidth
          width={width}
        />
      );
    }
    if (entry.role === 'error') {
      return (
        <BoundedTranscriptEntry
          colorEnabled={colorEnabled}
          entry={entry}
          maxRows={estimateTranscriptEntryRows(entry, width)}
          width={width}
        />
      );
    }
    return null;
  })();
  if (content === null) return null;
  // Isolate per entry so a single throwing renderer can't blank the live pane.
  // The key moves to the boundary since it is now the list child.
  return (
    <EntryErrorBoundary key={entry.id} label={entry.role}>
      {content}
    </EntryErrorBoundary>
  );
}

export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(activeStreamIdSignal);
  const streams = useSignal(streamsSignal);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const displayEntries = splitTranscriptEntries(entries, slice?.status).pending;
  const showThinking = thinkingIndicatorVisible(slice);

  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  // The thinking liveness row is budgeted like any other live content: it
  // takes one row off the entry viewport so the pane's explicit height never
  // exceeds maxRows (an overflow would leak live rows into scrollback).
  const thinkingRows = showThinking ? 1 : 0;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    maxRows - thinkingRows,
    props.width,
  );
  const visibleRows =
    (visibleEntries.entries.length > 0
      ? Math.max(MIN_PENDING_ROWS, visibleEntries.usedRows)
      : 0) + thinkingRows;

  // Keep stream order intact so in-flight text stays interleaved with tool rows.
  // The explicit height keeps the input bar pinned and prevents bursts from
  // stealing rows reserved for the footer chrome.
  return (
    <Box flexDirection="column" height={visibleRows} overflowY="hidden">
      {visibleEntries.entries.map((entry) =>
        renderConversationPaneEntry({
          colorEnabled: props.colorEnabled,
          entry,
          rowLimit: visibleEntries.rowLimits.get(entry.id),
          width: props.width,
        }),
      )}
      {showThinking ? <ThinkingRow /> : null}
    </Box>
  );
}
