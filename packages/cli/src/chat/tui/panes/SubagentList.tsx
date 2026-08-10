// Persistent child-session list.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import { COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  POINTER,
  STATUS_DIAMOND,
  TICK,
  TOKENS_GENERATED,
} from '@cli/tui/ui/glyphs';
import {
  Select,
  visibleSelectRange,
  type SelectItem,
} from '@cli/tui/ui/Select';
import {
  AgentCategory,
  WORKFLOW_TASK_STATUS_LABEL,
  isTerminalWorkflowCallProgress,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import {
  formatWorkflowPhaseHeading,
  workflowCallFailureTally,
  workflowPhaseCallProgress,
  type WorkflowPhaseHeading,
} from '@shared/copy/workflowCall';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import { formatCompactTokenCount } from '@utils/core';
import {
  formatCompactDuration,
  formatCostUsd,
  formatResultCount,
} from '@utils/text/stringUtils';

// Local imports - TUI rendering
import { truncateSummaryToWidth } from '../render/terminalText';
import { formatCliStatusLabel } from '../sessionStatus';
import { WORKFLOW_TASK_STATUS_STYLE } from './transcriptEntryLayout';

// Local imports - TUI state and controls
import { childElapsed } from '../state/childControls';
import {
  childListStreamId,
  childPhaseListValue,
  childStreamListValue,
  workflowTaskListValue,
  type ChildListValue,
} from '../state/childListSelection';
import { useLiveNowMs } from '../state/useLiveNowMs';
import {
  uniqueWorkflowChildStreamId,
  workflowDashboardModel,
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
  pendingApprovalRowSuffix,
} from './SubagentListDisplay';
import type { PendingApprovalKind } from '../state/approvalQueue';
import type { StreamSlice } from '../state/cliState';
import type { StreamView } from '../state/streamViews';

function HiddenRowSummary({
  text,
}: {
  readonly text: string | undefined;
}): React.JSX.Element | null {
  return text ? (
    <Box flexShrink={0}>
      <Text dimColor>{` · ${text}`}</Text>
    </Box>
  ) : null;
}

/** Right-aligned `elapsed · ↓tokens` column, pushed to the terminal edge so
 *  the figures line up across rows. Non-shrinking: the summary segment yields
 *  first; rows drop the column entirely on narrow terminals (see
 *  `CHILD_ROW_METADATA_MIN_COLUMNS`). */
function RowMetadata({
  text,
}: {
  readonly text: string | undefined;
}): React.JSX.Element | null {
  return text ? (
    <>
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <Text dimColor>{`  ${text}`}</Text>
      </Box>
    </>
  ) : null;
}

const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

interface PhaseHeaderDetails extends WorkflowPhaseHeading {
  readonly progress?: string;
}

function PhaseHeader({
  details,
  metadataColumn,
}: {
  readonly details: PhaseHeaderDetails;
  readonly metadataColumn: boolean;
}): React.JSX.Element {
  const inlineProgress =
    !metadataColumn && details.progress ? ` · ${details.progress}` : '';
  return (
    <Box flexDirection="row" flexGrow={1} minWidth={0}>
      <Box minWidth={0} flexShrink={1}>
        <Text dimColor>{'    '}</Text>
        <Text aria-hidden dimColor>{`${STATUS_DIAMOND} `}</Text>
        <Text dimColor wrap="truncate-end">
          {`${formatWorkflowPhaseHeading(details)}${inlineProgress}`}
        </Text>
      </Box>
      {metadataColumn && details.progress ? (
        <>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Text dimColor>{`  ${details.progress}`}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  );
}

function SessionRow({
  active,
  focused,
  hiddenRowSummary,
  isListRoot,
  metadataColumn,
  nowMs,
  pendingKinds,
  session,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly isListRoot: boolean;
  readonly metadataColumn: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly session: StreamView;
}): React.JSX.Element {
  const status = session.slice?.status;
  const substate = session.slice?.substate;
  const statusLabel = formatCliStatusLabel(
    status,
    substate,
    session.parentId !== undefined,
  );
  const elapsed = childElapsed(
    {
      status,
      startedAt: session.slice?.runStartedAt,
    },
    nowMs,
  );
  // Significance order — the summary segment sheds first (flexShrink 2), then
  // this truncate-end text sheds inline elapsed (narrow mode only), the round,
  // and last the pending-approval kind. The metadata column never shrinks.
  const approvalSuffix = pendingApprovalRowSuffix(pendingKinds);
  const stageLabel = formatStageLabel(session.slice?.stage);
  // The resolved model is per-agent identity (a workflow run's grandchildren
  // can each resolve a different model); the list-root row is the conversation
  // itself, whose model already rides the status bar. A background bash stream
  // inherits its parent's configuration, but the shell does not use a model.
  const modelLabel =
    !isListRoot && session.slice?.identity?.kind !== 'process'
      ? session.slice?.model
      : undefined;
  const metadata = metadataColumn
    ? childRowMetadataText({
        elapsed,
        outputTokens: (session.slice?.cumulativeUsage ?? session.slice?.usage)
          ?.outputTokens,
        toolCallCount: session.slice?.conversation?.toolCallCount,
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
    : (session.slice?.description ?? session.slice?.latestLine);
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
      <Box minWidth={0} flexShrink={1}>
        <Text bold={active} wrap="truncate-end">
          {session.label}
          {statusLabel ? ` ${statusLabel}` : ''}
          {approvalSuffix ? ` · ${approvalSuffix}` : ''}
          {stageLabel ? ` · ${stageLabel}` : ''}
          {modelLabel ? ` · ${modelLabel}` : ''}
          {!metadataColumn && elapsed ? ` · ${elapsed}` : ''}
        </Text>
      </Box>
      {summary ? (
        <Box minWidth={0} flexShrink={2}>
          <Text dimColor wrap="truncate-end">
            {` · ${truncateSummaryToWidth(summary, SUBAGENT_SUMMARY_MAX_COLUMNS)}`}
          </Text>
        </Box>
      ) : null}
      {focused ? <HiddenRowSummary text={hiddenRowSummary} /> : null}
      <RowMetadata text={metadata} />
    </Box>
  );
}

/** Number of content rows the dashboard can display at the current width. */
export function workflowDashboardPanelItemCount(
  root: StreamSlice,
  selectedValue: ChildListValue | undefined,
  columns: number,
): number {
  const model = workflowDashboardModel(root, columns);
  if (model.tasks.length === 0) return 0;
  if (!model.wide) {
    return 1 + model.groups.length + model.tasks.length;
  }
  const { activeGroup } = workflowDashboardSelection(model, selectedValue);
  return 1 + Math.max(model.groups.length, activeGroup?.tasks.length ?? 0);
}

function workflowTaskMetadata(
  call: WorkflowCallProgress,
  child: StreamSlice | undefined,
  nowMs: number,
): string | undefined {
  const terminal = isTerminalWorkflowCallProgress(call);
  const usage = child?.cumulativeUsage ?? child?.usage;
  let elapsed: string | undefined;
  let model: string | undefined;
  let cost: number | undefined;
  if (terminal) {
    if ('durationMs' in call && call.durationMs !== undefined) {
      elapsed = formatCompactDuration(call.durationMs);
    }
    model = ('model' in call ? call.model : undefined) ?? child?.model;
    cost =
      ('totalCostUsd' in call ? call.totalCostUsd : undefined) ?? usage?.cost;
  } else {
    if (child?.runStartedAt !== undefined) {
      elapsed = formatCompactDuration(nowMs - child.runStartedAt);
    }
    model = child?.model;
    cost = usage?.cost;
  }
  const parts = [
    model,
    elapsed,
    usage && usage.outputTokens > 0
      ? `${TOKENS_GENERATED}${formatCompactTokenCount(usage.outputTokens)}`
      : undefined,
    cost !== undefined && cost > 0 ? formatCostUsd(cost) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function WorkflowTaskRow({
  child,
  entry,
  focused,
  nowMs,
}: {
  readonly child: StreamSlice | undefined;
  readonly entry: WorkflowTaskEntry;
  readonly focused: boolean;
  readonly nowMs: number;
}): React.JSX.Element {
  const style = WORKFLOW_TASK_STATUS_STYLE[entry.task.status];
  const metadata = workflowTaskMetadata(entry.task, child, nowMs);
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
        {focused ? POINTER : ' '}
      </Text>
      <Text aria-hidden color={style.color}>{` ${style.marker} `}</Text>
      <Box minWidth={0} flexShrink={1}>
        <Text wrap="truncate-end">
          {entry.task.label} · {WORKFLOW_TASK_STATUS_LABEL[entry.task.status]}
        </Text>
      </Box>
      {metadata ? (
        <Box minWidth={0} flexShrink={2}>
          <Text dimColor wrap="truncate-end">{`  ${metadata}`}</Text>
        </Box>
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
  readonly selectedValue: ChildListValue | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): React.JSX.Element | null {
  const { groups, tasks, taskByValue, groupByValue, wide } = model;
  const { selectedGroup, selectedTask, selectedTaskGroup, activeGroup } =
    workflowDashboardSelection(model, selectedValue);
  const uniqueChildId = (entry: WorkflowTaskEntry): StreamTabId | undefined =>
    uniqueWorkflowChildStreamId(entry, model.childTaskIndex, streams);
  const liveElapsedKey = tasks
    .map((entry) => {
      const childStreamId = uniqueChildId(entry);
      return childStreamId === undefined
        ? undefined
        : streams.get(childStreamId)?.runStartedAt;
    })
    .filter((startedAt): startedAt is number => startedAt !== undefined)
    .join(':');
  const nowMs = useLiveNowMs(liveElapsedKey.length > 0, liveElapsedKey);
  const phaseItems: SelectItem<ChildListValue>[] = groups.map((group) => ({
    label: group.label,
    value: group.value,
  }));
  const taskItems: SelectItem<ChildListValue>[] = (
    activeGroup?.tasks ?? []
  ).map((entry) => ({
    label: entry.task.label,
    value: workflowTaskListValue(entry.id),
  }));
  const narrowItems: SelectItem<ChildListValue>[] = groups.flatMap((group) => [
    { label: group.label, value: group.value, disabled: true },
    ...group.tasks.map((entry) => ({
      label: entry.task.label,
      value: workflowTaskListValue(entry.id),
    })),
  ]);
  const calls = tasks.map((entry) => entry.task);
  const { done, total } = workflowPhaseCallProgress(calls);
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

  if (tasks.length === 0 || (contentRows !== undefined && contentRows <= 0)) {
    return null;
  }
  const heading = `${model.root.agent ?? 'Workflow'} · ${done}/${total} done`;
  const { failed } = workflowCallFailureTally(calls);
  const renderTask = (
    item: SelectItem<ChildListValue>,
    state: { readonly focused: boolean },
  ): React.JSX.Element | null => {
    const entry = taskByValue.get(item.value);
    if (!entry) return null;
    const childStreamId = uniqueChildId(entry);
    return (
      <WorkflowTaskRow
        child={
          childStreamId === undefined ? undefined : streams.get(childStreamId)
        }
        entry={entry}
        focused={state.focused}
        nowMs={nowMs}
      />
    );
  };
  const groupDetails = (group: WorkflowPhaseGroup): PhaseHeaderDetails => {
    const progress = workflowPhaseCallProgress(
      group.tasks.map((entry) => entry.task),
    );
    return {
      phaseLabel: group.label,
      ...(group.heading?.phaseIndex !== undefined
        ? { phaseIndex: group.heading.phaseIndex }
        : {}),
      ...(group.heading?.phaseTotal !== undefined
        ? { phaseTotal: group.heading.phaseTotal }
        : {}),
      progress: `${progress.done}/${progress.total}`,
    };
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
      <Text bold wrap="truncate-end">
        {heading}
        {failed > 0 ? (
          <Text bold color={COLOR_WARNING}>{` · ${failed} failed`}</Text>
        ) : null}
      </Text>
      {wide ? (
        <Box flexDirection="row" height={contentRows} minWidth={0}>
          <Box flexDirection="column" width="32%" paddingRight={1}>
            <Select
              {...selectProps}
              isActive={keyboardActive && selectedTask === undefined}
              highlightedValue={selectedGroup ? (selectedValue ?? null) : null}
              items={phaseItems}
              onHighlightChange={(value) => onSelectionChange?.(value)}
              onSelect={enterPhase}
              renderItem={(item, state) => {
                const group = groupByValue.get(item.value);
                if (!group) return null;
                const details = groupDetails(group);
                return (
                  <Box minWidth={0}>
                    <Text aria-hidden>{state.focused ? POINTER : ' '}</Text>
                    <Text wrap="truncate-end">
                      {' '}
                      {formatWorkflowPhaseHeading(details)} · {details.progress}
                    </Text>
                  </Box>
                );
              }}
            />
          </Box>
          <Box flexDirection="column" minWidth={0} width="68%">
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
          renderItem={(item, state) => {
            const group = groupByValue.get(item.value);
            return group ? (
              <PhaseHeader
                details={groupDetails(group)}
                metadataColumn={false}
              />
            ) : (
              renderTask(item, state)
            );
          }}
        />
      )}
    </Box>
  );
}

export interface SubagentListProps {
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamTabId) => void;
  readonly onKillExecution?: (executionId: string) => void;
  /** Skip the focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onSkipExecution?: (executionId: string) => void;
  /** Retry the focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onRetryExecution?: (executionId: string) => void;
  readonly onSelectionChange?: (value: ChildListValue) => void;
  /** Pending approval kinds per stream id (see `pendingApprovalSummaries`,
   *  root bucket already folded onto the root stream id by the caller). */
  readonly pendingApprovals?: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
  readonly selectedValue?: ChildListValue;
  readonly sessions?: readonly StreamView[];
  readonly streams?: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly listRootSlice?: StreamSlice;
  /** Stream the list is rooted on — its row never shows a summary. */
  readonly listRootStreamId?: StreamTabId;
  readonly activeSubagentExecutionIds?: ReadonlyMap<StreamTabId, string>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const sessions = props.sessions ?? [];
  const liveElapsedKey = useMemo(
    () =>
      sessions
        .map((session) => session.slice?.runStartedAt)
        .filter((startedAt): startedAt is number => startedAt !== undefined)
        .join(':') || undefined,
    [sessions],
  );
  const { items, phaseHeadersByValue } = useMemo(() => {
    const entries =
      props.listRootSlice?.category === AgentCategory.Workflow
        ? props.listRootSlice.entries
        : [];
    const phaseHeadings = new Map<string, WorkflowPhaseHeading>();
    const callsByPhase = new Map<string, WorkflowCallProgress[]>();
    for (const entry of entries) {
      if (entry.role === 'phase') {
        phaseHeadings.set(entry.phaseLabel, {
          phaseLabel: entry.phaseLabel,
          phaseIndex: entry.phaseIndex,
          phaseTotal: entry.phaseTotal,
        });
      } else if (
        entry.role === 'workflowTask' &&
        entry.task.phase !== undefined
      ) {
        const calls = callsByPhase.get(entry.task.phase);
        if (calls) calls.push(entry.task);
        else callsByPhase.set(entry.task.phase, [entry.task]);
      }
    }

    const nextItems: SelectItem<ChildListValue>[] = [];
    const nextHeaders = new Map<ChildListValue, PhaseHeaderDetails>();
    // A header only ever *opens* a group; nothing closes one. That is sound
    // only because `sessions` arrives from `streamTreeViews`, whose
    // `groupWorkflowPhaseEntries` makes same-phase rows contiguous and puts
    // every phase-less row ahead of the first group — so no row can land under
    // a header it does not belong to, and no phase can open a second header.
    // Order has one owner: do not re-sort here, it would desynchronise the
    // Alt+1..9 numbers `streamTreeEntries` assigns from the rows on screen.
    let previousPhase: string | undefined;
    let headerOrdinal = 0;
    for (const session of sessions) {
      const item = {
        label: session.label,
        value: childStreamListValue(session.id),
      };
      // The list root is context, not a grouped attempt. Every other row
      // already belongs to this root's visible current/retained descendant
      // set, including historical children promoted away from the root.
      if (session.id === props.listRootStreamId) {
        nextItems.push(item);
        continue;
      }
      const phase = session.workflowPhase;
      if (phase !== undefined && phase !== previousPhase) {
        const value = childPhaseListValue(headerOrdinal++);
        const calls = callsByPhase.get(phase) ?? [];
        const { done, total } = workflowPhaseCallProgress(calls);
        nextItems.push({ label: phase, value, disabled: true });
        nextHeaders.set(value, {
          ...(phaseHeadings.get(phase) ?? { phaseLabel: phase }),
          ...(total > 0 ? { progress: `${done}/${total}` } : {}),
        });
      }
      nextItems.push(item);
      previousPhase = phase;
    }
    return { items: nextItems, phaseHeadersByValue: nextHeaders };
  }, [props.listRootSlice, props.listRootStreamId, sessions]);
  const sessionsByValue = useMemo(
    () =>
      new Map(
        sessions.map((session) => [childStreamListValue(session.id), session]),
      ),
    [sessions],
  );
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);
  const { columns } = useWindowSize();
  const metadataColumn = columns >= CHILD_ROW_METADATA_MIN_COLUMNS;
  const workflowRoot =
    props.listRootSlice?.identity?.kind === 'multiAgentWorkflow'
      ? props.listRootSlice
      : undefined;
  // Same derivation `App` reads for selection and focus — see
  // `state/workflowDashboardModel`.
  const dashboard = useMemo(
    () =>
      workflowRoot ? workflowDashboardModel(workflowRoot, columns) : undefined,
    [columns, workflowRoot],
  );
  const contentRows =
    props.maxRows === undefined ? undefined : Math.max(0, props.maxRows - 1);
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.value === props.selectedValue),
  );
  const visibleRange = visibleSelectRange({
    highlight: selectedIndex,
    itemCount: items.length,
    maxVisibleItems: contentRows,
  });
  const visibleValues = new Set(
    items.slice(visibleRange.start, visibleRange.end).map((item) => item.value),
  );
  const hiddenSessionCount = sessions.filter(
    (session) => !visibleValues.has(childStreamListValue(session.id)),
  ).length;
  const hiddenRowSummary =
    hiddenSessionCount > 0
      ? `+${formatResultCount(hiddenSessionCount, 'session')}`
      : undefined;

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      const selectedWorkflowTask =
        props.selectedValue && dashboard
          ? dashboard.taskByValue.get(props.selectedValue)
          : undefined;
      const workflowChildStreamId =
        selectedWorkflowTask && dashboard
          ? uniqueWorkflowChildStreamId(
              selectedWorkflowTask,
              dashboard.childTaskIndex,
              props.streams ?? new Map(),
            )
          : undefined;
      const streamId =
        childListStreamId(props.selectedValue) ?? workflowChildStreamId;
      if (!streamId) return;
      const pressed = input.toLowerCase();
      // Kill/skip/retry target only a focused subagent stream (a
      // workflow-script grandchild); the session control registry no-ops for
      // any execution id that is not an in-flight grandchild, so non-workflow
      // rows are inert.
      if (pressed !== 'k' && pressed !== 's' && pressed !== 'r') return;
      const executionId = props.activeSubagentExecutionIds?.get(streamId);
      if (!executionId) return;
      if (pressed === 'k') props.onKillExecution?.(executionId);
      else if (pressed === 's') props.onSkipExecution?.(executionId);
      else props.onRetryExecution?.(executionId);
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
          const phaseHeader = phaseHeadersByValue.get(item.value);
          if (phaseHeader) {
            return (
              <PhaseHeader
                details={phaseHeader}
                metadataColumn={metadataColumn}
              />
            );
          }
          const session = sessionsByValue.get(item.value);
          return session ? (
            <SessionRow
              isListRoot={session.id === props.listRootStreamId}
              active={state.active}
              focused={state.focused}
              hiddenRowSummary={hiddenRowSummary}
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
