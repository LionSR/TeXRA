// The workflow popup: one phase at a time, attention first, volume collapsed.
//
// A workflow-script run is never a viewport you stand in — its transcript is
// chrome about other streams. This foreground surface (the same mechanics as
// the Ctrl-T reader: row-budgeted, Esc restores the parent untouched) paints
// the shared run model (`@shared/streams/workflowRunModel`): the run's phases
// as tabs and the selected phase's rows — calls that need a decision, then
// calls worth watching, then counted groups that open in place. Every fold is
// the model's; this file only decides how a row looks in a terminal.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - TUI primitives
import { isEscapeInput } from '@cli/tui/inputKeys';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import {
  KEY_HINT_SEPARATOR,
  KeyHints,
  keyHintText,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER, TOKENS_GENERATED } from '@cli/tui/ui/glyphs';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { fillRows, textDisplayWidth } from '@cli/runtime/terminalText';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';

// Local imports - shared schemas, model, and copy
import {
  WORKFLOW_TASK_STATUS_LABEL,
  isTerminalWorkflowCallProgress,
  runIdentityDisplayName,
  type StreamTabId,
  type WorkflowCallIdentity,
  type WorkflowCallProgress,
  type WorkflowControlAction,
} from '@shared/schemas';
import type { WorkflowTaskRow as WorkflowTaskRowModel } from '@shared/transcript';
import {
  WORKFLOW_CALL_STATUS_GLYPH,
  WORKFLOW_PHASE_GLYPH,
  formatWorkflowPhaseHeading,
  formatWorkflowPhaseTally,
  formatWorkflowTally,
} from '@shared/copy/workflowCall';
import {
  workflowPhaseRows,
  type WorkflowPhaseModel,
  type WorkflowPhaseRow,
  type WorkflowRowGroup,
  type WorkflowRunModel,
} from '@shared/streams/workflowRunModel';
import { filterNotNullish, formatCompactTokenCount } from '@utils/core';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

// Local imports - TUI state and policy
import { selectedChildRowWorkflowControllable } from '../appInteractionPolicy';
import { formFrameWidth } from '../forms/_shared/FormFrame';
import { scrollableModalTextRowsBudget } from '../modals/ScrollableModalText';
import {
  sessionStateRevision,
  streamMetadataFor,
} from '../state/childExecutions';
import {
  streamPhaseFor,
  type StreamSlice,
  type WorkflowPopupView,
} from '../state/cliState';
import {
  readStreamArtifacts,
  streamArtifactRevision,
} from '../state/subscribeStreamArtifacts';
import { useSignal } from '../state/useSignal';

// Local imports - sibling panes
import { ApprovalSegments, RowSegment } from './SubagentList';
import { pendingApprovalRowDisplay } from './SubagentListDisplay';
import { WORKFLOW_TASK_STATUS_STYLE } from './transcriptEntryLayout';
import type { PendingApprovalKind } from '../state/approvalQueue';

const GROUP_LABEL = {
  queued: 'queued',
  done: 'done',
  declared: 'declared',
} as const satisfies Record<WorkflowRowGroup, string>;

/** Rows of chrome inside the panel beyond what the shared budget already
 *  counts: the tab strip and the per-call status strip. The filter line adds
 *  one while it shows, and the wrapped key hints add their measured rows. */
const POPUP_CHROME_ROWS = 2;
const TAB_SEPARATOR = '    ';
const TAB_SCROLL_MARK = '‹ ';

/** The three-column marker cell every popup row starts its text after, so a
 *  phase's rows line up whether or not one is focused. A glyph that counts as
 *  two columns takes its own cell instead of shoving the label right. */
function markerCell(marker: string): string {
  return fillRows(` ${marker}`, 3);
}

function phaseTabText(phase: WorkflowPhaseModel): string {
  return `${phase.opened ? WORKFLOW_PHASE_GLYPH.opened : WORKFLOW_PHASE_GLYPH.declared} ${formatWorkflowPhaseHeading(phase.heading)} · ${formatWorkflowPhaseTally(phase)}`;
}

/** First tab to draw so the active one is on screen: walk the window start
 *  forward until the tabs from it through the active one fit the width. */
