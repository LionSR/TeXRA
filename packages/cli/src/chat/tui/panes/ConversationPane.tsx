// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box, Text } from 'ink';

import { AgentCategory } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import {
  activeStreamId as activeStreamIdSignal,
  streamPhaseFor,
  streams as streamsSignal,
  type StreamSlice,
} from '../state/cliState';
import {
  sessionStateRevision,
  streamMetadataFor,
} from '../state/childExecutions';
import {
  readStreamArtifacts,
  streamArtifactRevision,
} from '../state/subscribeStreamArtifacts';
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
  /** Transcript measurement width, which callers may clamp to layout minimums. */
  readonly width?: number;
  /** Physical parent width; metadata must not render beyond this boundary. */
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
  // When the newest row alone overflows the pane, the bounded renderer is the
  // paint contract. Apply it before kind/mode branches so sizing and painting
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
      // Compact detail rows (thinking, web search/fetch, usage, status, …)
      // have no live presentation: they appear once they reach scrollback.
      default:
        return null;
    }
  })();
  if (content === null) return null;
  // Isolate per row so a single throwing renderer can't blank the live pane.
  // The key moves to the boundary since it is now the list child.
  return (
    <EntryErrorBoundary key={entry.id} label={entry.kind}>
      {content}
    </EntryErrorBoundary>
  );
}

export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(activeStreamIdSignal);
  const streams = useSignal(streamsSignal);
  useSignal(streamArtifactRevision);
  useSignal(sessionStateRevision);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const category = activeStreamId
    ? streamMetadataFor(activeStreamId)?.agentCategory
    : undefined;
  const artifacts =
    activeStreamId && slice ? readStreamArtifacts(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const displayEntries = pendingTranscriptEntries(
    entries,
    slice?.finalizedFrontier ?? 0,
    slice && streamPhaseFor(activeStreamId)?.phase,
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
  const workflowFacts = slice
    ? {
        taskGroups: slice.taskGroups,
        outputFilesByRound: artifacts?.outputFilesByRound ?? {},
        missingOutputsByRound: artifacts?.missingOutputsByRound ?? {},
        compileFailuresByRound: artifacts?.compileFailuresByRound ?? {},
      }
    : undefined;
  const visibleWorkflowDetails =
    category === AgentCategory.Workflow
      ? selectWorkflowRunDetailLines(workflowFacts, detailCapacity)
      : [];
  const detailRows = visibleWorkflowDetails.length;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    Math.max(0, maxRows - detailRows),
    props.width,
    props.subagentExecutionLabels,
  );
  const visibleRows = detailRows + visibleEntries.usedRows;

  // Keep stream order intact so in-flight text stays interleaved with tool rows.
  // The explicit height keeps the input bar pinned and prevents bursts from
  // stealing rows reserved for the footer chrome.
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
