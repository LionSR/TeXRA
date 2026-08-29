// Persistent child-session list.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  POINTER,
  STATUS_DIAMOND,
  TICK,
  TOKENS_GENERATED,
} from '@cli/tui/ui/glyphs';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { truncateSummaryToWidth } from '@cli/runtime/terminalText';
import {
  WORKFLOW_TASK_STATUS_LABEL,
  isTerminalWorkflowCallProgress,
  runIdentityDisplayName,
  type StreamTabId,
  type TokenUsageStats,
  type WorkflowCallProgress,
  type WorkflowControlAction,
} from '@shared/schemas';
import {
  formatWorkflowCallMetadataParts,
  formatWorkflowPhaseHeading,
  workflowCallTally,
} from '@shared/copy/workflowCall';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import { filterNotNullish, formatCompactTokenCount } from '@utils/core';
import {
  formatCompactDuration,
  formatCostUsd,
  formatResultCount,
} from '@utils/text/stringUtils';

// Local imports - TUI rendering
import { formatCliStatusLabel } from '../sessionStatus';
import { WORKFLOW_TASK_STATUS_STYLE } from './transcriptEntryLayout';

// Local imports - TUI state and controls
import { childElapsed } from '../state/childControls';
import {
  sessionStateRevision,
  streamMetadataFor,
  streamStateFor,
} from '../state/childExecutions';
import {
  readStreamArtifacts,
  streamArtifactRevision,
} from '../state/subscribeStreamArtifacts';
import {
  childListStreamId,
  childStreamListValue,
  workflowTaskListValue,
  type ChildListValue,
} from '../state/childListSelection';
import {
  uniqueWorkflowChildStreamId,
  workflowDashboardSelection,
  type WorkflowDashboardModel,
  type WorkflowPhaseGroup,
  type WorkflowTaskEntry,
} from '../state/workflowDashboardModel';

import {
  CHILD_ROW_METADATA_MIN_COLUMNS,
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  childStatusColor,
  dashboardMarkerCell,
  pendingApprovalRowDisplay,
  workflowPhaseStatusStrip,
  workflowPhaseTallyText,
} from './SubagentListDisplay';
import { useSignal } from '../state/useSignal';
import { streamPhaseFor, type StreamSlice } from '../state/cliState';
import type { PendingApprovalKind } from '../state/approvalQueue';
import type { StreamView } from '../state/streamViews';

const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

/** Emphasis a row segment inherits from its host row: the dashboard heading
 *  renders bold and warning-colored, plain rows do neither. */
interface SegmentStyle {
  readonly bold?: boolean;
  readonly color?: string;
}

/** One inline segment of a single-line row: a cell that may shrink to nothing
 *  and truncates rather than wrapping. `flexShrink` carries the significance
 *  order — higher numbers yield first as the row narrows. */
function RowSegment({
  bold,
  children,
  color,
  dimColor,
  flexShrink,
}: SegmentStyle & {
  readonly children: React.ReactNode;
  readonly dimColor?: boolean;
  readonly flexShrink: number;
}): React.JSX.Element {
  return (
    <Box minWidth={0} flexShrink={flexShrink}>
      <Text bold={bold} color={color} dimColor={dimColor} wrap="truncate-end">
        {children}
      </Text>
    </Box>
  );
}

/** The ` · <kind>` pending-approval suffix shared by session rows, workflow
 *  task rows, and the dashboard heading. The kind is actionable so it never
 *  shrinks; the overflow count is informational and yields early. */
function ApprovalSegments({
  approval,
  bold,
  color,
}: SegmentStyle & {
  readonly approval: ReturnType<typeof pendingApprovalRowDisplay>;
}): React.JSX.Element | null {
  if (!approval) return null;
  return (
    <>
      <Box flexShrink={0}>
        <Text bold={bold} color={color}>{` · ${approval.label}`}</Text>
      </Box>
      {approval.overflow ? (
        <RowSegment bold={bold} color={color} flexShrink={3}>
          {` ${approval.overflow}`}
        </RowSegment>
      ) : null}
    </>
  );
}

/**
 * One phase row of the dashboard, in both layouts: name, the phase's own
 * `done/total · N running · N failed`, and one glyph per issued call — the
 * same three things the progress view's phase header shows, folded from the
 * same call cards. The tally reads as the phase because the phase names it;
 * the panel heading's tally reads as the run for the same reason.
 *
 * The marker cell is shared with the task rows, so a phase and the tasks under
 * it start their text in the same screen column whether or not the row is
 * focused.
 */
