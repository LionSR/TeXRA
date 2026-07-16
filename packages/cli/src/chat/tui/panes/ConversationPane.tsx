// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box, Text } from 'ink';

import { isActivePhase } from '@shared/streams/streamStatus';
import { formatCompactDuration } from '@utils/core';

import {
  activeStreamId as activeStreamIdSignal,
  streams as streamsSignal,
  thinkingIndicatorVisible,
  type ConversationEntry,
} from '../state/cliState';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { useSignal } from '../state/useSignal';
import { loadingFrameAt } from '../ui/LoadingIndicator';
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
// Padded to a fixed width so the elapsed time doesn't jiggle as dots cycle.
const LIVENESS_DOTS = ['.  ', '.. ', '...'] as const;

/**
 * Liveness row shown for the whole active run, not just the hidden reasoning
 * phase: long tool calls and provider latency also stream nothing into the
 * transcript, and the pane must still answer "working or stalled?". The
 * label distinguishes hidden reasoning ("Thinking") from everything else
 * ("Working") and never shows the reasoning text itself; the ticking elapsed
 * time is the stall signal. Animated off the shared 1 Hz ticker — an
 * autonomous 80 ms spinner would repaint the whole live region at ~12 Hz
 * during exactly the phase where nothing else is streaming, while the shared
 * tick batches with the StatusBar's elapsed-seconds render.
 */
function LivenessRow({
  startedAtMs,
  thinking,
}: {
  readonly startedAtMs: number | undefined;
  readonly thinking: boolean;
}): React.JSX.Element {
  const now = useLiveNowMs(true, startedAtMs);
  const dots = loadingFrameAt(now, LIVENESS_DOTS);
  const elapsed =
    startedAtMs === undefined
      ? ''
      : ` ${formatCompactDuration(now - startedAtMs)}`;
  return (
    <Box>
      <Text dimColor>
        {THINKING_MARKER} {thinking ? 'Thinking' : 'Working'}
        {dots}
        {elapsed}
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
  const showLiveness = isActivePhase(slice?.status);

  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  // The liveness row is budgeted like any other live content: it takes one
  // row off the entry viewport so the pane's explicit height never exceeds
  // maxRows (an overflow would leak live rows into scrollback). Content
  // outranks it: when a foreground panel squeezes the pane to a single row,
  // pending entries keep that row and the StatusBar's running/elapsed
  // segment carries liveness alone.
  const livenessRows =
    showLiveness && (maxRows > MIN_PENDING_ROWS || displayEntries.length === 0)
      ? 1
      : 0;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    maxRows - livenessRows,
    props.width,
  );
  const visibleRows =
    (visibleEntries.entries.length > 0
      ? Math.max(MIN_PENDING_ROWS, visibleEntries.usedRows)
      : 0) + livenessRows;

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
      {livenessRows > 0 ? (
        <LivenessRow
          startedAtMs={slice?.runStartedAt}
          thinking={thinkingIndicatorVisible(slice)}
        />
      ) : null}
    </Box>
  );
}
