import { Box } from 'ink';

import { AgentCategory } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import type { RunLabels } from '@shared/tools/executionsDisplay';

import { selectedRunId as selectedRunIdSignal } from '../state/cliState';
import { sessionView, runPhaseOf, runViewOf } from '../state/sessionView';
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
  readonly subagentRunLabels?: RunLabels;
}

function renderConversationPaneEntry({
  colorEnabled,
  entry,
  rowLimit,
  subagentRunLabels,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: TranscriptRow;
  readonly rowLimit?: number;
  readonly subagentRunLabels?: RunLabels;
  readonly width?: number;
}): React.JSX.Element | null {
  const content = ((): React.JSX.Element | null => {
    if (rowLimit !== undefined) {
      return (
        <BoundedTranscriptEntry
          colorEnabled={colorEnabled}
          entry={entry}
          maxRows={rowLimit}
          subagentRunLabels={subagentRunLabels}
          width={width}
        />
      );
    }
    switch (entry.kind) {
      case 'tool':
        return (
          <ToolUseRow
            subagentRunLabels={subagentRunLabels}
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
  const activeRunId = useSignal(selectedRunIdSignal);
  const view = useSignal(sessionView());
  const allNotices = useSignal(noticesSignal);
  const stream = runViewOf(view, activeRunId);
  const runNotices = noticesFor(allNotices, activeRunId);
  const entries = mergeLocalNotices(stream?.transcript.rows ?? [], runNotices);
  const displayEntries = pendingTranscriptEntries(
    entries,
    mergedSettledRows(
      stream?.transcript.rows ?? [],
      stream?.transcript.settledRows ?? 0,
      runNotices,
    ),
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
        estimateLiveTranscriptEntryRows(
          newestPendingEntry,
          props.width,
          props.subagentRunLabels,
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
    props.subagentRunLabels,
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
          subagentRunLabels: props.subagentRunLabels,
          width: props.width,
        }),
      )}
    </Box>
  );
}
