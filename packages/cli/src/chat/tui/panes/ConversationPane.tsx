// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box, Text } from 'ink';

import { AgentCategory } from '@shared/schemas';
import {
  formatWorkflowPhaseHeading,
  workflowPhaseCallProgress,
} from '@shared/copy/workflowCall';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import {
  activeStreamId as activeStreamIdSignal,
  streams as streamsSignal,
  type ConversationEntry,
  type StreamSlice,
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
  estimateLiveTranscriptEntryRows,
  estimateTranscriptEntryRows,
  selectTranscriptEntriesForViewport,
} from './transcriptViewport';
import {
  selectWorkflowRunDetailLines,
  WorkflowRunDetails,
} from './WorkflowRunDetails';

const DEFAULT_TRANSCRIPT_ROWS = 24;
const MIN_PENDING_ROWS = 1;

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
    if (
      entry.role === 'activity' ||
      entry.role === 'error' ||
      entry.role === 'workflowTask'
    ) {
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

/**
 * One-line workflow status band. Phase progress leads so it survives
 * `truncate-end` on a narrow terminal. The running `done/total` lives here
 * rather than on the `◆` divider because that divider prints once into
 * scrollback and can never be rewritten.
 */
export function workflowRunStatusSummary(
  slice: StreamSlice | undefined,
): string | undefined {
  if (slice?.category !== AgentCategory.Workflow) return undefined;
  const phase = slice.entries.findLast((entry) => entry.role === 'phase');
  const { done, total } = workflowPhaseCallProgress(
    phase
      ? slice.entries.flatMap((entry) =>
          entry.role === 'workflowTask' && entry.task.phase === phase.phaseLabel
            ? [entry.task]
            : [],
        )
      : [],
  );
  const segments = [
    ...(phase ? [formatWorkflowPhaseHeading(phase)] : []),
    ...(total > 0 ? [`${done}/${total} done`] : []),
  ];
  return segments.length > 0 ? segments.join(' · ') : undefined;
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
  const metadataWidth =
    props.availableWidth !== undefined && props.width !== undefined
      ? Math.min(props.availableWidth, props.width)
      : (props.availableWidth ?? props.width);
  const workflowMetadata = workflowRunStatusSummary(slice);
  const metadataRows =
    workflowMetadata &&
    maxRows > 0 &&
    (displayEntries.length === 0 || maxRows > 1)
      ? 1
      : 0;
  const newestPendingEntry = displayEntries.at(-1);
  const pendingRowReserve = newestPendingEntry
    ? Math.min(
        Math.max(0, maxRows - metadataRows),
        Math.max(
          MIN_PENDING_ROWS,
          estimateLiveTranscriptEntryRows(
            newestPendingEntry,
            props.width,
            props.subagentExecutionLabels,
          ),
        ),
      )
    : 0;
  const detailCapacity = Math.max(
    0,
    maxRows - metadataRows - pendingRowReserve,
  );
  const visibleWorkflowDetails =
    slice?.category === AgentCategory.Workflow
      ? selectWorkflowRunDetailLines(slice, detailCapacity)
      : [];
  const detailRows = visibleWorkflowDetails.length;
  const visibleEntries = selectTranscriptEntriesForViewport(
    displayEntries,
    Math.max(0, maxRows - metadataRows - detailRows),
    props.width,
    props.subagentExecutionLabels,
  );
  const visibleRows =
    metadataRows +
    detailRows +
    (visibleEntries.entries.length > 0
      ? Math.max(MIN_PENDING_ROWS, visibleEntries.usedRows)
      : 0);

  // Keep stream order intact so in-flight text stays interleaved with tool rows.
  // The explicit height keeps the input bar pinned and prevents bursts from
  // stealing rows reserved for the footer chrome.
  return (
    <Box flexDirection="column" height={visibleRows} overflowY="hidden">
      {metadataRows > 0 ? (
        <Box height={1} width={metadataWidth} overflowY="hidden">
          <Text dimColor wrap="truncate-end">
            {workflowMetadata}
          </Text>
        </Box>
      ) : null}
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
