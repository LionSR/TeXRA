// Ink TUI root: a single vertical column — conversation, optional subagent /
// todos panels at the bottom, then status, approval modal, and input bar.
// Tab / Shift-Tab cycles focus across subagent streams.

import { Box, useApp, useInput, useStdin, useWindowSize } from 'ink';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  isActiveStatus,
  isLiveElapsedStatus,
} from '@common/constants/streamStatus';
import {
  TODO_STATUS,
  type StreamLifecycleStatus,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { assertNever, clamp } from '@utils/core';
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
import {
  approvalPayloadStreamId,
  currentApproval,
  type PendingApproval,
} from './state/approvalQueue';
import {
  isEscapeInput,
  metaChordInput,
  rewriteKittyEnterInput,
} from './input/inputKeys';
import {
  numericFocusTargetForActiveStream,
  resolveChildControlDisplayTargets,
  type ChildControlMode,
} from './state/childControls';
import {
  activeStreamId as activeStreamIdSignal,
  rootRunStartAvailable as rootRunStartAvailableSignal,
  rootStreamId as rootStreamIdSignal,
  activeForm as activeFormSignal,
  childControlEscapeAction as childControlEscapeActionSignal,
  childControlMode as childControlModeSignal,
  reverseSearchOpen as reverseSearchOpenSignal,
  slashPaletteOpen as slashPaletteOpenSignal,
  transcriptViewerStreamId as transcriptViewerStreamIdSignal,
  parentStream as parentStreamSignal,
  streams as streamsSignal,
} from './state/cliState';
import { focusedChildInputDisabledMessage } from './state/focusedChildFollowUp';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
import { streamDisplayLabel } from './state/streamViews';
import {
  isScopedTranscriptViewport,
  transcriptViewportChange,
  transcriptViewportKey,
  type TranscriptViewportChange,
} from './state/transcriptViewportMode';
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
// A bare Esc and the second key of an `Esc s` / `Esc p` chord are two
// separate keystrokes on terminals without true Meta-key detection (macOS
// Terminal.app). 125ms was too tight for a deliberate but unhurried chord
// (issue #7496: a ~400ms pause between Esc and `s` fired the bare-Esc
// interrupt and stopped a suspended WAITING subagent); widen to a
// tmux-style chord window so a human-paced chord still resolves before we
// commit to interrupting.
const ESC_META_CHORD_INTERRUPT_DELAY_MS = 500;
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
  reserveTranscriptRows = true,
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
  readonly reserveTranscriptRows?: boolean;
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
    reserveTranscriptRows &&
    availableRows >= MIN_FOREGROUND_ROWS_WITH_TRANSCRIPT
      ? Math.min(FOREGROUND_TRANSCRIPT_ROWS, availableRows - 1)
      : 0;
  const foregroundRows = availableRows - transcriptRows;
  return {
    // The early returns above and transcript reservation keep this at least 1,
    // so the lower clamp bound cannot inflate an empty foreground.
    foregroundRows:
      foregroundMaxRows === undefined
        ? foregroundRows
        : clamp(foregroundMaxRows, 1, foregroundRows),
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

export interface StaticScrollbackTarget {
  readonly ownerKey: string;
  readonly streamId: StreamTabId | undefined;
}

export function staticScrollbackTarget({
  activeStreamId,
  rootStreamId,
  scopedTranscript = false,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly rootStreamId: StreamTabId | undefined;
  readonly scopedTranscript?: boolean;
}): StaticScrollbackTarget {
  if (scopedTranscript) {
    return {
      ownerKey: activeStreamId ? `stream:${activeStreamId}` : 'scoped:none',
      streamId: activeStreamId,
    };
  }
  // Before a root run resolves, local helper output and harness-built root
  // streams still need static scrollback. The root owner key is deliberately
  // stable across the later rootStreamId resolution so Ink's append-only
  // <Static> cache does not remount and reprint pre-run root entries.
  return {
    ownerKey: 'root',
    streamId: rootStreamId ?? activeStreamId,
  };
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
  status,
  todos,
}: {
  readonly foregroundOpen: boolean;
  readonly hasPlan: boolean;
  readonly status: StreamLifecycleStatus | undefined;
  readonly todos: readonly TodoItem[];
}): boolean {
  if (foregroundOpen) return false;
  const hasTodos = todos.length > 0;
  if (!hasTodos && !hasPlan) return false;
  if (
    hasTodos &&
    todos.every((todo) => todo.status === TODO_STATUS.COMPLETED)
  ) {
    return false;
  }
  return isLiveElapsedStatus(status);
}

export function appFocusShortcutsActive({
  foregroundOpen,
  reverseSearchOpen,
  slashPaletteOpen,
}: {
  readonly foregroundOpen: boolean;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
}): boolean {
  return !foregroundOpen && !slashPaletteOpen && !reverseSearchOpen;
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
    runPending && !inputDisabled && !slashPaletteOpen && !reverseSearchOpen
  );
}

