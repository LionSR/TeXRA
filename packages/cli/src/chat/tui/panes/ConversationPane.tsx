import { Box } from 'ink';

import { selectedRunId as selectedRunIdSignal } from '../state/cliState';
import { sessionView, runViewOf } from '../state/sessionView';
import {
  conversationRows,
  notices as noticesSignal,
} from '../state/transcript';
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import { LiveTranscriptEntry } from './TranscriptEntry';
import { pendingTranscriptEntries } from './transcriptEntries';
import { selectTranscriptEntriesForViewport } from './transcriptViewport';
import { isWorking } from '@texra-ai/worldline/schemas';

interface ConversationPaneProps {
  readonly width: number;
  readonly maxRows: number;
}

/**
 * The live tail of the active conversation: the rows the scrollback has not
 * finished yet, read from the session view and joined with this TUI's local notices.
 */
export function ConversationPane({
  maxRows,
  width,
}: ConversationPaneProps): React.JSX.Element {
  const activeRunId = useSignal(selectedRunIdSignal);
  const view = useSignal(sessionView());
  const allNotices = useSignal(noticesSignal);
  const stream = runViewOf(view, activeRunId);
  const merged = conversationRows(stream, allNotices, activeRunId);
  const displayEntries = pendingTranscriptEntries(
    merged.rows,
    merged.finalRows,
    stream != null && isWorking(stream),
  );
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    Math.max(0, maxRows),
    width,
  );
  return (
    <Box flexDirection="column" maxHeight={maxRows} overflowY="hidden">
      {visibleEntries.entries.map((entry) => (
        <EntryErrorBoundary key={entry.id} label={entry.kind}>
          <LiveTranscriptEntry
            entry={entry}
            maxRows={visibleEntries.rowLimits.get(entry.id)}
            width={width}
          />
        </EntryErrorBoundary>
      ))}
    </Box>
  );
}