function tabWindowStart(
  tabs: readonly string[],
  activeIndex: number,
  width: number,
): number {
  const fits = (from: number): boolean => {
    let used = from > 0 ? textDisplayWidth(TAB_SCROLL_MARK) : 0;
    for (let index = from; index <= activeIndex; index++) {
      used +=
        (index > from ? textDisplayWidth(TAB_SEPARATOR) : 0) +
        textDisplayWidth(tabs[index]!);
    }
    return used <= width;
  };
  let start = 0;
  while (start < activeIndex && !fits(start)) start++;
  return start;
}

/** One glyph per card, in issue order. Past `maxCells` the strip ends in a
 *  `+N` count rather than wrapping, so it stays one row at any width. */
function statusStrip(
  cells: readonly WorkflowCallProgress['status'][],
  maxCells: number,
): string {
  const glyph = (status: WorkflowCallProgress['status']): string =>
    WORKFLOW_CALL_STATUS_GLYPH[status];
  const budget = Math.max(1, maxCells);
  if (cells.length <= budget) return cells.map(glyph).join('');
  // Reserve the widest `+N` the hidden count can need, so the strip never
  // exceeds `maxCells` at a digit rollover.
  const shownCount = Math.max(1, budget - (1 + String(cells.length).length));
  return `${cells.slice(0, shownCount).map(glyph).join('')}+${cells.length - shownCount}`;
}

function liveTaskMetadata(
  row: WorkflowTaskRowModel,
  streamId: StreamTabId | undefined,
  nowMs: number,
): string | undefined {
  // The row's own parts name the call (kind · agent · model · attempt · files)
  // and, once it settles, what it cost; the live segments below cover the
  // in-flight window the card itself cannot: elapsed, generated tokens, and
  // the running spend read off the child stream.
  const live = !isTerminalWorkflowCallProgress(row.call);
  const usage = streamId
    ? readStreamArtifacts(streamId)?.cumulativeUsage
    : undefined;
  const runStartedAt = streamPhaseFor(streamId)?.runStartedAt;
  const parts = [
    ...row.metadataParts,
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

function TaskRow({
  focused,
  nowMs,
  pendingKinds,
  row,
  streamId,
}: {
  readonly focused: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly row: WorkflowTaskRowModel;
  readonly streamId: StreamTabId | undefined;
}): React.JSX.Element {
  const style = WORKFLOW_TASK_STATUS_STYLE[row.call.status];
  const metadata = liveTaskMetadata(row, streamId, nowMs);
  const approval = pendingApprovalRowDisplay(pendingKinds);
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
          {focused ? POINTER : ' '}
        </Text>
        <Text aria-hidden color={style.color}>
          {markerCell(style.marker)}
        </Text>
      </Box>
      <RowSegment flexShrink={1}>{row.call.label}</RowSegment>
      {/* The status word outranks the metadata column: it is its own segment
          at the label's shrink weight, so a wide row sheds metadata (weight 2)
          long before it clips `· Running`. */}
      <RowSegment flexShrink={1}>{` · ${row.statusLabel}`}</RowSegment>
      <ApprovalSegments approval={approval} />
      {metadata ? (
        <RowSegment dimColor flexShrink={2}>{`  ${metadata}`}</RowSegment>
      ) : null}
    </Box>
  );
}

/** A plan task the run has not issued yet: label and status, nothing to
 *  focus, kill, or retry. */
function DeclaredTaskRow({
  task,
}: {
  readonly task: WorkflowCallIdentity;
}): React.JSX.Element {
  const style = WORKFLOW_TASK_STATUS_STYLE.declared;
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text aria-hidden> </Text>
        <Text aria-hidden color={style.color}>
          {markerCell(style.marker)}
        </Text>
      </Box>
      <RowSegment dimColor flexShrink={1}>
        {task.label}
      </RowSegment>
      <RowSegment dimColor flexShrink={1}>
        {` · ${WORKFLOW_TASK_STATUS_LABEL.declared}`}
      </RowSegment>
    </Box>
  );
}