// The footer advertises `[Esc s]subagents` / `[Esc p]tasks` any time these
// controls are available, regardless of which stream is currently focused
// or whether it's still in-flight (e.g. WAITING). Bare Esc must therefore
// give a chord a chance to resolve any time that binding is on screen —
// gating on the focused child's own input-disabled state (as this used to)
// left the WAITING-child case with no defer window at all, so a slow
// `Esc s` fired an immediate interrupt instead. `Alt`-chord platforms are
// unaffected: their Esc+key sequences arrive as one burst, resolved
// synchronously by `metaChordInput`.
export function shouldDeferEscapeInterruptForMetaChord({
  shortcutModifierLabel,
  subagentControlsAvailable,
  taskControlsAvailable,
}: {
  readonly shortcutModifierLabel: string;
  readonly subagentControlsAvailable: boolean;
  readonly taskControlsAvailable: boolean;
}): boolean {
  return (
    shortcutModifierLabel === 'Esc' &&
    (subagentControlsAvailable || taskControlsAvailable)
  );
}

export interface EscapeInterruptState {
  readonly inputDisabled: boolean;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
  readonly canInterruptActiveRun: () => boolean;
  readonly onInterruptActive: () => void;
}

export function triggerEscapeInterrupt(state: EscapeInterruptState): boolean {
  if (
    !appEscapeInterruptActive({
      inputDisabled: state.inputDisabled,
      reverseSearchOpen: state.reverseSearchOpen,
      runPending: state.canInterruptActiveRun(),
      slashPaletteOpen: state.slashPaletteOpen,
    })
  ) {
    return false;
  }

  state.onInterruptActive();
  return true;
}

export function digitFromMetaShortcut(value: string): number | undefined {
  return /^[1-9]$/.test(value) ? Number.parseInt(value, 10) : undefined;
}

export type ForegroundSurfaceKind =
  'transcript' | 'childControls' | 'form' | 'approval';

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

export function approvalVisibleForActiveStream({
  activeStreamId,
  pending,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly pending: PendingApproval | undefined;
}): boolean {
  if (!pending) return false;
  const streamId = approvalPayloadStreamId(pending.payload);
  return streamId === undefined || streamId === activeStreamId;
}

