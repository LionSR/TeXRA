// Bounded transcript region for the current stream. The root stream uses this
// for in-flight assistant/tool rows only because finalized rows print once
// through `<Static>`. Focused child streams use the same renderer in scoped
// history mode so their visible pane contains only their own entries.

import { Box } from 'ink';

import { cliState, type ConversationEntry } from '../state/cliState';
import { useSignal } from '../state/useSignal';
import {
  BoundedTranscriptEntry,
  LiveTranscriptEntry,
  TranscriptEntry,
} from './TranscriptEntry';
import { ToolUseRow } from './ToolUseRow';
import { splitTranscriptEntries } from './transcriptEntries';
import { selectTranscriptEntriesForViewport } from './transcriptViewport';

const DEFAULT_TRANSCRIPT_ROWS = 24;
const MIN_PENDING_ROWS = 1;

export type ConversationPaneMode = 'live-pending' | 'scoped-history';

export interface ConversationPaneProps {
  readonly width?: number;
  readonly maxRows?: number;
  readonly mode?: ConversationPaneMode;
  readonly colorEnabled?: boolean;
}

function entriesForConversationPane({
  entries,
  mode,
  status,
}: {
  readonly entries: readonly ConversationEntry[];
  readonly mode: ConversationPaneMode;
  readonly status: Parameters<typeof splitTranscriptEntries>[1];
}): readonly ConversationEntry[] {
  if (mode === 'scoped-history') return entries;
  return splitTranscriptEntries(entries, status).pending;
}

function renderConversationPaneEntry({
  colorEnabled,
  entry,
  mode,
  rowLimit,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: ConversationEntry;
  readonly mode: ConversationPaneMode;
  readonly rowLimit?: number;
  readonly width?: number;
}): React.JSX.Element | null {
  if (rowLimit !== undefined) {
    return (
      <BoundedTranscriptEntry
        key={entry.id}
        colorEnabled={colorEnabled}
        entry={entry}
        maxRows={rowLimit}
        width={width}
      />
    );
  }
  if (mode === 'scoped-history' && entry.finalized) {
    return (
      <TranscriptEntry
        key={entry.id}
        entry={entry}
        width={width}
        colorEnabled={colorEnabled}
        fillWidth
      />
    );
  }
  if (entry.role === 'tool' && entry.toolUse) {
    return (
      <ToolUseRow
        key={entry.id}
        fillWidth={mode === 'scoped-history'}
        toolUse={entry.toolUse}
        width={width}
      />
    );
  }
  if (entry.role === 'assistant') {
    return <LiveTranscriptEntry key={entry.id} entry={entry} width={width} />;
  }
  if (mode === 'scoped-history') {
    return (
      <TranscriptEntry
        key={entry.id}
        entry={entry}
        width={width}
        colorEnabled={colorEnabled}
        fillWidth
      />
    );
  }
  return null;
}

export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const mode = props.mode ?? 'live-pending';
  const displayEntries = entriesForConversationPane({
    entries,
    mode,
    status: slice?.status,
  });
  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    maxRows,
    props.width,
    mode === 'scoped-history' ? 'finalized-full' : 'live-tail',
  );
  const visibleRows =
    displayEntries.length > 0
      ? Math.max(MIN_PENDING_ROWS, visibleEntries.usedRows)
      : 0;

  // Keep stream order intact. In live mode this interleaves in-flight text
  // with tool rows; in scoped mode it preserves the child transcript slice.
  // The explicit height keeps the input bar pinned and prevents bursts from
  // stealing rows reserved for the footer chrome.
  return (
    <Box flexDirection="column" height={visibleRows} overflowY="hidden">
      {visibleEntries.entries.map((entry) => {
        return renderConversationPaneEntry({
          colorEnabled: props.colorEnabled,
          entry,
          mode,
          rowLimit: visibleEntries.rowLimits.get(entry.id),
          width: props.width,
        });
      })}
    </Box>
  );
}