function PhaseHeader({
  group,
  focused = false,
  showStatusStrip,
}: {
  readonly group: WorkflowPhaseGroup;
  readonly focused?: boolean;
  /** The strip is the phase row's own account of its calls, so it belongs to
   *  the full-width list. The two-column layout paints one marker per call in
   *  the task column beside it and gives the narrow phase column to the name. */
  readonly showStatusStrip: boolean;
}): React.JSX.Element {
  const calls = group.tasks.map((entry) => entry.call);
  const strip = showStatusStrip ? workflowPhaseStatusStrip(calls) : undefined;
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      height={1}
      minWidth={0}
      overflowY="hidden"
    >
      {/* One rigid gutter: Ink trims leading whitespace off a row it has to
          wrap, so the pointer and marker only keep their columns while they
          sit in a box that never shrinks. */}
      <Box flexShrink={0}>
        <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
          {focused ? POINTER : ' '}
        </Text>
        <Text aria-hidden dimColor>
          {dashboardMarkerCell(STATUS_DIAMOND)}
        </Text>
      </Box>
      <Box minWidth={0} flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {formatWorkflowPhaseHeading(group.heading)}
        </Text>
      </Box>
      <Box minWidth={0} flexShrink={2}>
        <Text dimColor wrap="truncate-end">
          {` · ${workflowPhaseTallyText(calls)}`}
        </Text>
      </Box>
      {strip ? (
        <Box minWidth={0} flexShrink={3}>
          <Text dimColor wrap="truncate-end">{` ${strip}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SessionRow({
  active,
  cumulativeUsage,
  focused,
  hiddenRowSummary,
  isListRoot,
  metadataColumn,
  nowMs,
  pendingKinds,
  session,
}: {
  readonly active: boolean;
  readonly cumulativeUsage?: TokenUsageStats | undefined;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly isListRoot: boolean;
  readonly metadataColumn: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly session: StreamView;
}): React.JSX.Element {
  useSignal(sessionStateRevision);
  const metadata = streamMetadataFor(session.id);
  const streamState = streamStateFor(session.id);
  const phase = streamPhaseFor(session.id);
  const status = phase?.phase;
  const statusLabel = formatCliStatusLabel(
    status,
    phase?.substate,
    session.parentId !== undefined,
  );
  const elapsed = childElapsed(
    { status, startedAt: phase?.runStartedAt },
    nowMs,
  );
  // Significance order — informational counts shed first, then the summary,
  // then this truncate-end text sheds inline elapsed, model, stage, and label.
  // The actionable approval kind and metadata column never shrink.
  const approval = pendingApprovalRowDisplay(pendingKinds);
  const stageLabel = formatStageLabel(streamState?.stage);
  // The resolved model is per-agent identity (a workflow run's grandchildren
  // can each resolve a different model); the list-root row is the conversation
  // itself, whose model already rides the status bar. `buildStreamTabInfo`
  // already leaves `modelLabel` unset for a process stream (a shell uses no
  // model) and for a config whose model has not resolved.
  const modelLabel = isListRoot ? undefined : session.info?.modelLabel;
  // The right-aligned `elapsed · ↓tokens` column is pushed to the terminal edge
  // so the figures line up across rows. Lower-priority inline segments yield;
  // rows drop the column entirely on narrow terminals (see
  // `CHILD_ROW_METADATA_MIN_COLUMNS`).
  const metadataText = metadataColumn
    ? childRowMetadataText({
        elapsed,
        outputTokens: cumulativeUsage?.outputTokens,
        toolCallCount: streamState?.conversationProgress.toolCallCount,
      })
    : undefined;
  // Child rows summarize what the subagent is doing: the runtime's own
  // description (delegated task, or the generated session one-liner) when it
  // has one, otherwise the latest transcript line as live status. The
  // list-root row is the conversation itself — echoing its own last exchange
  // there is noise (and the root can itself be a nested subagent when focus
  // is scoped).
  const summary = isListRoot
    ? undefined
    : (metadata?.description ?? session.slice?.latestLine);
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      height={1}
      minWidth={0}
      overflowY="hidden"
    >
      <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
        {focused ? POINTER : ' '}
      </Text>
      <Text aria-hidden color={active ? COLOR_HINT : undefined}>
        {active ? ` ${TICK} ` : '   '}
      </Text>
      <Text aria-hidden color={childStatusColor(status)}>
        {CHILD_STATUS_MARKER}
      </Text>
      <RowSegment bold={active} flexShrink={1}>
        {session.label}
        {statusLabel ? ` ${statusLabel}` : ''}
        {stageLabel ? ` · ${stageLabel}` : ''}
        {modelLabel ? ` · ${modelLabel}` : ''}
        {!metadataColumn && elapsed ? ` · ${elapsed}` : ''}
      </RowSegment>
      {summary ? (
        <RowSegment dimColor flexShrink={2}>
          {` · ${truncateSummaryToWidth(summary, SUBAGENT_SUMMARY_MAX_COLUMNS)}`}
        </RowSegment>
      ) : null}
      <ApprovalSegments approval={approval} />
      {focused && hiddenRowSummary ? (
        <RowSegment dimColor flexShrink={4}>
          {` · ${hiddenRowSummary}`}
        </RowSegment>
      ) : null}
      {metadataText ? (
        <>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Text dimColor>{`  ${metadataText}`}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  );
}

function workflowTaskMetadata(
  call: WorkflowCallProgress,
  streamId: StreamTabId | undefined,
  nowMs: number,
): string | undefined {
  // The shared parts name the call (kind · agent · model · attempt · files)
  // and, once it settles, what it cost; the live segments below cover the
  // in-flight window the card itself cannot: elapsed, generated tokens, and
  // the running spend read off the child stream.
  const live = !isTerminalWorkflowCallProgress(call);
  const usage = streamId
    ? readStreamArtifacts(streamId)?.cumulativeUsage
    : undefined;
  const runStartedAt = streamPhaseFor(streamId)?.runStartedAt;
  const parts = [
    ...formatWorkflowCallMetadataParts(call),
    live && runStartedAt !== undefined
      ? formatCompactDuration(nowMs - runStartedAt)
      : undefined,
    usage && usage.outputTokens > 0
      ? `${TOKENS_GENERATED}${formatCompactTokenCount(usage.outputTokens)}`
      : undefined,
    live && usage?.cost !== undefined && usage.cost > 0
      ? formatCostUsd(usage.cost)
      : undefined,
  ].filter(filterNotNullish);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function WorkflowTaskRow({
  entry,
  focused,
  nowMs,
  pendingKinds,
  streamId,
}: {
  readonly entry: WorkflowTaskEntry;
  readonly focused: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly streamId: StreamTabId | undefined;
}): React.JSX.Element {
  useSignal(sessionStateRevision);
  const style = WORKFLOW_TASK_STATUS_STYLE[entry.call.status];
  const metadata = workflowTaskMetadata(entry.call, streamId, nowMs);
  const approval = pendingApprovalRowDisplay(pendingKinds);
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
          {focused ? POINTER : ' '}
        </Text>
        <Text aria-hidden color={style.color}>
          {dashboardMarkerCell(style.marker)}
        </Text>
      </Box>
      <RowSegment flexShrink={1}>{entry.call.label}</RowSegment>
      {/* The status word outranks the metadata column: it is its own segment
          at the label's shrink weight, so a wide row sheds metadata (weight 2)
          long before it clips `· Running`, instead of the two sharing one
          truncating box where the status was always the half that was cut. */}
      <RowSegment flexShrink={1}>
        {` · ${WORKFLOW_TASK_STATUS_LABEL[entry.call.status]}`}
      </RowSegment>
      <ApprovalSegments approval={approval} />
      {metadata ? (
        <RowSegment dimColor flexShrink={2}>{`  ${metadata}`}</RowSegment>
      ) : null}
    </Box>
  );
}

function WorkflowDashboard({
  columns,
  keyboardActive,
  maxRows,
  model,
  onCancel,
  onFocusStream,
  onSelectionChange,
  pendingApprovals,
  selectedValue,
  streams,
}: {
  readonly columns: number;
  readonly keyboardActive: boolean;
  readonly maxRows: number | undefined;
  readonly model: WorkflowDashboardModel;
  readonly onCancel: () => void;
  readonly onFocusStream: ((streamId: StreamTabId) => void) | undefined;
  readonly onSelectionChange: ((value: ChildListValue) => void) | undefined;
  readonly pendingApprovals:
    ReadonlyMap<string, readonly PendingApprovalKind[]> | undefined;
  readonly selectedValue: ChildListValue | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): React.JSX.Element | null {
  useSignal(sessionStateRevision);
  const { groups, tasks, taskByValue, groupByValue, wide } = model;
  const { selectedGroup, selectedTask, selectedTaskGroup, activeGroup } =
    workflowDashboardSelection(model, selectedValue);
  const uniqueChildId = (entry: WorkflowTaskEntry): StreamTabId | undefined =>
    uniqueWorkflowChildStreamId(entry, model.childTaskIndex, streams);
  const nowMs = useLiveNowMsSince(
    tasks.map((entry) => streamPhaseFor(uniqueChildId(entry))?.runStartedAt),
  );
  const phaseItems: SelectItem<ChildListValue>[] = groups.map((group) => ({
    label: group.heading.phaseLabel,
    value: group.value,
  }));
  const taskItems: SelectItem<ChildListValue>[] = (
    activeGroup?.tasks ?? []
  ).map((entry) => ({
    label: entry.call.label,
    value: workflowTaskListValue(entry.id),
  }));
  const narrowItems: SelectItem<ChildListValue>[] = groups.flatMap((group) => [
    {
      label: group.heading.phaseLabel,
      value: group.value,
      disabled: group.tasks.length > 0,
    },
    ...group.tasks.map((entry) => ({
      label: entry.call.label,
      value: workflowTaskListValue(entry.id),
    })),
  ]);
  const calls = tasks.map((entry) => entry.call);
  const { done, total, running, failed } = workflowCallTally(calls);
  const contentRows =
    maxRows === undefined ? undefined : Math.max(0, maxRows - 2);

  const selectTask = (value: ChildListValue): void => {
    const entry = taskByValue.get(value);
    if (!entry) return;
    const childStreamId = uniqueChildId(entry);
    if (childStreamId !== undefined) onFocusStream?.(childStreamId);
  };
  const enterPhase = (value: ChildListValue): void => {
    const firstTask = groupByValue.get(value)?.tasks[0];
    if (firstTask) onSelectionChange?.(workflowTaskListValue(firstTask.id));
  };

  useInput(
    (_input, key) => {
      if (!wide || key.ctrl || key.meta) return;
      if (key.rightArrow && selectedGroup) {
        enterPhase(selectedGroup.value);
      } else if (key.leftArrow && selectedTaskGroup) {
        onSelectionChange?.(selectedTaskGroup.value);
      }
    },
    { isActive: keyboardActive },
  );

  const sessionApproval = pendingApprovalRowDisplay(
    pendingApprovals?.get(model.root.streamId),
  );
  const approvalOnlyDashboard =
    tasks.length === 0 && groups.length === 0 && sessionApproval !== undefined;
  if (
    (tasks.length === 0 &&
      groups.length === 0 &&
      sessionApproval === undefined) ||
    (contentRows !== undefined && contentRows <= 0 && !approvalOnlyDashboard)
  ) {
    return null;
  }
  // The heading leads with the run identity's display name — for a
  // multi-agent workflow root that is the workflow name, matching what the
  // retired slice `agent` field carried from `run.config`. Its tally is the
  // whole run's; each phase row carries its own, so the two numbers on screen
  // are never the same number twice.
  const rootIdentity = streamMetadataFor(model.root.streamId)?.identity;
  const rootAgent = rootIdentity
    ? runIdentityDisplayName(rootIdentity)
    : undefined;
  const heading = `${rootAgent ?? 'Workflow'} · ${done}/${total}`;
  const renderTask = (
    item: SelectItem<ChildListValue>,
    state: { readonly focused: boolean },
  ): React.JSX.Element | null => {
    const entry = taskByValue.get(item.value);
    if (!entry) return null;
    const childStreamId = uniqueChildId(entry);
    return (
      <WorkflowTaskRow
        entry={entry}
        focused={state.focused}
        nowMs={nowMs}
        streamId={childStreamId}
        pendingKinds={
          childStreamId === undefined
            ? undefined
            : pendingApprovals?.get(childStreamId)
        }
      />
    );
  };
  const renderPhase = (
    item: SelectItem<ChildListValue>,
    state: { readonly focused: boolean },
  ): React.JSX.Element | null => {
    const group = groupByValue.get(item.value);
    return group ? (
      <PhaseHeader
        group={group}
        focused={state.focused}
        showStatusStrip={!wide}
      />
    ) : null;
  };
  const selectProps = {
    hotkeys: false,
    maxVisibleItems: contentRows,
    onCancel,
    wrap: false,
  } as const;

  return (
    <Box
      flexDirection="column"
      height={maxRows === undefined ? undefined : Math.max(0, maxRows - 1)}
      marginTop={1}
      paddingX={1}
      width={columns}
    >
      <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
        <RowSegment bold flexShrink={1}>
          {heading}
        </RowSegment>
        {running > 0 ? (
          <RowSegment dimColor flexShrink={2}>
            {` · ${running} running`}
          </RowSegment>
        ) : null}
        {failed > 0 ? (
          // A pending approval needs action, so this tally yields before the
          // fixed approval suffix when the two cannot both fit.
          <RowSegment bold color={COLOR_WARNING} flexShrink={2}>
            {` · ${failed} failed`}
          </RowSegment>
        ) : null}
        <ApprovalSegments
          approval={sessionApproval}
          bold
          color={COLOR_WARNING}
        />
      </Box>
      {wide ? (
        <Box flexDirection="row" height={contentRows} minWidth={0}>
          <Box flexDirection="column" width="36%" paddingRight={1}>
            <Select
              {...selectProps}
              isActive={keyboardActive && selectedTask === undefined}
              highlightedValue={selectedGroup ? (selectedValue ?? null) : null}
              items={phaseItems}
              onHighlightChange={(value) => onSelectionChange?.(value)}
              onSelect={enterPhase}
              renderItem={renderPhase}
            />
          </Box>
          <Box flexDirection="column" minWidth={0} width="64%">
            <Select
              {...selectProps}
              isActive={keyboardActive && selectedTask !== undefined}
              highlightedValue={selectedTask ? (selectedValue ?? null) : null}
              items={taskItems}
              onHighlightChange={(value) => onSelectionChange?.(value)}
              onSelect={selectTask}
              renderItem={renderTask}
            />
          </Box>
        </Box>
      ) : (
        <Select
          {...selectProps}
          isActive={keyboardActive}
          highlightedValue={selectedValue ?? null}
          items={narrowItems}
          onHighlightChange={(value) => onSelectionChange?.(value)}
          onSelect={selectTask}
          renderItem={(item, state) =>
            renderPhase(item, state) ?? renderTask(item, state)
          }
        />
      )}
    </Box>
  );
}

/** The workflow control each key press requests, so the handler holds no ladder. */
const WORKFLOW_CONTROL_KEYS = {
  s: 'skip',
  r: 'retry',
} as const satisfies Record<string, WorkflowControlAction>;

export interface SubagentListProps {
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamTabId) => void;
  readonly onKillExecution?: (executionId: string) => void;
  /** Skip or retry the focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onWorkflowControl?: (
    executionId: string,
    action: WorkflowControlAction,
  ) => void;
  readonly onSelectionChange?: (value: ChildListValue) => void;
  /**
   * Pending approval kinds per stream id (see `pendingApprovalSummaries`; the
   * caller folds stream-less approvals onto the visible surface root via
   * `groupPendingApprovalsByRow`).
   *
   * When `dashboard` is present, per-task buckets render on their task rows and
   * the root-folded stream-less bucket renders in the dashboard heading.
   * Stream-bound plan, proposal, and retry approvals remain keyed to their
   * actual owning stream. The queue remains the authority for approval
   * identity and order; this map only projects that state onto the rows which
   * present it.
   */
  readonly pendingApprovals?: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
  readonly selectedValue?: ChildListValue;
  readonly sessions?: readonly StreamView[];
  readonly streams?: ReadonlyMap<StreamTabId, StreamSlice>;
  /** Dashboard rows for a workflow-script list root, derived once by `App`
   *  (see `state/workflowDashboardModel`). Present iff the dashboard replaces
   *  the plain session list. */
  readonly dashboard?: WorkflowDashboardModel;
  /** Stream `selectedValue` points at, resolved once by `App` — the same
   *  stream the status bar advertises as killable. */
  readonly selectedChildStreamId?: StreamTabId;
  /** Whether `selectedChildStreamId` is a skip/retry-able workflow-script
   *  grandchild, resolved once by `App` alongside the status bar's hint. */
  readonly selectedChildWorkflowControllable?: boolean;
  /** Stream the list is rooted on — its row never shows a summary. */
  readonly listRootStreamId?: StreamTabId;
  readonly activeSubagentExecutionIds?: ReadonlyMap<StreamTabId, string>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const sessions = props.sessions ?? [];
  useSignal(streamArtifactRevision);
  const startedAts = useMemo(
    () => sessions.map((session) => streamPhaseFor(session.id)?.runStartedAt),
    [sessions],
  );
  const { items, sessionsByValue } = useMemo(() => {
    const nextItems: SelectItem<ChildListValue>[] = [];
    const byValue = new Map<ChildListValue, StreamView>();
    // Row order has one owner, `streamTreeEntries`: do not re-sort here, it
    // would desynchronise the Alt+1..9 numbers it assigns from the rows on
    // screen.
    for (const session of sessions) {
      const value = childStreamListValue(session.id);
      nextItems.push({ label: session.label, value });
      byValue.set(value, session);
    }
    return { items: nextItems, sessionsByValue: byValue };
  }, [sessions]);
  const nowMs = useLiveNowMsSince(startedAts);
  const { columns } = useWindowSize();
  const metadataColumn = columns >= CHILD_ROW_METADATA_MIN_COLUMNS;
  const dashboard = props.dashboard;
  const contentRows =
    props.maxRows === undefined ? undefined : Math.max(0, props.maxRows - 1);
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      const streamId = props.selectedChildStreamId;
      if (!streamId) return;
      const pressed = input.toLowerCase();
      if (pressed !== 'k' && pressed !== 's' && pressed !== 'r') return;
      const executionId = props.activeSubagentExecutionIds?.get(streamId);
      if (!executionId) return;
      if (pressed === 'k') props.onKillExecution?.(executionId);
      // Skip/retry fire only where the status bar advertises them.
      else if (props.selectedChildWorkflowControllable)
        props.onWorkflowControl?.(executionId, WORKFLOW_CONTROL_KEYS[pressed]);
    },
    { isActive: props.keyboardActive ?? false },
  );

  if (dashboard) {
    return (
      <WorkflowDashboard
        columns={columns}
        keyboardActive={props.keyboardActive ?? false}
        maxRows={props.maxRows}
        model={dashboard}
        onCancel={props.onCancel ?? (() => undefined)}
        onFocusStream={props.onFocusStream}
        onSelectionChange={props.onSelectionChange}
        pendingApprovals={props.pendingApprovals}
        selectedValue={props.selectedValue}
        streams={props.streams ?? new Map()}
      />
    );
  }

  if (items.length === 0) return null;
  // The list is deliberately separated from the input/status chrome by one
  // blank row. If the gap and one content row do not both fit, render nothing.
  if (contentRows !== undefined && contentRows <= 0) return null;
  const activeSession = sessions.find((session) => session.active);

  return (
    <Box
      flexDirection="column"
      height={contentRows}
      marginTop={1}
      overflowY={contentRows === undefined ? undefined : 'hidden'}
      paddingX={1}
      // Pin the panel to the terminal width so rows stretch and the trailing
      // metadata column right-aligns; without it the panel is content-sized.
      width={metadataColumn ? columns : undefined}
    >
      <Select
        activeValue={
          activeSession ? childStreamListValue(activeSession.id) : undefined
        }
        highlightedValue={props.selectedValue ?? null}
        hotkeys={false}
        isActive={props.keyboardActive}
        items={items}
        maxVisibleItems={contentRows}
        onCancel={props.onCancel ?? (() => undefined)}
        // This panel is a standalone focus target, not a cyclic menu: arrows
        // clamp at the first/last selectable stream row. Tab explicitly hands
        // keyboard ownership back to the input at the App level.
        wrap={false}
        onHighlightChange={(value) => props.onSelectionChange?.(value)}
        onSelect={(value) => {
          const streamId = childListStreamId(value);
          if (streamId) props.onFocusStream?.(streamId);
        }}
        renderItem={(item, state) => {
          const session = sessionsByValue.get(item.value);
          return session ? (
            <SessionRow
              isListRoot={session.id === props.listRootStreamId}
              active={state.active}
              cumulativeUsage={readStreamArtifacts(session.id)?.cumulativeUsage}
              focused={state.focused}
              hiddenRowSummary={
                state.hiddenItemCount > 0
                  ? `+${formatResultCount(state.hiddenItemCount, 'agent')}`
                  : undefined
              }
              metadataColumn={metadataColumn}
              nowMs={nowMs}
              pendingKinds={props.pendingApprovals?.get(session.id)}
              session={session}
            />
          ) : null;
        }}
      />
    </Box>
  );
}
