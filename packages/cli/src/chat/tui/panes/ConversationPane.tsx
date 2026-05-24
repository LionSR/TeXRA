// Live region of the chat transcript: in-flight assistant text and pending
// tool rows only. Finalized entries print once through `<Static>` (see
// `StaticConversationTranscript.tsx`) so the terminal owns transcript
// scrollback. The bounded pane below is only for entries that may still
// change between renders.

import { Box } from 'ink';

import { cliState } from '../state/cliState';
import { useSignal } from '../state/useSignal';
import { BoundedTranscriptEntry, LiveTranscriptEntry } from './TranscriptEntry';
import { ToolUseRow } from './ToolUseRow';
import { splitTranscriptEntries } from './transcriptEntries';
import { selectPendingEntriesForViewport } from './transcriptViewport';

// Re-exports for tests and downstream callers — keep this surface stable
// even as the file is split into focused modules.
export {
  appendStaticTranscriptItems,
  StaticConversationTranscript,
  type StaticTranscriptItem,
} from './StaticConversationTranscript';
export { splitTranscriptEntries } from './transcriptEntries';
export {
  estimateTranscriptEntryRows,
  selectPendingEntriesForViewport,
} from './transcriptViewport';

const DEFAULT_TRANSCRIPT_ROWS = 24;
const MIN_PENDING_ROWS = 1;

export interface ConversationPaneProps {
  readonly width?: number;
  readonly maxRows?: number;
}

export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const { pending } = splitTranscriptEntries(entries, slice?.status);
  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  const visiblePending = selectPendingEntriesForViewport(
    pending,
    maxRows,
    props.width,
  );
  const pendingRows =
    pending.length > 0
      ? Math.max(MIN_PENDING_ROWS, visiblePending.usedRows)
      : 0;

  // `pending` interleaves the in-flight assistant entry with tool rows in
  // stream order — rendering them as separate buckets would flip the
  // visible order when the model emits text before a tool call. The
  // explicit height keeps the input bar pinned and prevents tool bursts
  // from stealing rows reserved for the footer chrome.
  return (
    <Box flexDirection="column" height={pendingRows} overflowY="hidden">
      {visiblePending.entries.map((entry) => {
        const rowLimit = visiblePending.rowLimits.get(entry.id);
        if (rowLimit !== undefined) {
          return (
            <BoundedTranscriptEntry
              key={entry.id}
              entry={entry}
              maxRows={rowLimit}
              width={props.width}
            />
          );
        }
        if (entry.role === 'tool' && entry.toolUse) {
          return <ToolUseRow key={entry.id} toolUse={entry.toolUse} />;
        }
        if (entry.role === 'assistant') {
          return (
            <LiveTranscriptEntry
              key={entry.id}
              entry={entry}
              width={props.width}
            />
          );
        }
        return null;
      })}
    </Box>
  );
}
