// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box } from 'ink';

import { cliState, type ConversationEntry } from '../state/cliState';
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import { BoundedTranscriptEntry, LiveTranscriptEntry } from './TranscriptEntry';
import { ToolUseRow } from './ToolUseRow';
import { splitTranscriptEntries } from './transcriptEntries';
import { selectTranscriptEntriesForViewport } from './transcriptViewport';

const DEFAULT_TRANSCRIPT_ROWS = 24;
const MIN_PENDING_ROWS = 1;

export interface ConversationPaneProps {
  readonly width?: number;
  readonly maxRows?: number;
  readonly allowNativeScrollbackOverflow?: boolean;
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
    if (entry.role === 'tool' && entry.toolUse) {
      return <ToolUseRow toolUse={entry.toolUse} width={width} />;
    }
    if (entry.role === 'assistant') {
      return <LiveTranscriptEntry entry={entry} width={width} />;
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
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const displayEntries = splitTranscriptEntries(entries, slice?.status).pending;
  if (props.allowNativeScrollbackOverflow) {
    return (
      <Box flexDirection="column">
        {displayEntries.map((entry) =>
          renderConversationPaneEntry({
            colorEnabled: props.colorEnabled,
            entry,
            width: props.width,
          }),
        )}
      </Box>
    );
  }

  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    maxRows,
    props.width,
  );
  const visibleRows =
    displayEntries.length > 0
      ? Math.max(MIN_PENDING_ROWS, visibleEntries.usedRows)
      : 0;

  // Keep stream order intact so in-flight text stays interleaved with tool rows.
  // The explicit height keeps the input bar pinned and prevents bursts from
  // stealing rows reserved for the footer chrome.
  return (
    <Box flexDirection="column" height={visibleRows} overflowY="hidden">
      {visibleEntries.entries.map((entry) => {
        return renderConversationPaneEntry({
          colorEnabled: props.colorEnabled,
          entry,
          rowLimit: visibleEntries.rowLimits.get(entry.id),
          width: props.width,
        });
      })}
    </Box>
  );
}
