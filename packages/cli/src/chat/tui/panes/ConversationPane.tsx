import { Box } from 'ink';

import { AgentCategory } from '@shared/schemas';

import { selectedRunId as selectedRunIdSignal } from '../state/cliState';
import { sessionView, runPhaseOf, runViewOf } from '../state/sessionView';
import {
  mergeLocalNotices,
  notices as noticesSignal,
  noticesFor,
} from '../state/transcript';
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import { LiveTranscriptEntry } from './TranscriptEntry';
import { pendingTranscriptEntries } from './transcriptEntries';
import {
  estimateLiveTranscriptEntryRows,
  selectTranscriptEntriesForViewport,
} from './transcriptViewport';
import {
  selectWorkflowRunDetailLines,
  WorkflowRunDetails,
} from './WorkflowRunDetails';

const DEFAULT_TRANSCRIPT_ROWS = 24;

interface ConversationPaneProps {
  readonly width?: number;
  readonly availableWidth?: number;
  readonly maxRows?: number;
}

/**
 * The live tail of the active conversation: the rows the scrollback has not
 * settled yet, read from the fold and joined with this TUI's local notices.
 */
export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeRunId = useSignal(selectedRunIdSignal);
  const view = useSignal(sessionView());
  const allNotices = useSignal(noticesSignal);
  const stream = runViewOf(view, activeRunId);
  const merged = mergeLocalNotices(stream, noticesFor(allNotices, activeRunId));
  const displayEntries = pendingTranscriptEntries(
    merged.rows,
    merged.settledRows,
    runPhaseOf(stream),
  );
  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  const metadataWidth =
    props.availableWidth !== undefined && props.width !== undefined
      ? Math.min(props.availableWidth, props.width)
      : (props.availableWidth ?? props.width);
  const newestPendingEntry = displayEntries.at(-1);
  const pendingRowReserve = newestPendingEntry
    ? Math.min(
        Math.max(0, maxRows),
        estimateLiveTranscriptEntryRows(newestPendingEntry, props.width),
      )
    : 0;
  const detailCapacity = Math.max(0, maxRows - pendingRowReserve);
  const workflowFacts =
    stream?.category === AgentCategory.Workflow
      ? {
          taskGroups: stream.transcript.taskGroups,
          runDurableOutcome: stream.durableOutcome ?? undefined,
          outputFilesByRound: stream.files,
          missingOutputsByRound: stream.missingOutputs,
          compileFailuresByRound: stream.compileFailures,
        }
      : undefined;
  const visibleWorkflowDetails = selectWorkflowRunDetailLines(
    workflowFacts,
    detailCapacity,
  );
  const detailRows = visibleWorkflowDetails.length;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    Math.max(0, maxRows - detailRows),
    props.width,
  );
  return (
    <Box flexDirection="column" maxHeight={maxRows} overflowY="hidden">
      <WorkflowRunDetails
        lines={visibleWorkflowDetails}
        width={metadataWidth}
      />
      {visibleEntries.entries.map((entry) => (
        <EntryErrorBoundary key={entry.id} label={entry.kind}>
          <LiveTranscriptEntry
            entry={entry}
            maxRows={visibleEntries.rowLimits.get(entry.id)}
            width={props.width}
          />
        </EntryErrorBoundary>
      ))}
    </Box>
  );
}