/** A counted group of quiet rows; Enter unfolds it in place. */
function GroupRow({
  count,
  expanded,
  focused,
  group,
}: {
  readonly count: number;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly group: WorkflowRowGroup;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
          {focused ? POINTER : ' '}
        </Text>
        <Text aria-hidden dimColor>
          {markerCell(expanded ? '▾' : '▸')}
        </Text>
      </Box>
      <RowSegment dimColor={!focused} flexShrink={1}>
        {`${count} ${GROUP_LABEL[group]}`}
      </RowSegment>
    </Box>
  );
}

interface WorkflowPopupProps {
  readonly availableRows: number;
  /** The workflow-script stream the popup looks into. */
  readonly streamId: StreamTabId;
  readonly model: WorkflowRunModel;
  readonly view: WorkflowPopupView;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly activeSubagentExecutionIds: ReadonlyMap<StreamTabId, string>;
  readonly pendingApprovals:
    ReadonlyMap<string, readonly PendingApprovalKind[]> | undefined;
  readonly onClose: () => void;
  readonly onFocusStream: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly onWorkflowControl: (
    executionId: string,
    action: WorkflowControlAction,
  ) => void;
  readonly onOpenTranscript: (streamId: StreamTabId) => void;
  readonly onViewChange: (patch: Partial<WorkflowPopupView>) => void;
}

