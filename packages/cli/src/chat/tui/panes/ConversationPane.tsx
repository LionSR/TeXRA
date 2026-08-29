// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box, Text } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { AgentCategory } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import {
  formatWorkflowPhaseHeading,
  workflowCallFailureTally,
  workflowPhaseCallProgress,
  workflowPhaseHeadingOfGroup,
} from '@shared/copy/workflowCall';
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

/**
 * One colored fragment of the workflow status band. Neutral progress is
 * `muted` (the band's prior dim styling); a failure tally is `warning` so a
 * degraded run does not read as a clean one. Separators are added by the
 * renderer, never stored here, so the data stays a clean logical list.
 */
interface WorkflowStatusSegment {
  readonly text: string;
  readonly tone: 'muted' | 'warning';
}

/**
 * One-line workflow status band. Phase progress leads so it survives
 * `truncate-end` on a narrow terminal. The running `done/total` lives here
 * rather than on the `◆` divider because that divider prints once into
 * scrollback and can never be rewritten.
 *
 * The phase and its calls both come from the run's own phase task groups — the
 * band names the last phase the run opened and counts the calls whose
 * `groupId` names it, which is the classification the progress view's group
 * tree makes and the dashboard's phase rows reuse. Matching on the call's
 * `phase` *label* instead would fuse two same-named phases into one tally.
 * Naming the phase is also what keeps this number distinct from the
 * dashboard heading's, which counts the whole run.
 *
 * A whole-run failure tally is appended in a warning tone the moment any call
 * fails. The engine deliberately keeps the run going after a failed subagent
 * (it resolves to `null`), so the lifecycle stays `completed` — but the status
 * band must not let that read as a clean run.
 */
export function workflowRunStatusSummary(
  slice: StreamSlice | undefined,
  category: AgentCategory | undefined,
): readonly WorkflowStatusSegment[] | undefined {
  if (!slice || category !== AgentCategory.Workflow) return undefined;
  const phase = slice.taskGroups.findLast((group) => group.kind === 'phase');
  // Surface failures only once the band has a phase/progress anchor, so a
  // stray phase-less failed call does not invent a band on its own (a
  // phase-less run can never produce total>0, so the band would already
  // always be undefined here). The tally is whole-run, so a failure persists
  // after the run advances past its phase (unlike the current-phase
  // done/total).
  if (!phase) return undefined;
  const callRows = slice.entries.flatMap((row) =>
    row.kind === 'workflowTask' ? [row] : [],
  );
  const { done, total } = workflowPhaseCallProgress(
    callRows.filter((row) => row.groupId === phase.id).map((row) => row.call),
  );
  const segments: WorkflowStatusSegment[] = [
    {
      text: formatWorkflowPhaseHeading(workflowPhaseHeadingOfGroup(phase)),
      tone: 'muted',
    },
  ];
  if (total > 0) {
    segments.push({ text: `${done}/${total} done`, tone: 'muted' });
  }
  const { failed } = workflowCallFailureTally(callRows.map((row) => row.call));
  if (failed > 0) {
    segments.push({ text: `${failed} failed`, tone: 'warning' });
  }
  return segments;
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
  const workflowMetadata = workflowRunStatusSummary(slice, category);
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
      {workflowMetadata !== undefined && metadataRows > 0 ? (
        <Box height={1} width={metadataWidth} overflowY="hidden">
          <Text wrap="truncate-end">
            {workflowMetadata.map((segment, index) => (
              <Text key={index}>
                {index > 0 ? <Text dimColor>{' · '}</Text> : null}
                <Text
                  dimColor={segment.tone === 'muted'}
                  color={segment.tone === 'warning' ? COLOR_WARNING : undefined}
                >
                  {segment.text}
                </Text>
              </Text>
            ))}
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
