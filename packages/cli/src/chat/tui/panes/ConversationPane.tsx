// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box } from 'ink';

import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import {
  activeStreamId as activeStreamIdSignal,
  streams as streamsSignal,
  type ConversationEntry,
} from '../state/cliState';
import { useSignal } from '../state/useSignal';
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

export interface ConversationPaneProps {
  readonly width?: number;
  readonly maxRows?: number;
  readonly colorEnabled?: boolean;
  readonly subagentExecutionLabels?: ExecutionLabels;
}

function renderConversationPaneEntry({
  colorEnabled,
  entry,
  rowLimit,
  subagentExecutionLabels,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: ConversationEntry;
  readonly rowLimit?: number;
  readonly subagentExecutionLabels?: ExecutionLabels;
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
          subagentExecutionLabels={subagentExecutionLabels}
          width={width}
        />
      );
    }
    if (entry.role === 'tool') {
      return (
        <ToolUseRow
          subagentExecutionLabels={subagentExecutionLabels}
          toolUse={entry.toolUse}
          width={width}
        />
      );
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
          maxRows={estimateTranscriptEntryRows(
            entry,
            width,
            subagentExecutionLabels,
          )}
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

  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    maxRows,
    props.width,
    props.subagentExecutionLabels,
  );
  const visibleRows =
    visibleEntries.entries.length > 0
      ? Math.max(MIN_PENDING_ROWS, visibleEntries.usedRows)
      : 0;

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
          subagentExecutionLabels: props.subagentExecutionLabels,
          width: props.width,
        }),
      )}
    </Box>
  );
}