export function foregroundEscapeAction({
  activeFormEscapeAction,
  childControlEscapeAction,
  foregroundKind,
  pending,
}: {
  readonly activeFormEscapeAction?: string;
  readonly childControlEscapeAction?: string;
  readonly foregroundKind: ForegroundSurfaceKind | undefined;
  readonly pending: PendingApproval | undefined;
}): string | undefined {
  switch (foregroundKind) {
    case undefined:
      return undefined;
    case 'form':
      return activeFormEscapeAction ?? 'close';
    case 'childControls':
      return childControlEscapeAction ?? 'close';
    case 'transcript':
      return 'close';
    case 'approval': {
      const kind = pending?.payload.kind;
      return kind === 'externalInquiry' || kind === 'userQuestion'
        ? 'skip'
        : 'cancel';
    }
  }
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

function foregroundMaxRowsForKind({
  childControlHasItems,
  kind,
  pending,
}: {
  readonly childControlHasItems: boolean;
  readonly kind: ForegroundSurfaceKind | undefined;
  readonly pending: PendingApproval | undefined;
}): number | undefined {
  switch (kind) {
    case 'childControls':
      return childControlForegroundMaxRows({ hasItems: childControlHasItems });
    case 'form':
      return FORM_FOREGROUND_MAX_ROWS;
    case 'approval':
      return approvalForegroundMaxRows(pending);
    case 'transcript':
    case undefined:
      return undefined;
  }
}

export interface AppProps {
  readonly onSubmit: (line: string, mediaFiles?: readonly string[]) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly canInterruptActiveRun: () => boolean;
  readonly canStopActiveRun?: () => boolean;
  readonly canStopPendingRunWithoutStream?: () => boolean;
  readonly colorEnabled?: boolean;
  readonly commandName?: string;
  readonly onInterruptActive: () => void;
  readonly onTranscriptViewportChange?: (
    change: TranscriptViewportChange,
  ) => void;
  readonly onCtrlC?: () => void;
  /** Suspend the process (Ctrl-Z). Raw mode swallows the tty driver's own
   *  ^Z→SIGTSTP translation, so the parsed key must be routed explicitly. */
  readonly onSuspend?: () => void;
  readonly inputDisabled?: boolean;
  readonly history?: InputHistory;
}

export function App(props: AppProps): React.JSX.Element {
  // Single subscription site; pass the value down so ApprovalModal renders
  // off the same read and InputBar can stay mounted but disabled.
  const pending = useSignal(currentApproval);
  const activeStreamId = useSignal(activeStreamIdSignal);
  const rootStreamId = useSignal(rootStreamIdSignal);
  const streams = useSignal(streamsSignal);
  const parentStream = useSignal(parentStreamSignal);
  const activeForm = useSignal(activeFormSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const transcriptViewerStreamId = useSignal(transcriptViewerStreamIdSignal);
  const rootRunStartAvailable = useSignal(rootRunStartAvailableSignal);
  const childControlMode = useSignal(childControlModeSignal);
  const childControlEscapeAction = useSignal(childControlEscapeActionSignal);
  const transcriptViewerOpen = transcriptViewerStreamId !== undefined;
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const [tipHour] = useState(() => new Date().getHours());
  const canStopActiveRun =
    props.canStopActiveRun ?? props.canInterruptActiveRun;
  const canStopPendingRunWithoutStream =
    props.canStopPendingRunWithoutStream ?? (() => false);
  const agentSelectionAvailable = rootRunStartAvailable;
  const activeApprovalVisible = approvalVisibleForActiveStream({
    activeStreamId,
    pending,
  });
  const childControlTargets = resolveChildControlDisplayTargets({
    activeStreamId,
    parentStream,
    streams,
  });
  const taskControlsAvailable = childControlTargets.tasks.hasItems;
  const subagentControlsAvailable = childControlTargets.subagents.hasItems;

  const stdin = useStdin();
  const foregroundOpen =
    activeApprovalVisible ||
    activeForm !== undefined ||
    childControlMode !== undefined ||
    transcriptViewerOpen;
  const childInputDisabledMessage = focusedChildInputDisabledMessage({
    activeStreamId,
    parentStream,
    status: activeStreamId ? streams.get(activeStreamId)?.status : undefined,
    subagentControlsAvailable,
    taskControlsAvailable,
  });
  const appInputDisabled = props.inputDisabled === true || foregroundOpen;
  const inputDisabled =
    appInputDisabled || childInputDisabledMessage !== undefined;
  const escapeInterruptStateRef = useRef<EscapeInterruptState>({
    inputDisabled: appInputDisabled,
    reverseSearchOpen,
    slashPaletteOpen,
    canInterruptActiveRun: props.canInterruptActiveRun,
    onInterruptActive: props.onInterruptActive,
  });
  useLayoutEffect(() => {
    escapeInterruptStateRef.current = {
      inputDisabled: appInputDisabled,
      reverseSearchOpen,
      slashPaletteOpen,
      canInterruptActiveRun: props.canInterruptActiveRun,
      onInterruptActive: props.onInterruptActive,
    };
  }, [
    appInputDisabled,
    props.canInterruptActiveRun,
    props.onInterruptActive,
    reverseSearchOpen,
    slashPaletteOpen,
  ]);
  const inputBarVisible = !foregroundOpen;
  const viewportKey = transcriptViewportKey({
    activeStreamId,
    parentStream,
    transcriptViewerStreamId,
  });
  const scopedTranscript = isScopedTranscriptViewport(viewportKey);
  const scrollbackTarget = staticScrollbackTarget({
    activeStreamId,
    rootStreamId,
    scopedTranscript,
  });
  const previousViewportKey = useRef<string | undefined>(undefined);
  const onTranscriptViewportChange = props.onTranscriptViewportChange;

  // Under the Kitty disambiguate flag (enabled in runChatTui for Shift+Enter),
  // some Enter variants arrive as CSI-u sequences that Ink parses incompletely.
  // Re-dispatch keypad Enter as plain Enter so submit/confirm still works.
  // Batched Shift+Enter sequences are rewritten into an internal newline token
  // only while the main draft input is active; standalone Shift+Enter is
  // already parsed by Ink and must not be emitted twice.
  useEffect(() => {
    const emitter = (
      stdin as unknown as { internal_eventEmitter?: InputEventEmitterLike }
    ).internal_eventEmitter;
    if (!emitter) return;
    const onInput = (data: string): void => {
      const rewritten = rewriteKittyEnterInput(data, {
        shiftEnter: inputDisabled ? 'preserve' : 'newline',
      });
      if (rewritten !== undefined) emitter.emit('input', rewritten);
    };
    emitter.on('input', onInput);
    return () => emitter.off('input', onInput);
  }, [inputDisabled, stdin]);

  useLayoutEffect(() => {
    const previous = previousViewportKey.current;
    previousViewportKey.current = viewportKey;
    const change = transcriptViewportChange({
      previousViewportKey: previous,
      nextViewportKey: viewportKey,
    });
    if (change) onTranscriptViewportChange?.(change);
  }, [onTranscriptViewportChange, viewportKey]);

  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const activeResponseRunning = isActiveStatus(activeSlice?.status);
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
    ? clamp(rows - footerRows, 0, requestedQueuedFollowUpPanelRows)
    : 0;
  const queuedFollowUpPanelVisible = queuedFollowUpPanelRows > 0;
  const tipRowVisible =
    !scopedTranscript &&
    shouldShowTipRow({
      foregroundOpen,
      hasQueuedFollowUps: queuedFollowUpPanelWanted,
    });
  const staticTranscriptRows = scopedTranscript
    ? undefined
    : staticTranscriptRowBudget({
        footerRows,
        foregroundOpen,
        queuedFollowUpPanelRows,
        rows,
        tipVisible: tipRowVisible,
      });
  const subagentPanelTarget = childControlTargets.tasks;
  const hasSubagentPanel = !foregroundOpen && subagentPanelTarget.hasItems;
  const hasTodosPlanPanel = shouldShowTodosPlanPanel({
    foregroundOpen,
    hasPlan: activeSlice?.plan != null,
    status: activeSlice?.status,
    todos: activeSlice?.todos ?? [],
  });
  const transcriptWidth = Math.max(MIN_TRANSCRIPT_WIDTH, columns);
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    childControlMode,
    pendingApproval: activeApprovalVisible,
    transcriptViewerOpen,
  });
  const childControlTarget =
    childControlMode !== undefined
      ? childControlTargets[childControlMode]
      : undefined;
  useEffect(() => {
    if (childControlMode === undefined) {
      childControlEscapeActionSignal.set('close');
    }
  }, [childControlMode]);
  const childControlHasItems = childControlTarget?.hasItems ?? false;
  const { foregroundRows, transcriptRows } = allocateMiddleRows({
    foregroundMaxRows: foregroundMaxRowsForKind({
      childControlHasItems,
      kind: foregroundKind,
      pending,
    }),
    foregroundOpen,
    inputVisible: inputBarVisible,
    queuedFollowUpPanelRows,
    reverseSearchOpen,
    reserveTranscriptRows: foregroundKind !== 'transcript',
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
    hasSubagentPanel && subagentPanelTarget.slice
      ? subagentPanelRowCount(subagentPanelTarget.slice)
      : 0;
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
            onClose={() => transcriptViewerStreamIdSignal.set(undefined)}
            slice={streams.get(transcriptViewerStreamId)}
            title={streamDisplayLabel({
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
        return (
          <ChildControlPicker
            availableColumns={columns}
            streamLabel={target.streamLabel}
            activeStreamId={target.streamId}
            availableRows={foregroundRows}
            mode={childControlMode}
            onClose={() => childControlModeSignal.set(undefined)}
            onEscapeActionChange={(action) =>
              childControlEscapeActionSignal.set(action)
            }
            onFocusStream={(streamId) => activeStreamIdSignal.set(streamId)}
            onViewStream={(streamId) =>
              transcriptViewerStreamIdSignal.set(streamId)
            }
            onKillExecution={props.onKillExecution}
            slice={target.slice}
            streamScopeDetail={target.streamScopeDetail}
            streams={streams}
          />
        );
      }
      case 'form':
        return activeForm?.render(
          () => activeFormSignal.set(undefined),
          foregroundRows,
        );
      case 'approval':
        return activeApprovalVisible && pending ? (
          <ApprovalModal pending={pending} availableRows={foregroundRows} />
        ) : null;
      case undefined:
        return null;
    }
  }
  const foregroundSurface = renderForegroundSurface();

  const focusShortcutsActive = appFocusShortcutsActive({
    foregroundOpen,
    reverseSearchOpen,
    slashPaletteOpen,
  });
  const pendingEscapeInterruptTimer = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);

  const clearPendingEscapeInterrupt = () => {
    if (pendingEscapeInterruptTimer.current === undefined) return;
    clearTimeout(pendingEscapeInterruptTimer.current);
    pendingEscapeInterruptTimer.current = undefined;
  };

  useEffect(() => {
    return clearPendingEscapeInterrupt;
  }, []);

  const handleMetaShortcut = (value: string): boolean => {
    const lower = value.toLowerCase();
    if (lower === 's') {
      if (!subagentControlsAvailable) return false;
      childControlModeSignal.set('subagents');
      return true;
    }
    if (lower === 'p') {
      if (!taskControlsAvailable) return false;
      childControlModeSignal.set('tasks');
      return true;
    }
    const digit = digitFromMetaShortcut(value);
    if (digit !== undefined) {
      const target = numericFocusTargetForActiveStream({
        activeStreamId,
        parentStream,
        streams,
        zeroBasedIndex: digit - 1,
      });
      if (!target) return false;
      activeStreamIdSignal.set(target);
      return true;
    }
    return false;
  };

  const scheduleEscapeInterrupt = () => {
    clearPendingEscapeInterrupt();
    pendingEscapeInterruptTimer.current = setTimeout(() => {
      pendingEscapeInterruptTimer.current = undefined;
      triggerEscapeInterrupt(escapeInterruptStateRef.current);
    }, ESC_META_CHORD_INTERRUPT_DELAY_MS);
  };

  // Single App-level keyboard entry point. Ink broadcasts every keystroke to all
  // mounted useInput handlers, so keeping the App's shortcuts in one always-on
  // handler (gating internally) is clearer than several hooks racing on the same
  // chord. Stays mounted so Ctrl+C works even while a modal/form owns the input.
  useInput((input, key) => {
    if (pendingEscapeInterruptTimer.current !== undefined) {
      clearPendingEscapeInterrupt();
      if (
        !key.ctrl &&
        !key.tab &&
        !isEscapeInput(input, key) &&
        input.length > 0
      ) {
        if (handleMetaShortcut(input)) return;
        triggerEscapeInterrupt(escapeInterruptStateRef.current);
        return;
      }
    }

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

    // Ctrl-Z suspends like a classic line-mode program would. Works over
    // foreground surfaces for the same reason Ctrl-C does: process-level
    // job control must not depend on which pane owns the keyboard.
    if (key.ctrl && input === 'z' && props.onSuspend) {
      props.onSuspend();
      return;
    }

    // Everything below stands down while a modal/form/input overlay owns the
    // keyboard.
    if (!focusShortcutsActive) return;

    if (key.ctrl && input.toLowerCase() === 't') {
      if (activeStreamId) transcriptViewerStreamIdSignal.set(activeStreamId);
      return;
    }

    // Tab / Shift-Tab cycles stream focus.
    if (key.tab) {
      const next = key.shift ? nextFocusBack() : nextFocusForward();
      if (next) activeStreamIdSignal.set(next);
      return;
    }

    // Esc/Alt chords: s → subagent controls, p → tasks, 1-9 → focus stream.
    const metaInput = metaChordInput(input, key);
    if (metaInput) {
      handleMetaShortcut(metaInput);
      return;
    }

    // Escape interrupts an active run.
    if (
      isEscapeInput(input, key) &&
      appEscapeInterruptActive({
        inputDisabled: escapeInterruptStateRef.current.inputDisabled,
        reverseSearchOpen: escapeInterruptStateRef.current.reverseSearchOpen,
        runPending: escapeInterruptStateRef.current.canInterruptActiveRun(),
        slashPaletteOpen: escapeInterruptStateRef.current.slashPaletteOpen,
      })
    ) {
      if (
        shouldDeferEscapeInterruptForMetaChord({
          shortcutModifierLabel: defaultShortcutModifierLabel(),
          subagentControlsAvailable,
          taskControlsAvailable,
        })
      ) {
        scheduleEscapeInterrupt();
        return;
      }
      triggerEscapeInterrupt(escapeInterruptStateRef.current);
    }
  });

  return (
    <>
      {transcriptViewerOpen ? null : (
        <StaticConversationTranscript
          colorEnabled={props.colorEnabled}
          maxRows={staticTranscriptRows}
          ownerKey={scrollbackTarget.ownerKey}
          scrollbackStreamId={scrollbackTarget.streamId}
          width={transcriptWidth}
        />
      )}
      <Box flexDirection="column">
        <Box flexDirection="column" overflowY="hidden">
          {!transcriptViewerOpen && conversationRows > 0 ? (
            <ConversationPane
              colorEnabled={props.colorEnabled}
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
            <SubagentList
              maxRows={subagentRows}
              slice={subagentPanelTarget.slice}
            />
            <TodosPlanPanel maxRows={todosPlanRows} />
          </Box>
        ) : null}
        {tipRowVisible ? (
          <TipRow
            agentSelectionAvailable={agentSelectionAvailable}
            hour={tipHour}
            responseRunning={activeResponseRunning}
          />
        ) : null}
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
          disabledMessage={childInputDisabledMessage}
          disabled={inputDisabled}
          history={props.history}
        />
        <StreamTabsStrip items={streamTabItems} width={columns} />
        <StatusBar
          agentSelectionAvailable={agentSelectionAvailable}
          canStopActiveRun={canStopActiveRun}
          canStopPendingRunWithoutStream={canStopPendingRunWithoutStream}
          commandName={props.commandName}
          foregroundEscapeAction={foregroundEscapeAction({
            activeFormEscapeAction: activeForm?.escapeAction,
            childControlEscapeAction,
            foregroundKind,
            pending: activeApprovalVisible ? pending : undefined,
          })}
          queuedFollowUpPreview={!queuedFollowUpPanelVisible}
          shortcutsActive={focusShortcutsActive}
          subagentControlsAvailable={subagentControlsAvailable}
          taskControlsAvailable={taskControlsAvailable}
          transcriptAvailable={(activeSlice?.entries.length ?? 0) > 0}
        />
      </Box>
    </>
  );
}
