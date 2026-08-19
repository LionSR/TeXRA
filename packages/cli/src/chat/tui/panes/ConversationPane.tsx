// Transcript region for the current stream's in-flight assistant/tool rows.
// Finalized history is owned by the static scrollback renderer.

import { Box, Text } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { AgentCategory } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import {
  formatWorkflowPhaseHeading,
  latestWorkflowCallsById,
  workflowCallFailureTally,
  workflowPhaseCallProgress,
} from '@shared/copy/workflowCall';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import {
  activeStreamId as activeStreamIdSignal,
  currentWorkflowAttemptId,
  streams as streamsSignal,
  type StreamSlice,
} from '../state/cliState';
import {
  sessionStateRevision,
  streamMetadataFor,
} from '../state/childExecutions';
import { currentWorkflowPhaseHeading } from '../state/workflowPhase';
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
      case 'compactionActivity':
      case 'error':
      case 'fileList':
      case 'workflowTask':
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
  const phase = currentWorkflowPhaseHeading(slice, category);
  const currentCalls = latestWorkflowCallsById(
    slice.entries.flatMap((row) =>
      row.kind === 'workflowTask' ? [row.call] : [],
    ),
    currentWorkflowAttemptId(
      slice.workflowAttemptId,
      slice.entries,
      slice.workflowAttemptBoundaryDeclared,
    ),
  );
  const { done, total } = workflowPhaseCallProgress(
    phase ? currentCalls.filter((call) => call.phase === phase.phaseLabel) : [],
  );
  const segments: WorkflowStatusSegment[] = [];
  if (phase) {
    segments.push({ text: formatWorkflowPhaseHeading(phase), tone: 'muted' });
  }
  if (total > 0) {
    segments.push({ text: `${done}/${total} done`, tone: 'muted' });
  }
  // Surface failures only once the band has a phase/progress anchor, so a
  // stray phase-less failed call does not invent a band on its own. The tally
  // is whole-run, so a failure persists after the run advances past its phase
  // (unlike the current-phase done/total).
  if (segments.length > 0) {
    const { failed } = workflowCallFailureTally(currentCalls);
    if (failed > 0) {
      segments.push({ text: `${failed} failed`, tone: 'warning' });
    }
  }
  return segments.length > 0 ? segments : undefined;
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
  const displayEntries = splitTranscriptEntries(
    entries,
    slice?.finalizedFrontier ?? 0,
    slice?.status,
  ).pending;

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
              <Text
                key={index}
                dimColor={segment.tone === 'muted'}
                color={segment.tone === 'warning' ? COLOR_WARNING : undefined}
              >
                {index > 0 ? ` · ${segment.text}` : segment.text}
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
