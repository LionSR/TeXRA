import { Box } from 'ink';

import { AgentCategory } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import { activeStreamId as activeStreamIdSignal } from '../state/cliState';
import { sessionView, streamPhaseOf, streamViewOf } from '../state/sessionView';
import {
  mergeLocalNotices,
  mergedSettledRows,
  notices as noticesSignal,
  noticesFor,
} from '../state/transcript';
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import {
  BoundedTranscriptEntry,
  LiveTranscriptEntry,
  TranscriptEntry,
} from './TranscriptEntry';
import { ToolUseRow } from './ToolUseRow';
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
  readonly entry: TranscriptRow;
  readonly rowLimit?: number;
  readonly subagentExecutionLabels?: ExecutionLabels;
  readonly width?: number;
}): React.JSX.Element | null {
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
    switch (entry.kind) {
      case 'tool':
        return (
          <ToolUseRow
            subagentExecutionLabels={subagentExecutionLabels}
            toolRow={entry}
            width={width}
          />
        );
      case 'assistant':
      case 'log':
        return <LiveTranscriptEntry entry={entry} width={width} />;
      case 'user':
      case 'compactionActivity':
      case 'error':
      case 'fileList':
      case 'workflowTask':
        return (
          <TranscriptEntry
            colorEnabled={colorEnabled}
            entry={entry}
            fillWidth
            width={width}
          />
        );
      case 'phase':
        return (
          <TranscriptEntry
            colorEnabled={colorEnabled}
            entry={entry}
            width={width}
          />
        );
      default:
        return null;
    }
  })();
  if (content === null) return null;
  return (
    <EntryErrorBoundary key={entry.id} label={entry.kind}>
      {content}
    </EntryErrorBoundary>
  );
}

/**
 * The live tail of the active conversation: the rows the scrollback has not
 * settled yet, read from the fold and joined with this TUI's local notices.
 */
export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(activeStreamIdSignal);
  const view = useSignal(sessionView());
  const allNotices = useSignal(noticesSignal);
  const stream = streamViewOf(view, activeStreamId);
  const streamNotices = noticesFor(allNotices, activeStreamId);
  const entries = mergeLocalNotices(
    stream?.transcript.rows ?? [],
    streamNotices,
  );
  const displayEntries = pendingTranscriptEntries(
    entries,
    mergedSettledRows(
      stream?.transcript.rows ?? [],
      stream?.transcript.settledRows ?? 0,
      streamNotices,
    ),
    streamPhaseOf(stream),
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
        estimateLiveTranscriptEntryRows(
          newestPendingEntry,
          props.width,
          props.subagentExecutionLabels,
        ),
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
    props.subagentExecutionLabels,
  );
  const visibleRows = detailRows + visibleEntries.usedRows;
  return (
    <Box flexDirection="column" height={visibleRows} overflowY="hidden">
      <WorkflowRunDetails
        lines={visibleWorkflowDetails}
        width={metadataWidth}
      />
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