export function WorkflowPopup({
  activeSubagentExecutionIds,
  availableRows,
  model,
  onClose,
  onFocusStream,
  onKillExecution,
  onOpenTranscript,
  onViewChange,
  onWorkflowControl,
  pendingApprovals,
  streamId,
  streams,
  view,
}: WorkflowPopupProps): React.JSX.Element {
  const { columns } = useWindowSize();
  useSignal(sessionStateRevision);
  useSignal(streamArtifactRevision);
  const frameWidth = formFrameWidth(columns);
  const width = frameWidth - CONFIRM_CARD_HORIZONTAL_DECORATION;

  const { phases } = model;
  const phaseIndex = Math.min(
    Math.max(0, view.phaseIndex),
    Math.max(0, phases.length - 1),
  );
  const phase = phases[phaseIndex];
  const rows = useMemo(
    () =>
      phase
        ? workflowPhaseRows(phase, {
            expanded: view.expanded,
            filter: view.filter,
          })
        : [],
    [phase, view.expanded, view.filter],
  );
  const rowByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row] as const)),
    [rows],
  );
  // Declared rows are display-only; the highlight settles on the first row
  // that can be acted on when the remembered one is gone or not selectable.
  const firstSelectableKey = rows.find((row) => row.kind !== 'declared')?.key;
  const remembered =
    view.selectedKey !== undefined ? rowByKey.get(view.selectedKey) : undefined;
  const selectedKey =
    remembered && remembered.kind !== 'declared'
      ? remembered.key
      : firstSelectableKey;
  const selectedRow =
    selectedKey !== undefined ? rowByKey.get(selectedKey) : undefined;

  // The model names the card's child stream; whether that stream exists in
  // this host is the host's question.
  const childStreamOf = (
    row: WorkflowTaskRowModel,
  ): StreamTabId | undefined => {
    const childStreamId = model.childStreamOf.get(row.id);
    return childStreamId !== undefined && streams.has(childStreamId)
      ? childStreamId
      : undefined;
  };
  const runStartedAt = streamPhaseFor(streamId)?.runStartedAt;
  const nowMs = useLiveNowMsSince([
    runStartedAt,
    ...model.tasks.map(
      (row) => streamPhaseFor(childStreamOf(row))?.runStartedAt,
    ),
  ]);

  const identity = streamMetadataFor(streamId)?.identity;
  const name = identity ? runIdentityDisplayName(identity) : 'Workflow';
  const cost = readStreamArtifacts(streamId)?.cumulativeUsage?.cost;
  const title = [
    name,
    formatWorkflowTally(model.tally),
    runStartedAt !== undefined
      ? formatCompactDuration(nowMs - runStartedAt)
      : undefined,
    cost !== undefined && cost > 0 ? formatCostUsd(cost) : undefined,
  ]
    .filter(filterNotNullish)
    .join(' · ');

  const selectedTask =
    selectedRow?.kind === 'task' ? selectedRow.row : undefined;
  const selectedChildStreamId = selectedTask
    ? childStreamOf(selectedTask)
    : undefined;
  const selectedExecutionId =
    selectedChildStreamId !== undefined
      ? activeSubagentExecutionIds.get(selectedChildStreamId)
      : undefined;
  const controllable =
    selectedChildStreamId !== undefined &&
    selectedChildRowWorkflowControllable({
      parentIdentity: identity,
      selectedChildIdentity: streamMetadataFor(selectedChildStreamId)?.identity,
      selectedChildKillable: selectedExecutionId !== undefined,
    });

  const hints: KeyHint[] = [
    { key: '←/→', action: 'phase' },
    { key: '↑/↓', action: 'select' },
    { key: 'Enter', action: 'open / toggle' },
    { key: '/', action: 'filter' },
    { key: 'f', action: 'next failed' },
    ...(controllable
      ? [
          { key: 's', action: 'skip' },
          { key: 'r', action: 'retry' },
        ]
      : []),
    ...(selectedExecutionId !== undefined
      ? [{ key: 'x', action: 'kill' }]
      : []),
    { key: 'Ctrl-T', action: 'log' },
    { key: 'Esc', action: view.filter.length > 0 ? 'clear filter' : 'close' },
  ];
  // The shared budget assumes a one-row footer; the wrapped hints take what
  // they measure at this width.
  const hintRows = Math.max(
    1,
    wrapAnsiToWidth(
      hints.map(keyHintText).join(KEY_HINT_SEPARATOR),
      Math.max(1, width),
    ).split('\n').length,
  );
  const filterShown = view.filterEditing || view.filter.length > 0;
  const listRows = Math.max(
    1,
    scrollableModalTextRowsBudget({
      availableRows,
      columns,
      title,
      extraFixedRows:
        POPUP_CHROME_ROWS + (hintRows - 1) + (filterShown ? 1 : 0),
    }),
  );
  const tabTexts = phases.map(phaseTabText);
  const tabStart = tabWindowStart(tabTexts, phaseIndex, width);

  const clearFilterOrClose = (): void => {
    if (view.filter.length > 0) onViewChange({ filter: '' });
    else onClose();
  };

  useInput((input, key) => {
    if (view.filterEditing) {
      if (isEscapeInput(input, key)) {
        onViewChange({ filter: '', filterEditing: false });
      } else if (key.return) {
        onViewChange({ filterEditing: false });
      } else if (key.backspace || key.delete) {
        onViewChange({ filter: view.filter.slice(0, -1) });
      } else if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.tab
      ) {
        onViewChange({ filter: view.filter + input, selectedKey: undefined });
      }
      return;
    }
    if (key.ctrl && input.toLowerCase() === 't') {
      onOpenTranscript(streamId);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (rows.length === 0 && isEscapeInput(input, key)) {
      // The list owns Escape while it has rows; with none, this does.
      clearFilterOrClose();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const next = Math.min(
        Math.max(0, phaseIndex + (key.rightArrow ? 1 : -1)),
        Math.max(0, phases.length - 1),
      );
      if (next !== phaseIndex) {
        onViewChange({ phaseIndex: next, selectedKey: undefined });
      }
      return;
    }
    if (input === '/') {
      onViewChange({ filterEditing: true });
      return;
    }
    if (input === 'f') {
      const current =
        selectedKey === undefined
          ? -1
          : rows.findIndex((row) => row.key === selectedKey);
      const failed = rows
        .map((row, index) => ({ row, index }))
        .filter(
          ({ row }) => row.kind === 'task' && row.row.call.status === 'failed',
        );
      const next = failed.find(({ index }) => index > current) ?? failed[0];
      if (next) onViewChange({ selectedKey: next.row.key });
      return;
    }
    if (
      (input === 's' || input === 'r') &&
      controllable &&
      selectedExecutionId
    ) {
      onWorkflowControl(selectedExecutionId, input === 's' ? 'skip' : 'retry');
      return;
    }
    if ((input === 'x' || input === 'k') && selectedExecutionId) {
      onKillExecution(selectedExecutionId);
    }
  });

  const items: SelectItem<string>[] = rows.map((row) => ({
    label: row.key,
    value: row.key,
    disabled: row.kind === 'declared',
  }));
  const renderRow = (
    item: SelectItem<string>,
    state: { readonly focused: boolean },
  ): React.JSX.Element | null => {
    const row = rowByKey.get(item.value);
    if (!row) return null;
    switch (row.kind) {
      case 'task': {
        const childStreamId = childStreamOf(row.row);
        return (
          <TaskRow
            focused={state.focused}
            nowMs={nowMs}
            row={row.row}
            streamId={childStreamId}
            pendingKinds={
              childStreamId === undefined
                ? undefined
                : pendingApprovals?.get(childStreamId)
            }
          />
        );
      }
      case 'declared':
        return <DeclaredTaskRow task={row.task} />;
      case 'group':
        return (
          <GroupRow
            count={row.count}
            expanded={row.expanded}
            focused={state.focused}
            group={row.group}
          />
        );
    }
  };
  const activate = (key: string): void => {
    const row: WorkflowPhaseRow | undefined = rowByKey.get(key);
    if (!row) return;
    if (row.kind === 'task') {
      const childStreamId = childStreamOf(row.row);
      if (childStreamId !== undefined) onFocusStream(childStreamId);
      return;
    }
    if (row.kind === 'group') {
      const expanded = new Set(view.expanded);
      if (expanded.has(row.group)) expanded.delete(row.group);
      else expanded.add(row.group);
      onViewChange({ expanded });
    }
  };

  const emptyText = (() => {
    if (view.filter.length > 0) return `No agents match "${view.filter}"`;
    if (!phase) return 'No phases yet';
    return phase.opened ? 'No calls in this phase yet' : 'Not started';
  })();

  return (
    <BorderedPanel
      color={COLOR_HINT}
      title={title}
      width={frameWidth}
      footer={<KeyHints hints={hints} confirmCancel={false} wrap />}
    >
      <Box flexDirection="column" width={width}>
        <Box height={1} overflowY="hidden">
          <Text wrap="truncate-end">
            {tabStart > 0 ? <Text dimColor>{TAB_SCROLL_MARK}</Text> : null}
            {phases.slice(tabStart).map((tab, offset) => {
              const index = tabStart + offset;
              const active = index === phaseIndex;
              return (
                <Text key={tab.key}>
                  {offset > 0 ? TAB_SEPARATOR : ''}
                  <Text
                    bold={active}
                    color={active ? COLOR_HINT : undefined}
                    dimColor={!active}
                  >
                    {tabTexts[index]}
                  </Text>
                </Text>
              );
            })}
          </Text>
        </Box>
        <Box height={1} overflowY="hidden">
          <Text dimColor wrap="truncate-end">
            {phase ? statusStrip(phase.cells, Math.max(1, width - 1)) : ''}
          </Text>
        </Box>
        {filterShown ? (
          <Box height={1} overflowY="hidden">
            <Text wrap="truncate-end">
              <Text color={COLOR_HINT}>{'/ '}</Text>
              <Text bold>{view.filter}</Text>
              {view.filterEditing ? <Text color={COLOR_HINT}>▏</Text> : null}
              <Text dimColor>
                {`  ${rows.length} of ${phase ? phase.tasks.length + phase.declaredTasks.length : 0}`}
                {view.filterEditing ? ' · Enter keep · Esc clear' : ''}
              </Text>
            </Text>
          </Box>
        ) : null}
        {rows.length === 0 ? (
          <Text dimColor>{emptyText}</Text>
        ) : (
          <Select
            hotkeys={false}
            highlightedValue={selectedKey ?? null}
            isActive={!view.filterEditing}
            items={items}
            maxVisibleItems={listRows}
            onCancel={clearFilterOrClose}
            onHighlightChange={(key) => onViewChange({ selectedKey: key })}
            onSelect={activate}
            renderItem={renderRow}
            showOverflow
            wrap={false}
          />
        )}
      </Box>
    </BorderedPanel>
  );
}
