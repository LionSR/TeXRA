// Ink TUI root: a single vertical column — conversation, optional subagent /
// todos panels at the bottom, then status, approval modal, and input bar.
// Tab / Shift-Tab cycles focus across subagent streams.

import { Box, useApp, useInput, useStdin, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';

import {
  LIVE_ELAPSED_STREAM_STATUSES,
  type StreamStatus,
} from '@shared/schemas';

import { assertNever } from './assertNever';
import { SLASH_PALETTE_ROWS } from './commands/SlashPalette';
import { REVERSE_SEARCH_ROWS } from './input/ReverseSearch';
import { ApprovalModal } from './modals/ApprovalModal';
import { ChildControlPicker } from './modals/ChildControlPicker';
import { TranscriptViewer } from './modals/TranscriptViewer';
import { ConversationPane } from './panes/ConversationPane';
import { StaticConversationTranscript } from './panes/StaticConversationTranscript';
import { InputBar } from './panes/InputBar';
import {
  QueuedFollowUpsPanel,
  queuedFollowUpPanelRowCount,
} from './panes/QueuedFollowUpsPanel';
import { StatusBar } from './panes/StatusBar';
import {
  StreamTabsStrip,
  streamTabsDisplayItems,
} from './panes/StreamTabsStrip';
import { SubagentList, subagentPanelRowCount } from './panes/SubagentList';
import { TipRow } from './panes/TipRow';
import { TodosPlanPanel, todosPlanPanelRowCount } from './panes/TodosPlanPanel';
import { currentApproval, type PendingApproval } from './state/approvalQueue';
import {
  isKittyKeypadEnter,
  metaChordDigit,
  metaChordInput,
} from './input/inputKeys';
import {
  hasChildControlItems,
  hasChildExecutionRows,
  numericFocusTargetForActiveStream,
  resolveChildControlStreamTarget,
  type ChildControlMode,
} from './state/childControls';
import { cliState } from './state/cliState';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
import { streamScopeDisplayLabel } from './state/streamLabels';
import { useSignal } from './state/useSignal';
import type { InputHistory } from './history/inputHistory';

// Subset of Ink's internal stdin event emitter (the same channel `useInput`
// consumes) needed to re-inject a synthesized Enter. Not part of `useStdin`'s
// public type, so we narrow to just what we touch.
interface InputEventEmitterLike {
  emit(event: 'input', data: string): void;
  on(event: 'input', listener: (data: string) => void): void;
  off(event: 'input', listener: (data: string) => void): void;
}

const MIN_TRANSCRIPT_WIDTH = 20;
const FOREGROUND_TRANSCRIPT_ROWS = 1;
const MIN_FOREGROUND_ROWS_WITH_TRANSCRIPT = 6;
const CHILD_CONTROL_FOREGROUND_MAX_ROWS = 12;
const EMPTY_CHILD_CONTROL_FOREGROUND_MAX_ROWS = 6;
const FORM_FOREGROUND_MAX_ROWS = 18;
// Match form sizing for approval modals that already budget or scroll their
// content. Natural-height approvals stay uncapped until they grow row budgets.
const APPROVAL_FOREGROUND_MAX_ROWS = 18;
// Cap the bottom subagent/todos panels so they never crowd out the
// conversation or push the input bar off-screen.
const BOTTOM_PANEL_MAX_ROWS = 10;
const COMPACT_STATIC_TRANSCRIPT_MAX_ROWS = 14;
const COMPACT_LIVE_TRANSCRIPT_RESERVE_ROWS = 2;

const PINNED_CHROME_ROWS = {
  tip: 1,
  input: 3,
  streamTabsWorstCase: 1,
  status: 2,
} as const;

function pinnedChromeRows({
  inputVisible = true,
  queuedFollowUpPanelRows = 0,
  reverseSearchOpen,
  slashPaletteOpen,
  streamTabsVisible = true,
  staticTranscriptRows = 0,
  tipVisible = true,
}: {
  readonly inputVisible?: boolean;
  readonly queuedFollowUpPanelRows?: number;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
  readonly streamTabsVisible?: boolean;
  readonly staticTranscriptRows?: number;
  readonly tipVisible?: boolean;
}): number {
  const baseRows =
    PINNED_CHROME_ROWS.status +
    (inputVisible ? PINNED_CHROME_ROWS.input : 0) +
    (streamTabsVisible ? PINNED_CHROME_ROWS.streamTabsWorstCase : 0) +
    queuedFollowUpPanelRows +
    staticTranscriptRows +
    (tipVisible ? PINNED_CHROME_ROWS.tip : 0);
  return (
    baseRows +
    (slashPaletteOpen ? SLASH_PALETTE_ROWS : 0) +
    (reverseSearchOpen ? REVERSE_SEARCH_ROWS : 0)
  );
}

export function allocateMiddleRows({
  foregroundMaxRows,
  foregroundOpen,
  inputVisible = true,
  queuedFollowUpPanelRows = 0,
  reverseSearchOpen,
  rows,
  slashPaletteOpen,
  streamTabsVisible = true,
  staticTranscriptRows = 0,
  tipVisible = true,
}: {
  readonly foregroundMaxRows?: number;
  readonly foregroundOpen: boolean;
  readonly inputVisible?: boolean;
  readonly queuedFollowUpPanelRows?: number;
  readonly reverseSearchOpen: boolean;
  readonly rows: number;
  readonly slashPaletteOpen: boolean;
  readonly streamTabsVisible?: boolean;
  readonly staticTranscriptRows?: number;
  readonly tipVisible?: boolean;
}): {
  readonly foregroundRows: number;
  readonly transcriptRows: number;
} {
  const availableRows = Math.max(
    0,
    rows -
      pinnedChromeRows({
        inputVisible,
        queuedFollowUpPanelRows,
        reverseSearchOpen,
        slashPaletteOpen,
        streamTabsVisible,
        staticTranscriptRows,
        tipVisible,
      }),
  );
  if (!foregroundOpen) {
    return { foregroundRows: 0, transcriptRows: availableRows };
  }
  if (availableRows === 0) {
    return { foregroundRows: 0, transcriptRows: 0 };
  }
  if (availableRows === 1) {
    return { foregroundRows: 1, transcriptRows: 0 };
  }

  const transcriptRows =
    availableRows >= MIN_FOREGROUND_ROWS_WITH_TRANSCRIPT
      ? Math.min(FOREGROUND_TRANSCRIPT_ROWS, availableRows - 1)
      : 0;
  const foregroundRows = availableRows - transcriptRows;
  return {
    foregroundRows:
      foregroundMaxRows === undefined
        ? foregroundRows
        : Math.min(foregroundRows, Math.max(1, foregroundMaxRows)),
    transcriptRows,
  };
}

export function allocateSidePanelRows({
  subagentContentRows,
  todosPlanContentRows,
  rows,
}: {
  readonly subagentContentRows: number;
  readonly todosPlanContentRows: number;
  readonly rows: number;
}): {
  readonly subagentRows: number;
  readonly todosPlanRows: number;
} {
  const available = Math.max(0, rows);
  const subagentNeed = Math.max(0, subagentContentRows);
  const todosNeed = Math.max(0, todosPlanContentRows);
  if (available === 0 || subagentNeed + todosNeed === 0) {
    return { subagentRows: 0, todosPlanRows: 0 };
  }
  // Everything fits: each panel gets exactly what its content needs.
  if (subagentNeed + todosNeed <= available) {
    return { subagentRows: subagentNeed, todosPlanRows: todosNeed };
  }
  // Over budget: a panel with no content gets nothing, a lone panel takes all.
  if (subagentNeed === 0) return { subagentRows: 0, todosPlanRows: available };
  if (todosNeed === 0) return { subagentRows: available, todosPlanRows: 0 };
  // Both present and over budget: keep at least one row each, split the rest
  // proportionally to need. At a single row the todo/plan panel wins.
  if (available === 1) return { subagentRows: 0, todosPlanRows: 1 };
  const subagentRows = Math.min(
    available - 1,
    Math.max(
      1,
      Math.round((subagentNeed / (subagentNeed + todosNeed)) * available),
    ),
  );
  return { subagentRows, todosPlanRows: available - subagentRows };
}

export function staticTranscriptRowBudget({
  footerRows,
  foregroundOpen,
  queuedFollowUpPanelRows = 0,
  rows,
  tipVisible = true,
}: {
  readonly footerRows: number;
  readonly foregroundOpen: boolean;
  readonly queuedFollowUpPanelRows?: number;
  readonly rows: number;
  readonly tipVisible?: boolean;
}): number | undefined {
  if (foregroundOpen || rows > COMPACT_STATIC_TRANSCRIPT_MAX_ROWS) {
    return undefined;
  }
  const optionalRows =
    rows -
    footerRows -
    queuedFollowUpPanelRows -
    (tipVisible ? PINNED_CHROME_ROWS.tip : 0);
  const liveTranscriptReserveRows = Math.min(
    COMPACT_LIVE_TRANSCRIPT_RESERVE_ROWS,
    Math.max(0, optionalRows),
  );
  return Math.max(0, optionalRows - liveTranscriptReserveRows);
}

export function shouldShowTipRow({
  foregroundOpen,
  hasQueuedFollowUps = false,
}: {
  readonly foregroundOpen: boolean;
  readonly hasQueuedFollowUps?: boolean;
}): boolean {
  return !foregroundOpen && !hasQueuedFollowUps;
}

export function shouldShowTodosPlanPanel({
  foregroundOpen,
  hasPlan,
  hasTodos,
  status,
}: {
  readonly foregroundOpen: boolean;
  readonly hasPlan: boolean;
  readonly hasTodos: boolean;
  readonly status: StreamStatus | undefined;
}): boolean {
  if (foregroundOpen) return false;
  if (!hasTodos && !hasPlan) return false;
  return status !== undefined && LIVE_ELAPSED_STREAM_STATUSES.has(status);
}

export function appFocusShortcutsActive({
  inputDisabled,
  reverseSearchOpen,
  slashPaletteOpen,
}: {
  readonly inputDisabled: boolean;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
}): boolean {
  return !inputDisabled && !slashPaletteOpen && !reverseSearchOpen;
}

export function appEscapeInterruptActive({
  inputDisabled,
  reverseSearchOpen,
  runPending,
  slashPaletteOpen,
}: {
  readonly inputDisabled: boolean;
  readonly reverseSearchOpen: boolean;
  readonly runPending: boolean;
  readonly slashPaletteOpen: boolean;
}): boolean {
  return (
    runPending &&
    appFocusShortcutsActive({
      inputDisabled,
      reverseSearchOpen,
      slashPaletteOpen,
    })
  );
}

export type ForegroundSurfaceKind =
  | 'transcript'
  | 'childControls'
  | 'form'
  | 'approval';

export function foregroundSurfaceKind({
  activeFormOpen,
  childControlMode,
  pendingApproval,
  transcriptViewerOpen,
}: {
  readonly activeFormOpen: boolean;
  readonly childControlMode?: ChildControlMode;
  readonly pendingApproval: boolean;
  readonly transcriptViewerOpen: boolean;
}): ForegroundSurfaceKind | undefined {
  if (transcriptViewerOpen) return 'transcript';
  if (childControlMode !== undefined) return 'childControls';
  if (activeFormOpen) return 'form';
  if (pendingApproval) return 'approval';
  return undefined;
}

export function childControlForegroundMaxRows({
  hasItems,
}: {
  readonly hasItems: boolean;
}): number {
  return hasItems
    ? CHILD_CONTROL_FOREGROUND_MAX_ROWS
    : EMPTY_CHILD_CONTROL_FOREGROUND_MAX_ROWS;
}

export function approvalForegroundMaxRows(
  pending: PendingApproval | undefined,
): number | undefined {
  if (pending === undefined) return undefined;

  switch (pending.payload.kind) {
    case 'bash':
    case 'toolEdit':
    case 'proposal':
    case 'externalInquiry':
      return APPROVAL_FOREGROUND_MAX_ROWS;
    case 'plan':
    case 'retry':
    case 'userQuestion':
      return undefined;
    default:
      return assertNever(pending.payload, 'Unhandled approval payload kind');
  }
}

export interface AppProps {
  readonly onSubmit: (line: string, mediaFiles?: readonly string[]) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly canInterruptActiveRun: () => boolean;
  readonly canStopActiveRun?: () => boolean;
  readonly colorEnabled?: boolean;
  readonly onInterruptActive: () => void;
  readonly onCtrlC?: () => void;
  readonly inputDisabled?: boolean;
  readonly history?: InputHistory;
}

export function App(props: AppProps): React.JSX.Element {
  // Single subscription site; pass the value down so ApprovalModal renders
  // off the same read and InputBar can stay mounted but disabled.
  const pending = useSignal(currentApproval);
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const parentStream = useSignal(cliState.parentStream);
  const activeForm = useSignal(cliState.activeForm);
  const slashPaletteOpen = useSignal(cliState.slashPaletteOpen);
  const reverseSearchOpen = useSignal(cliState.reverseSearchOpen);
  const transcriptViewerStreamId = useSignal(cliState.transcriptViewerStreamId);
  const transcriptViewerOpen = transcriptViewerStreamId !== undefined;
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const [childControlMode, setChildControlMode] = useState<
    ChildControlMode | undefined
  >(undefined);
  const canStopActiveRun =
    props.canStopActiveRun ?? props.canInterruptActiveRun;

  // Under the Kitty disambiguate flag (enabled in runChatTui for Shift+Enter),
  // keypad Enter becomes its own key (codepoint 57414) that Ink parses but
  // exposes no `useInput` field for — so it would silently stop submitting.
  // Re-dispatch it on Ink's own input channel as a plain Enter (CR) so every
  // submit/confirm path that keys off `key.return` keeps working. Inert when the
  // protocol is off — the sequence never arrives. (Ctrl+C needs no such bridge:
  // Ink decodes its CSI-u form to a normal ctrl+c key, handled in useInput below.)
  const stdin = useStdin();
  useEffect(() => {
    const emitter = (
      stdin as unknown as { internal_eventEmitter?: InputEventEmitterLike }
    ).internal_eventEmitter;
    if (!emitter) return;
    const onInput = (data: string): void => {
      if (isKittyKeypadEnter(data)) {
        emitter.emit('input', String.fromCharCode(13));
      }
    };
    emitter.on('input', onInput);
    return () => emitter.off('input', onInput);
  }, [stdin]);
  const foregroundOpen =
    pending !== undefined ||
    activeForm !== undefined ||
    childControlMode !== undefined ||
    transcriptViewerOpen;
  const inputDisabled = props.inputDisabled === true || foregroundOpen;
  const inputBarVisible = !foregroundOpen;

  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const queuedFollowUpMessages = activeSlice?.queuedFollowUpMessages ?? [];
  const queuedFollowUpPanelWanted =
    !foregroundOpen && queuedFollowUpMessages.length > 0;
  const streamTabItems = streamTabsDisplayItems({
    activeStreamId,
    parentStream,
    streams,
    width: columns,
  });
  const streamTabsVisible = streamTabItems.length > 0;
  const footerRows =
    PINNED_CHROME_ROWS.status +
    (inputBarVisible ? PINNED_CHROME_ROWS.input : 0) +
    (streamTabsVisible ? PINNED_CHROME_ROWS.streamTabsWorstCase : 0);
  const requestedQueuedFollowUpPanelRows = queuedFollowUpPanelWanted
    ? queuedFollowUpPanelRowCount(queuedFollowUpMessages)
    : 0;
  const queuedFollowUpPanelRows = queuedFollowUpPanelWanted
    ? Math.min(requestedQueuedFollowUpPanelRows, Math.max(0, rows - footerRows))
    : 0;
  const queuedFollowUpPanelVisible = queuedFollowUpPanelRows > 0;
  const tipRowVisible = shouldShowTipRow({
    foregroundOpen,
    hasQueuedFollowUps: queuedFollowUpPanelWanted,
  });
  const staticTranscriptRows = staticTranscriptRowBudget({
    footerRows,
    foregroundOpen,
    queuedFollowUpPanelRows,
    rows,
    tipVisible: tipRowVisible,
  });
  const subagentControlTarget = resolveChildControlStreamTarget({
    activeStreamId,
    mode: 'subagents',
    parentStream,
    streams,
  });
  const taskControlTarget = resolveChildControlStreamTarget({
    activeStreamId,
    mode: 'tasks',
    parentStream,
    streams,
  });
  const taskControlsAvailable = hasChildControlItems(
    taskControlTarget.slice,
    'tasks',
  );
  const subagentControlsAvailable = hasChildControlItems(
    subagentControlTarget.slice,
    'subagents',
  );
  const hasSubagentPanel =
    !foregroundOpen && hasChildExecutionRows(activeSlice);
  const hasTodosPlanPanel = shouldShowTodosPlanPanel({
    foregroundOpen,
    hasPlan: activeSlice?.plan != null,
    hasTodos: (activeSlice?.todos.length ?? 0) > 0,
    status: activeSlice?.status,
  });
  const transcriptWidth = Math.max(MIN_TRANSCRIPT_WIDTH, columns);
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    childControlMode,
    pendingApproval: pending !== undefined,
    transcriptViewerOpen,
  });
  const childControlTarget =
    childControlMode !== undefined
      ? resolveChildControlStreamTarget({
          activeStreamId,
          mode: childControlMode,
          parentStream,
          streams,
        })
      : undefined;
  const childControlHasItems =
    childControlMode !== undefined &&
    hasChildControlItems(childControlTarget?.slice, childControlMode);
  const { foregroundRows, transcriptRows } = allocateMiddleRows({
    foregroundMaxRows:
      foregroundKind === 'childControls'
        ? childControlForegroundMaxRows({ hasItems: childControlHasItems })
        : foregroundKind === 'form'
          ? FORM_FOREGROUND_MAX_ROWS
          : foregroundKind === 'approval'
            ? approvalForegroundMaxRows(pending)
            : undefined,
    foregroundOpen,
    inputVisible: inputBarVisible,
    queuedFollowUpPanelRows,
    reverseSearchOpen,
    rows,
    slashPaletteOpen,
    streamTabsVisible,
    staticTranscriptRows: staticTranscriptRows ?? 0,
    tipVisible: tipRowVisible,
  });
  // The subagent/todos panels live at the bottom of the same vertical column.
  // Reserve only as many rows as the panels actually need — capped so they
  // never take more than half the transcript or push the input off-screen —
  // and let the conversation reclaim whatever the panels don't use. A fixed
  // reservation would leave a dead gap above the input whenever the lists are
  // shorter than the cap.
  const subagentContentRows =
    hasSubagentPanel && activeSlice ? subagentPanelRowCount(activeSlice) : 0;
  const todosPlanContentRows =
    hasTodosPlanPanel && activeSlice
      ? todosPlanPanelRowCount(activeSlice.todos, activeSlice.plan)
      : 0;
  const bottomPanelBudget = Math.min(
    BOTTOM_PANEL_MAX_ROWS,
    subagentContentRows + todosPlanContentRows,
    Math.floor(transcriptRows / 2),
  );
  const conversationRows = transcriptRows - bottomPanelBudget;
  const { subagentRows, todosPlanRows } = allocateSidePanelRows({
    subagentContentRows,
    todosPlanContentRows,
    rows: bottomPanelBudget,
  });
  function renderForegroundSurface(): React.ReactNode {
    switch (foregroundKind) {
      case 'transcript': {
        // foregroundKind is 'transcript' only while transcriptViewerOpen, so
        // transcriptViewerStreamId is set here — guard once to narrow it.
        if (!transcriptViewerStreamId) return null;
        return (
          <TranscriptViewer
            availableRows={foregroundRows}
            onClose={() => cliState.transcriptViewerStreamId.set(undefined)}
            slice={streams.get(transcriptViewerStreamId)}
            title={streamScopeDisplayLabel({
              parentStream,
              streamId: transcriptViewerStreamId,
              streams,
            })}
            width={transcriptWidth}
          />
        );
      }
      case 'childControls': {
        if (!childControlMode) return null;
        const target = childControlTarget;
        if (!target) return null;
        const targetStreamLabel = target.streamId
          ? streamScopeDisplayLabel({
              parentStream,
              streamId: target.streamId,
              streams,
            })
          : undefined;
        const fallbackFromStreamLabel = target.fallbackFromStreamId
          ? streamScopeDisplayLabel({
              parentStream,
              streamId: target.fallbackFromStreamId,
              streams,
            })
          : undefined;
        const streamScopeDetail =
          targetStreamLabel && fallbackFromStreamLabel
            ? childControlMode === 'subagents'
              ? `${fallbackFromStreamLabel} has no subagents`
              : `${fallbackFromStreamLabel} has no tasks or sub-workflows`
            : undefined;
        return (
          <ChildControlPicker
            availableColumns={columns}
            activeStreamLabel={targetStreamLabel}
            activeStreamId={target.streamId}
            availableRows={foregroundRows}
            mode={childControlMode}
            onClose={() => setChildControlMode(undefined)}
            onFocusStream={(streamId) => cliState.activeStreamId.set(streamId)}
            onViewStream={(streamId) =>
              cliState.transcriptViewerStreamId.set(streamId)
            }
            onKillExecution={props.onKillExecution}
            slice={target.slice}
            streamScopeDetail={streamScopeDetail}
            streams={streams}
          />
        );
      }
      case 'form':
        return activeForm?.render(
          () => cliState.activeForm.set(undefined),
          foregroundRows,
        );
      case 'approval':
        return pending ? (
          <ApprovalModal pending={pending} availableRows={foregroundRows} />
        ) : null;
      case undefined:
        return null;
    }
  }
  const foregroundSurface = renderForegroundSurface();

  const focusShortcutsActive = appFocusShortcutsActive({
    inputDisabled,
    reverseSearchOpen,
    slashPaletteOpen,
  });

  // Single App-level keyboard entry point. Ink broadcasts every keystroke to all
  // mounted useInput handlers, so keeping the App's shortcuts in one always-on
  // handler (gating internally) is clearer than several hooks racing on the same
  // chord. Stays mounted so Ctrl+C works even while a modal/form owns the input.
  useInput((input, key) => {
    // Ctrl+C is owned here even over foreground surfaces. We render with
    // exitOnCtrlC: false (see runChatTui), so Ink neither auto-exits nor filters
    // Ctrl+C out of useInput. The full CLI wires onCtrlC to the same SIGINT
    // path used by terminals that deliver a signal; harnesses can fall back to
    // interrupt-then-exit behavior without duplicating that process lifecycle.
    if (key.ctrl && input === 'c') {
      if (props.onCtrlC) {
        props.onCtrlC();
        return;
      }
      if (canStopActiveRun()) {
        props.onInterruptActive();
        return;
      }
      exit();
      return;
    }

    // Everything below stands down while a modal/form/input overlay owns the
    // keyboard.
    if (!focusShortcutsActive) return;

    if (key.ctrl && input.toLowerCase() === 't') {
      if (activeStreamId) cliState.transcriptViewerStreamId.set(activeStreamId);
      return;
    }

    // Tab / Shift-Tab cycles stream focus.
    if (key.tab) {
      const next = key.shift ? nextFocusBack() : nextFocusForward();
      if (next) cliState.activeStreamId.set(next);
      return;
    }

    // Esc/Alt chords: s → subagent controls, p → tasks, 1-9 → focus stream.
    const metaInput = metaChordInput(input, key);
    if (metaInput) {
      const lower = metaInput.toLowerCase();
      if (lower === 's') {
        if (subagentControlsAvailable) setChildControlMode('subagents');
        return;
      }
      if (lower === 'p') {
        if (taskControlsAvailable) setChildControlMode('tasks');
        return;
      }
      const digit = metaChordDigit(input, key);
      if (digit !== undefined) {
        const target = numericFocusTargetForActiveStream({
          activeStreamId,
          parentStream,
          streams,
          zeroBasedIndex: digit - 1,
        });
        if (target) cliState.activeStreamId.set(target);
      }
      return;
    }

    // Escape interrupts an active run.
    if (
      key.escape &&
      appEscapeInterruptActive({
        inputDisabled,
        reverseSearchOpen,
        runPending: props.canInterruptActiveRun(),
        slashPaletteOpen,
      })
    ) {
      props.onInterruptActive();
    }
  });

  return (
    <>
      <StaticConversationTranscript
        colorEnabled={props.colorEnabled}
        maxRows={staticTranscriptRows}
        width={transcriptWidth}
      />
      <Box flexDirection="column">
        <Box flexDirection="column" overflowY="hidden">
          {conversationRows > 0 ? (
            <ConversationPane
              width={transcriptWidth}
              maxRows={conversationRows}
            />
          ) : null}
          {foregroundSurface ? (
            // Cap the modal area at its row budget but size to the surface's
            // actual content: every foreground surface (forms, approvals,
            // transcript viewer, child controls) already windows itself to the
            // `foregroundRows` budget it is handed, so a fixed height only ever
            // leaves dead rows below a short form/approval. maxHeight keeps the
            // budget as a safety clip without reserving it.
            <Box
              flexDirection="column"
              maxHeight={foregroundRows}
              alignItems="flex-start"
              overflowY="hidden"
            >
              {foregroundSurface}
            </Box>
          ) : null}
        </Box>
        {bottomPanelBudget > 0 ? (
          <Box flexDirection="column" overflowY="hidden">
            <SubagentList maxRows={subagentRows} />
            <TodosPlanPanel maxRows={todosPlanRows} />
          </Box>
        ) : null}
        {tipRowVisible ? <TipRow /> : null}
        {queuedFollowUpPanelVisible ? (
          <QueuedFollowUpsPanel
            maxRows={queuedFollowUpPanelRows}
            messages={queuedFollowUpMessages}
            width={columns}
          />
        ) : null}
        <InputBar
          onSubmit={props.onSubmit}
          collapseWhenDisabled={!inputBarVisible}
          disabled={inputDisabled}
          history={props.history}
        />
        <StreamTabsStrip items={streamTabItems} width={columns} />
        <StatusBar
          canStopActiveRun={canStopActiveRun}
          queuedFollowUpPreview={!queuedFollowUpPanelVisible}
          shortcutsActive={focusShortcutsActive}
        />
      </Box>
    </>
  );
}
