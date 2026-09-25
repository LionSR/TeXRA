// The workflow popup: one phase at a time, attention first, volume collapsed.
//
// A workflow-script run is never a viewport you stand in — its transcript is
// chrome about other runs. This foreground surface (the same mechanics as
// the Ctrl-T reader: row-budgeted, Esc restores the parent untouched) paints
// the shared run model (`@shared/runs/workflowRunModel`): the run's phases
// as tabs and the selected phase's rows — calls that need a decision, then
// calls worth watching, then counted groups that open in place. Every fold is
// the model's; this file only decides how a row looks in a terminal.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - TUI primitives
import { isCtrlInput, isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { textDisplayWidth } from '@cli/runtime/terminalText';

// Local imports - shared schemas, model, and copy
import {
  runIdentityDisplayName,
  type RunId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import {
  formatWorkflowCallLiveParts,
  workflowPhaseRows,
  type WorkflowPhaseModel,
  type WorkflowPhaseRow,
  type WorkflowRunModel,
} from '@shared/runs/workflowRunModel';
import { resolvePhase } from '@shared/session/surface';
import type { WorkflowTaskRow as WorkflowTaskRowModel } from '@ui/transcript';
import {
  WORKFLOW_CALL_STATUS_GLYPH,
  WORKFLOW_PHASE_GLYPH,
  formatWorkflowTally,
} from '@ui/copy/workflowCall';
import { clampIndex, filterNotNullish } from '@utils/core';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

// Local imports - TUI state and policy
import { formFrameWidth } from '../forms/_shared/FormFrame';
import { BaseTextInput } from '../input/BaseTextInput';
import { type WorkflowPopupView } from '../state/cliState';
import { killableRunId, sessionView, runViewOf } from '../state/sessionView';
import { useSignal } from '../state/useSignal';

// Local imports - sibling panes
import { DeclaredTaskRow, GroupRow, TaskRow } from './WorkflowPopupRows';
import { pendingApprovalKindsByRun } from '../state/approvalQueue';

/** Rows the popup paints above its list: the tab strip and the per-call
 *  status strip. The focused call's detail line below it adds one, and the
 *  filter line one more while it shows. */
const POPUP_HEADER_ROWS = 3;
const ALL_ROW_GROUPS = new Set([
  'finished',
  'queued',
  'planned',
  'not run',
] as const);
const TAB_SEPARATOR = '    ';
const TAB_SCROLL_MARK = '‹ ';

function phaseTabText(phase: WorkflowPhaseModel): string {
  return `${phase.opened ? WORKFLOW_PHASE_GLYPH.opened : WORKFLOW_PHASE_GLYPH.declared} ${phase.heading.phaseLabel} · ${formatWorkflowTally(phase.tally)}`;
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

interface WorkflowPopupProps {
  readonly availableRows: number;
  /** The workflow-script stream the popup looks into. */
  readonly runId: RunId;
  readonly model: WorkflowRunModel;
  readonly view: WorkflowPopupView;
  readonly onClose: () => void;
  readonly onFocusRun: (runId: RunId) => void;
  /** Issue a kill (`run.stop`) or a skip/retry (`workflow.control`). */
  readonly onRequest: (request: RuntimeRequest) => void;
  readonly onOpenTranscript: (runId: RunId) => void;
  readonly onViewChange: (patch: Partial<WorkflowPopupView>) => void;
}

export function WorkflowPopup({
  availableRows,
  model,
  onClose,
  onFocusRun,
  onOpenTranscript,
  onRequest,
  onViewChange,
  runId,
  view,
}: WorkflowPopupProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const sessionState = useSignal(sessionView());
  const pendingApprovals = useSignal(pendingApprovalKindsByRun);
  const stream = runViewOf(sessionState, runId);
  const { phases } = model;
  // The board's rule: the user's tab while the model still has it, else the
  // run's active phase.
  const activeKey = resolvePhase(view.phaseKey, phases);
  const phaseIndex = Math.max(
    0,
    phases.findIndex((candidate) => candidate.key === activeKey),
  );
  const phase = phases[phaseIndex];
  // The cards whose child run needs the user, its own approval or a
  // descendant's: the fold's `approval` aggregate, read off the child
  // runs this host holds, as the board reads it.
  const waitingOf = (candidate: WorkflowPhaseModel): ReadonlySet<string> =>
    new Set(
      candidate.tasks
        .filter((task) => {
          const childId = model.childRunOf.get(task.id);
          const child =
            childId === undefined ? undefined : sessionState.runs.get(childId);
          return child !== undefined && child.approval !== 'none';
        })
        .map((task) => task.id),
    );
  const rows = useMemo(
    () =>
      phase
        ? workflowPhaseRows(phase, {
            expanded: view.expanded,
            settled: model.settled,
            filter: view.filter,
            waiting: waitingOf(phase),
          })
        : [],
    [phase, view.expanded, view.filter, model, sessionState],
  );
  const rowByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row] as const)),
    [rows],
  );
  // Declared rows are display-only. A remembered call that settled into a
  // folded group keeps the highlight on that group's row, so the cursor does
  // not jump when a card changes status; otherwise it lands on the first row
  // that can be acted on.
  const firstSelectableKey = rows.find((row) => row.kind !== 'declared')?.key;
  const remembered =
    view.selectedKey !== undefined ? rowByKey.get(view.selectedKey) : undefined;
  const foldedInto = (key: string): string | undefined => {
    if (!phase) return undefined;
    const unfolded = workflowPhaseRows(phase, {
      expanded: ALL_ROW_GROUPS,
      settled: model.settled,
      filter: view.filter,
      waiting: waitingOf(phase),
    });
    const at = unfolded.findIndex((row) => row.key === key);
    return at < 0
      ? undefined
      : unfolded.slice(0, at).findLast((row) => row.kind === 'group')?.key;
  };
  const selectedKey =
    remembered && remembered.kind !== 'declared'
      ? remembered.key
      : ((view.selectedKey !== undefined && remembered === undefined
          ? foldedInto(view.selectedKey)
          : undefined) ?? firstSelectableKey);
  const selectedRow =
    selectedKey !== undefined ? rowByKey.get(selectedKey) : undefined;

  // The model names the card's child stream; whether that stream exists in
  // this host is the host's question.
  const childRunOf = (row: WorkflowTaskRowModel): RunId | undefined => {
    const childRunId = model.childRunOf.get(row.id);
    return childRunId !== undefined && sessionState.runs.has(childRunId)
      ? childRunId
      : undefined;
  };
  const runStartedAt = stream?.runStartedAt ?? undefined;
  // A card is live only while its workflow is, and the run's own origin is
  // set for every active phase, so it alone keys the clock.
  const nowMs = useLiveNowMsSince([runStartedAt]);

  const identity = stream?.identity ?? undefined;
  const name = identity ? runIdentityDisplayName(identity) : 'Workflow';
  const cost = stream && stream.usage.cost > 0 ? stream.usage.cost : undefined;
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
  const selectedChildRunId = selectedTask
    ? childRunOf(selectedTask)
    : undefined;
  // What the focused call is and has cost: its card's parts, and the live
  // window the model joins from its child run.
  const selectedDetail = selectedTask
    ? [
        ...selectedTask.metadataParts,
        ...formatWorkflowCallLiveParts(
          selectedTask.call,
          model.liveOf.get(selectedTask.id),
          nowMs,
        ),
      ].join(' · ')
    : '';
  const selectedChildRun = runViewOf(sessionState, selectedChildRunId);
  const selectedRunId = killableRunId(selectedChildRun);
  // A workflow-script grandchild `agent()` call is the only skip/retry-able
  // row: a native agent run (an external CLI tool's child is driven by that
  // tool and would no-op) whose parent is the workflow run — one identity
  // hop, which excludes the run stream itself.
  const selectedChildIdentity = selectedChildRun?.identity;
  const controllable =
    selectedRunId !== undefined &&
    selectedChildIdentity?.kind === 'agent' &&
    selectedChildIdentity.tool === undefined &&
    identity?.kind === 'multiAgentWorkflow';

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
    ...(selectedRunId !== undefined ? [{ key: 'x', action: 'kill' }] : []),
    { key: 'Ctrl-T', action: 'log' },
    { key: 'Esc', action: view.filter.length > 0 ? 'clear filter' : 'close' },
  ];
  const filterShown = view.filterEditing || view.filter.length > 0;
  const layout = readerLayout({
    availableRows,
    extraRows: POPUP_HEADER_ROWS + (filterShown ? 1 : 0),
    frameWidth: formFrameWidth(columns),
    hints,
    title,
  });
  const width = layout.contentWidth;
  const tabTexts = phases.map(phaseTabText);
  const tabStart = tabWindowStart(tabTexts, phaseIndex, width);

  const clearFilterOrClose = (): void => {
    if (view.filter.length > 0) onViewChange({ filter: '' });
    else onClose();
  };

  useInput(
    (input, key) => {
      if (isCtrlInput(input, key, 't')) {
        onOpenTranscript(runId);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (rows.length === 0 && isEscapeInput(input, key)) {
        // The list owns Escape while it has rows; with none, this does.
        clearFilterOrClose();
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const next = clampIndex(
          phaseIndex + (key.rightArrow ? 1 : -1),
          phases.length,
        );
        if (next !== phaseIndex) {
          onViewChange({ phaseKey: phases[next]?.key, selectedKey: undefined });
        }
        return;
      }
      if (input === '/') {
        onViewChange({ filterEditing: true });
        return;
      }
      if (input === 'f') {
        const allRows = phases.flatMap((candidate, candidatePhaseIndex) =>
          workflowPhaseRows(candidate, {
            expanded: view.expanded,
            settled: model.settled,
            filter: view.filter,
            waiting: waitingOf(candidate),
          }).map((row) => ({ phaseIndex: candidatePhaseIndex, row })),
        );
        const current = allRows.findIndex(
          (item) =>
            item.phaseIndex === phaseIndex && item.row.key === selectedKey,
        );
        const failed = allRows
          .map((item, index) => ({ ...item, index }))
          .filter(
            ({ row }) =>
              row.kind === 'task' && row.row.call.status === 'failed',
          );
        const next = failed.find(({ index }) => index > current) ?? failed[0];
        if (next) {
          onViewChange({
            phaseKey: phases[next.phaseIndex]?.key,
            selectedKey: next.row.key,
          });
        }
        return;
      }
      if ((input === 's' || input === 'r') && controllable && selectedRunId) {
        onRequest({
          kind: 'workflow.control',
          runId,
          childRunId: selectedRunId,
          action: input === 's' ? 'skip' : 'retry',
        });
        return;
      }
      if (input === 'x' && selectedRunId) {
        onRequest({ kind: 'run.stop', runId: selectedRunId });
      }
    },
    // The filter input owns every key while it edits.
    { isActive: !view.filterEditing },
  );

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
        const childRunId = childRunOf(row.row);
        return (
          <TaskRow
            latestLine={
              runViewOf(sessionState, childRunId)?.latestLine ?? undefined
            }
            row={row.row}
            pendingKinds={
              childRunId === undefined
                ? undefined
                : pendingApprovals.get(childRunId)
            }
          />
        );
      }
      case 'declared':
        return <DeclaredTaskRow settled={model.settled} task={row.task} />;
      case 'group':
        return <GroupRow focused={state.focused} row={row} />;
    }
  };
  const activate = (key: string): void => {
    const row: WorkflowPhaseRow | undefined = rowByKey.get(key);
    if (!row) return;
    if (row.kind === 'task') {
      const childRunId = childRunOf(row.row);
      if (childRunId !== undefined) onFocusRun(childRunId);
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
    <ReaderPanel
      footer={<KeyHints hints={hints} confirmCancel={false} wrap />}
      layout={layout}
      title={title}
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
              <Text bold>
                <BaseTextInput
                  focus={view.filterEditing}
                  value={view.filter}
                  onChange={(filter) =>
                    onViewChange({ filter, selectedKey: undefined })
                  }
                  onEscape={() =>
                    onViewChange({ filter: '', filterEditing: false })
                  }
                  onSubmit={() => onViewChange({ filterEditing: false })}
                />
              </Text>
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
            maxVisibleItems={Math.max(1, layout.bodyRows)}
            onCancel={clearFilterOrClose}
            onHighlightChange={(key) => onViewChange({ selectedKey: key })}
            onSelect={activate}
            renderItem={renderRow}
            showOverflow
            wrap={false}
          />
        )}
        <Box height={1} overflowY="hidden">
          <Text dimColor wrap="truncate-end">
            {selectedDetail}
          </Text>
        </Box>
      </Box>
    </ReaderPanel>
  );
}
