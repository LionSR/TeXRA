// Ink root: conversation and optional panels above stable status, approval, and input chrome.

// Third-party imports
import { useApp, useInput, useStdin, useWindowSize } from 'ink';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

// Local imports - shared runtime
import { defaultSession } from '@agent/runtime/SessionHandle';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  AgentCategory,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - TUI surfaces and state
import {
  appDraftDiscardActive,
  appEscapeInterruptActive,
  appFocusShortcutsActive,
  approvalVisibleForActiveStream,
  digitFromMetaShortcut,
  ESC_META_CHORD_INTERRUPT_DELAY_MS,
  foregroundEscapeAction,
  foregroundMaxRowsForKind,
  foregroundSurfaceKind,
  shouldDeferEscapeInterruptForMetaChord,
  triggerAppCtrlC,
  triggerEscapeInterrupt,
  type EscapeInterruptState,
} from './appInteractionPolicy';
import { ApprovalModal } from './modals/ApprovalModal';
import { TaskDetailView } from './modals/TaskDetailView';
import { InfoPane } from './panes/InfoPane';
import { InputBar, type InputBarHandle } from './panes/InputBar';
import { ConversationRegion } from './panes/ConversationRegion';
import { StatusBar } from './panes/StatusBar';
import { isStaticTranscriptEntryAt } from './panes/transcriptEntries';
import {
  currentApproval,
  pendingApprovalSummaries,
  promoteApprovalsForStream,
  ROOT_APPROVAL_STREAM_KEY,
  type PendingApprovalKind,
} from './state/approvalQueue';
import {
  isEscapeInput,
  metaChordInput,
  rewriteKittyEnterInput,
} from './input/inputKeys';
import {
  ActiveDraftScope,
  createActiveDraftRegistry,
} from './input/activeDraft';
import {
  numericFocusTargetForActiveStream,
  resolveChildListTarget,
} from './state/childControls';
import {
  activeStreamId as activeStreamIdSignal,
  rootRunStartAvailable as rootRunStartAvailableSignal,
  rootStreamId as rootStreamIdSignal,
  activeForm as activeFormSignal,
  closeInfoPane,
  formProgress as formProgressSignal,
  infoPane as infoPaneSignal,
  reverseSearchOpen as reverseSearchOpenSignal,
  setTransientNotice,
  slashPaletteOpen as slashPaletteOpenSignal,
  taskDetailExecutionId as taskDetailExecutionIdSignal,
  streams as streamsSignal,
  type StreamSlice,
} from './state/cliState';
import { appendLocalAssistantTranscript } from './state/transcript';
import {
  activeSubagentsFor,
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
  subagentExecutionLabels as subagentExecutionLabelsSignal,
} from './state/childExecutions';
import { focusedChildInputDisabledMessage } from './state/focusedChildFollowUp';
import {
  createTranscriptPrintRequest,
  type TranscriptPrintRequest,
} from './state/transcriptLines';
import {
  childListProcessId,
  childListStreamId,
  childProcessListValue,
  childStreamListValue,
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListValue,
} from './state/childListSelection';
import { streamDisplayLabel, streamTreeViews } from './state/streamViews';
import { useSignal } from './state/useSignal';
import { syncStreamLog } from './state/subscribeStreamLog';
import { transcriptViewportKey } from './state/transcriptViewportMode';
import type { InputHistory } from './history/inputHistory';

// Narrow subset of Ink's internal stdin emitter used to synthesize Enter.
interface InputEventEmitterLike {
  emit(event: 'input', data: string): void;
  on(event: 'input', listener: (data: string) => void): void;
  off(event: 'input', listener: (data: string) => void): void;
}

type ProcessChildInfo = Extract<ActiveChildInfo, { kind: 'process' }>;
const NO_TRANSCRIPT_PRINTS: readonly TranscriptPrintRequest[] = [];

function lastStaticEntryId(slice: StreamSlice | undefined): string | undefined {
  return slice?.entries.findLast((entry, index, entries) =>
    isStaticTranscriptEntryAt(entries, index, slice.status),
  )?.id;
}

// Jump-to-waiting: surface the newly focused stream's pending approval right
// away instead of leaving it queued behind other streams' items. The root
// row also owns session-wide (stream-less) approvals.
function focusStreamAndPromoteApprovals(streamId: StreamTabId): void {
  activeStreamIdSignal.set(streamId);
  promoteApprovalsForStream(streamId, {
    includeSessionWide: streamId === rootStreamIdSignal.get(),
  });
}

export interface AppProps {
  readonly onSubmit: (line: string, mediaFiles?: readonly string[]) => void;
  readonly onKillExecution: (executionId: string) => void;
  /** Skip a focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onSkipExecution: (executionId: string) => void;
  /** Retry a focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onRetryExecution: (executionId: string) => void;
  /** Whether Ctrl-C may stop the current root run. */
  readonly canInterruptActiveRun: () => boolean;
  /** Whether bare Escape may stop the identified focused stream. */
  readonly canInterruptStream: (streamId: StreamTabId) => boolean;
  readonly canStopActiveRun?: () => boolean;
  readonly colorEnabled?: boolean;
  readonly commandName?: string;
  /** Apply the existing root-run interruption used by Ctrl-C. */
  readonly onInterruptActive: () => void;
  /** Stop only the focused stream captured by bare Escape. */
  readonly onInterruptStream: (streamId: StreamTabId) => void;
  readonly onStaticTranscriptChange?: () => void;
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
  const childStreamEntries = useSignal(childStreamEntriesSignal);
  const subagentExecutionLabels = useSignal(subagentExecutionLabelsSignal);
  const activeForm = useSignal(activeFormSignal);
  const formProgress = useSignal(formProgressSignal);
  const infoPane = useSignal(infoPaneSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const taskDetailExecutionId = useSignal(taskDetailExecutionIdSignal);
  const rootRunStartAvailable = useSignal(rootRunStartAvailableSignal);
  const formBusy = formProgress?.status === 'running';
  const pendingSummaries = useSignal(pendingApprovalSummaries);
  const [childListSelection, dispatchChildListSelection] = useReducer(
    reduceChildListSelection,
    INITIAL_CHILD_LIST_SELECTION,
  );
  const childListActiveStreamRef = useRef(activeStreamId);
  const childListFocused = childListSelection.focused;
  const selectedChildValue = childListSelection.selectedValue;
  const childDetailsVisible = childListSelection.detailsVisible;
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const [transcriptPrints, setTranscriptPrints] = useState<
    readonly TranscriptPrintRequest[]
  >([]);
  const nextTranscriptPrintId = useRef(0);
  const activeDraftRegistry = useMemo(() => createActiveDraftRegistry(), []);
  const canStopActiveRun =
    props.canStopActiveRun ?? props.canInterruptActiveRun;
  const agentSelectionAvailable = rootRunStartAvailable;
  const activeApprovalVisible = approvalVisibleForActiveStream({
    activeStreamId,
    pending,
  });
  const childListTarget = resolveChildListTarget({
    activeStreamId,
    childStreamEntries,
    parentStream,
    streams,
  });
  const activeProcesses = useMemo(
    () =>
      (childListTarget.slice?.activeProcesses ?? []).filter(
        (process): process is ProcessChildInfo => process.kind === 'process',
      ),
    [childListTarget.slice?.activeProcesses],
  );

  const stdin = useStdin();
  const foregroundOpen =
    activeApprovalVisible ||
    activeForm !== undefined ||
    infoPane !== undefined ||
    taskDetailExecutionId !== undefined;
  const childInputDisabledMessage = focusedChildInputDisabledMessage({
    activeStreamId,
    parentStream,
    status: activeStreamId ? streams.get(activeStreamId)?.status : undefined,
  });
  const appInputDisabled =
    props.inputDisabled === true || foregroundOpen || childListFocused;
  const inputDisabledMessage = childListFocused
    ? 'Session selection active.'
    : childInputDisabledMessage;
  const inputDisabled = appInputDisabled || inputDisabledMessage !== undefined;
  const escapeInterruptStateRef = useRef<EscapeInterruptState>({
    inputDisabled: appInputDisabled,
    reverseSearchOpen,
    slashPaletteOpen,
    canInterruptStream: props.canInterruptStream,
    onInterruptStream: props.onInterruptStream,
  });
  useLayoutEffect(() => {
    escapeInterruptStateRef.current = {
      inputDisabled: appInputDisabled,
      reverseSearchOpen,
      slashPaletteOpen,
      canInterruptStream: props.canInterruptStream,
      onInterruptStream: props.onInterruptStream,
    };
  }, [
    appInputDisabled,
    props.canInterruptStream,
    props.onInterruptStream,
    reverseSearchOpen,
    slashPaletteOpen,
  ]);
  const inputBarVisible = !foregroundOpen;

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

  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const transcriptOwnerKey = transcriptViewportKey({
    activeStreamId,
    parentStream,
  });
  const sessionEmpty = rootStreamId === undefined && streams.size === 0;
  const visibleTranscriptPrints = sessionEmpty
    ? NO_TRANSCRIPT_PRINTS
    : transcriptPrints;
  useEffect(() => {
    if (!sessionEmpty) return;
    setTranscriptPrints((current) => (current.length > 0 ? [] : current));
  }, [sessionEmpty]);
  const sessionViews = useMemo(
    () =>
      streamTreeViews({
        activeStreamId,
        childStreamEntries,
        parentStream,
        rootStreamId: childListTarget.streamId,
        streams,
      }),
    [
      activeStreamId,
      childListTarget.streamId,
      childStreamEntries,
      parentStream,
      streams,
    ],
  );
  // Group the flat FIFO summaries per row, folding stream-less (session-wide)
  // approvals onto the root/main row. Grouping from the flat list keeps each
  // row's first shown kind the first-to-present even when the root's own and
  // session-wide items interleave in the global queue.
  const pendingApprovalsForRows = useMemo(() => {
    const grouped = new Map<string, PendingApprovalKind[]>();
    for (const summary of pendingSummaries) {
      const key =
        summary.streamKey === ROOT_APPROVAL_STREAM_KEY
          ? rootStreamId
          : summary.streamKey;
      if (key === undefined) continue;
      const kinds = grouped.get(key);
      if (kinds) kinds.push(summary.kind);
      else grouped.set(key, [summary.kind]);
    }
    return grouped;
  }, [pendingSummaries, rootStreamId]);
  const activeSubagentExecutionIds = useMemo(() => {
    const executionIds = new Map<StreamTabId, string>();
    const parentIds = new Set(
      sessionViews
        .map((session) => session.parentId)
        .filter((parentId): parentId is StreamTabId => parentId !== undefined),
    );
    for (const parentId of parentIds) {
      for (const child of activeSubagentsFor(
        parentId,
        childStreamEntries,
        streams,
      )) {
        executionIds.set(child.childStreamId, child.executionId);
      }
    }
    return executionIds;
  }, [childStreamEntries, sessionViews, streams]);
  const childListValues = useMemo<readonly ChildListValue[]>(
    () => [
      ...sessionViews.map((session) => childStreamListValue(session.id)),
      ...activeProcesses.map((process) =>
        childProcessListValue(process.executionId),
      ),
    ],
    [activeProcesses, sessionViews],
  );
  const childListAvailable = childListValues.length > 0;
  const selectedChildStreamId = childListStreamId(selectedChildValue);
  const selectedChildProcessId = childListProcessId(selectedChildValue);
  let selectedChildKind: 'stream' | 'process' | undefined;
  if (selectedChildProcessId) selectedChildKind = 'process';
  if (selectedChildStreamId) selectedChildKind = 'stream';
  const selectedChildKillable = selectedChildProcessId
    ? activeProcesses.some(
        (process) => process.executionId === selectedChildProcessId,
      )
    : selectedChildStreamId !== undefined &&
      activeSubagentExecutionIds.has(selectedChildStreamId);
  // A workflow-script grandchild `agent()` call is the only interactively
  // skip/retry-able row: it is a Workflow-category subagent whose parent
  // stream is itself the Workflow run (the run stream's parent is the
  // orchestrator, a non-Workflow category), which excludes the run stream
  // itself so its row never shows a control that would silently no-op.
  const parentOfSelectedChild =
    selectedChildStreamId !== undefined
      ? parentStream.get(selectedChildStreamId)
      : undefined;
  const selectedChildWorkflowControllable =
    selectedChildKillable &&
    selectedChildStreamId !== undefined &&
    streams.get(selectedChildStreamId)?.category === AgentCategory.Workflow &&
    parentOfSelectedChild !== undefined &&
    streams.get(parentOfSelectedChild)?.category === AgentCategory.Workflow;
  const taskDetailProcess = taskDetailExecutionId
    ? activeProcesses.find(
        (process) => process.executionId === taskDetailExecutionId,
      )
    : undefined;
  useEffect(() => {
    dispatchChildListSelection({
      kind: 'reconcile',
      activeStreamId,
      values: childListValues,
    });
  }, [activeStreamId, childListValues]);
  // Stream focus can also move through lifecycle completion or a numeric
  // accelerator. Align the selected row before the changed frame is painted;
  // ordinary row reconciliation still preserves manual list selection.
  useLayoutEffect(() => {
    if (childListActiveStreamRef.current === activeStreamId) return;
    childListActiveStreamRef.current = activeStreamId;
    if (activeStreamId) {
      dispatchChildListSelection({
        kind: 'syncActiveStream',
        streamId: activeStreamId,
        values: childListValues,
      });
    }
  }, [activeStreamId, childListValues]);
  useEffect(() => {
    if (!childListAvailable && childListFocused) {
      dispatchChildListSelection({ kind: 'blur' });
    }
  }, [childListAvailable, childListFocused]);
  useEffect(() => {
    if (taskDetailExecutionId && !taskDetailProcess) {
      taskDetailExecutionIdSignal.set(undefined);
    }
  }, [taskDetailExecutionId, taskDetailProcess]);
  const cancelChildList = useCallback(() => {
    dispatchChildListSelection({ kind: 'blur' });
  }, []);
  const focusChildList = useCallback(() => {
    const firstChildValue = childListValues.at(0);
    if (firstChildValue) {
      dispatchChildListSelection({ kind: 'focus', value: firstChildValue });
    }
  }, [childListValues]);
  const focusSession = useCallback((streamId: StreamTabId) => {
    dispatchChildListSelection({ kind: 'focusStream', streamId });
    focusStreamAndPromoteApprovals(streamId);
  }, []);
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    formBusy,
    infoPaneOpen: infoPane !== undefined,
    pendingApproval: activeApprovalVisible,
    taskDetailOpen: taskDetailProcess !== undefined,
  });
  const approvalKind =
    foregroundKind === 'approval' ? pending?.payload.kind : undefined;
  const foregroundMaxRows = foregroundMaxRowsForKind({
    approvalKind,
    kind: foregroundKind,
  });
  const archiveInfoPane = useCallback((lines: readonly string[]) => {
    if (infoPaneSignal.get()?.lines !== lines) return;
    closeInfoPane();
    appendLocalAssistantTranscript(lines.join('\n'));
  }, []);
  function renderForegroundSurface(availableRows: number): React.ReactNode {
    switch (foregroundKind) {
      case 'taskDetail': {
        if (!taskDetailProcess) return null;
        return (
          <TaskDetailView
            availableColumns={columns}
            availableRows={availableRows}
            process={taskDetailProcess}
            tail={childListTarget.slice?.processOutput.get(
              taskDetailProcess.executionId,
            )}
            onBack={() => taskDetailExecutionIdSignal.set(undefined)}
            onKill={() => {
              props.onKillExecution(taskDetailProcess.executionId);
              taskDetailExecutionIdSignal.set(undefined);
            }}
          />
        );
      }
      case 'form':
        return activeForm?.render(() => {
          formProgressSignal.set(undefined);
          activeFormSignal.set(undefined);
        }, availableRows);
      case 'infoPane':
        return infoPane ? (
          <InfoPane
            availableRows={availableRows}
            colorEnabled={props.colorEnabled}
            lines={infoPane.lines}
            onClose={closeInfoPane}
            onOverflow={archiveInfoPane}
            title={infoPane.title}
          />
        ) : null;
      case 'approval':
        return activeApprovalVisible && pending ? (
          <ApprovalModal pending={pending} availableRows={availableRows} />
        ) : null;
      case undefined:
        return null;
    }
  }

  const focusShortcutsActive =
    !childListFocused &&
    appFocusShortcutsActive({
      foregroundOpen,
      reverseSearchOpen,
      slashPaletteOpen,
    });
  const pendingEscapeInterrupt = useRef<
    | {
        readonly streamId: StreamTabId;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);
  const inputBarRef = useRef<InputBarHandle>(null);

  const clearPendingEscapeInterrupt = () => {
    const pending = pendingEscapeInterrupt.current;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pendingEscapeInterrupt.current = undefined;
  };

  useEffect(() => {
    return clearPendingEscapeInterrupt;
  }, []);

  const handleMetaShortcut = (value: string): boolean => {
    const digit = digitFromMetaShortcut(value);
    if (digit !== undefined) {
      const target = numericFocusTargetForActiveStream({
        activeStreamId,
        childStreamEntries,
        parentStream,
        streams,
        zeroBasedIndex: digit - 1,
      });
      if (!target) return false;
      focusStreamAndPromoteApprovals(target);
      return true;
    }
    return false;
  };

  const printStreamOutput = (streamId: StreamTabId): void => {
    void defaultSession()
      .transcripts.ensureLoaded(streamId)
      .then(() => {
        syncStreamLog(streamId, { forceFull: true });
        const currentActiveStreamId = activeStreamIdSignal.get();
        const currentStreams = streamsSignal.get();
        const request = createTranscriptPrintRequest({
          afterEntryId: lastStaticEntryId(
            currentActiveStreamId
              ? currentStreams.get(currentActiveStreamId)
              : undefined,
          ),
          id: `printed-transcript:${nextTranscriptPrintId.current + 1}`,
          ownerKey: transcriptOwnerKey,
          slice: currentStreams.get(streamId),
          title: streamDisplayLabel({
            childStreamEntries,
            parentStream,
            streamId,
            streams: currentStreams,
          }),
        });
        nextTranscriptPrintId.current += 1;
        setTranscriptPrints((current) => [...current, request]);
        if (currentActiveStreamId !== streamId) syncStreamLog(streamId);
      })
      .catch((error: unknown) => {
        setTransientNotice(
          `Could not load transcript: ${toErrorMessage(error)}`,
        );
      });
  };

  const scheduleEscapeInterrupt = (streamId: StreamTabId) => {
    clearPendingEscapeInterrupt();
    const timer = setTimeout(() => {
      pendingEscapeInterrupt.current = undefined;
      triggerEscapeInterrupt(escapeInterruptStateRef.current, streamId);
    }, ESC_META_CHORD_INTERRUPT_DELAY_MS);
    pendingEscapeInterrupt.current = { streamId, timer };
  };

  // Single App-level keyboard entry point. Ink broadcasts every keystroke to all
  // mounted useInput handlers, so keeping the App's shortcuts in one always-on
  // handler (gating internally) is clearer than several hooks racing on the same
  // chord. Stays mounted so Ctrl+C works even while a modal/form owns the input.
  useInput((input, key) => {
    const pendingEscape = pendingEscapeInterrupt.current;
    if (pendingEscape !== undefined) {
      clearPendingEscapeInterrupt();
      if (
        !key.ctrl &&
        !key.tab &&
        !isEscapeInput(input, key) &&
        input.length > 0
      ) {
        if (handleMetaShortcut(input)) return;
        triggerEscapeInterrupt(
          escapeInterruptStateRef.current,
          pendingEscape.streamId,
        );
        return;
      }
    }

    // Ctrl+C is owned here even over foreground surfaces. We render with
    // exitOnCtrlC: false (see runChatTui), so Ink neither auto-exits nor filters
    // Ctrl+C out of useInput. The full CLI wires onCtrlC to the same SIGINT
    // path used by terminals that deliver a signal; harnesses can fall back to
    // interrupt-then-exit behavior without duplicating that process lifecycle.
    if (key.ctrl && input === 'c') {
      if (formBusy) {
        formProgress?.cancel();
        return;
      }
      triggerAppCtrlC({
        discardDraft: () =>
          activeDraftRegistry.discard() ||
          (appDraftDiscardActive({
            inputDisabled,
            reverseSearchOpen,
            childListFocused,
          }) &&
            (inputBarRef.current?.discardDraft() ?? false)),
        canStopActiveRun,
        onInterruptActive: props.onInterruptActive,
        onExit: exit,
        onCtrlC: props.onCtrlC,
      });
      return;
    }

    // Ctrl-Z suspends like a classic line-mode program would. Works over
    // foreground surfaces for the same reason Ctrl-C does: process-level
    // job control must not depend on which pane owns the keyboard.
    if (key.ctrl && input === 'z' && props.onSuspend) {
      props.onSuspend();
      return;
    }

    if (childListFocused && !foregroundOpen) {
      if (key.tab) dispatchChildListSelection({ kind: 'blur' });
      return;
    }

    // Everything below stands down while a modal/form/input overlay owns the
    // keyboard.
    if (!focusShortcutsActive) return;

    if (key.ctrl && input.toLowerCase() === 't') {
      if (activeStreamId) printStreamOutput(activeStreamId);
      return;
    }

    // Tab transfers keyboard ownership from the input to the child list.
    if (key.tab) {
      focusChildList();
      return;
    }

    // Esc/Alt 1-9 focuses a stream directly in the persistent list order.
    const metaInput = metaChordInput(input, key);
    if (metaInput) {
      handleMetaShortcut(metaInput);
      return;
    }

    // Escape interrupts an active run.
    if (
      isEscapeInput(input, key) &&
      activeStreamId !== undefined &&
      appEscapeInterruptActive({
        inputDisabled: escapeInterruptStateRef.current.inputDisabled,
        reverseSearchOpen: escapeInterruptStateRef.current.reverseSearchOpen,
        runPending:
          escapeInterruptStateRef.current.canInterruptStream(activeStreamId),
        slashPaletteOpen: escapeInterruptStateRef.current.slashPaletteOpen,
      })
    ) {
      if (
        shouldDeferEscapeInterruptForMetaChord({
          shortcutModifierLabel: defaultShortcutModifierLabel(),
          streamFocusAvailable: sessionViews.length > 0,
        })
      ) {
        scheduleEscapeInterrupt(activeStreamId);
        return;
      }
      triggerEscapeInterrupt(escapeInterruptStateRef.current, activeStreamId);
    }
  });

  return (
    <ActiveDraftScope
      active={foregroundOpen || reverseSearchOpen}
      registry={activeDraftRegistry}
    >
      <ConversationRegion
        colorEnabled={props.colorEnabled}
        columns={columns}
        onStaticTranscriptChange={props.onStaticTranscriptChange}
        renderFooterChrome={() => (
          <>
            <InputBar
              controlRef={inputBarRef}
              onSubmit={props.onSubmit}
              collapseWhenDisabled={!inputBarVisible}
              disabledMessage={inputDisabledMessage}
              disabled={inputDisabled}
              history={props.history}
              keyboardActive={!childListFocused}
              onFocusChildList={
                focusShortcutsActive ? focusChildList : undefined
              }
            />
            <StatusBar
              agentSelectionAvailable={agentSelectionAvailable}
              commandName={props.commandName}
              foregroundEscapeAction={foregroundEscapeAction({
                activeFormEscapeAction: formBusy
                  ? 'cancel'
                  : activeForm?.escapeAction,
                approvalKind,
                foregroundKind,
              })}
              foregroundInputActive={
                foregroundOpen || reverseSearchOpen || slashPaletteOpen
              }
              childListFocused={childListFocused}
              childListSelectionKind={selectedChildKind}
              childListSelectionKillable={selectedChildKillable}
              childListSelectionWorkflowControllable={
                selectedChildWorkflowControllable
              }
              childNavigationAvailable={childListAvailable}
              shortcutsActive={focusShortcutsActive}
              streamFocusAvailable={sessionViews.length > 0}
              transcriptAvailable={(activeSlice?.entries.length ?? 0) > 0}
            />
          </>
        )}
        renderForegroundSurface={renderForegroundSurface}
        rows={rows}
        snapshot={{
          activeStreamId,
          foregroundMaxRows,
          foregroundKind,
          parentStream,
          reverseSearchOpen,
          rootStreamId,
          slashPaletteOpen,
          childListFocused,
          childDetailsVisible,
          sessionViews,
          selectedChildValue,
          streams,
          subagentExecutionLabels,
          activeSubagentExecutionIds,
          childListTarget,
          pendingApprovals: pendingApprovalsForRows,
          transcriptPrints: visibleTranscriptPrints,
        }}
        onCancelChildList={cancelChildList}
        onFocusSession={focusSession}
        onKillExecution={props.onKillExecution}
        onSkipExecution={props.onSkipExecution}
        onRetryExecution={props.onRetryExecution}
        onOpenProcessDetail={(executionId) =>
          taskDetailExecutionIdSignal.set(executionId)
        }
        onPrintStream={printStreamOutput}
        onToggleChildDetails={() =>
          dispatchChildListSelection({ kind: 'toggleDetails' })
        }
        onChildSelectionChange={(value) =>
          dispatchChildListSelection({ kind: 'highlight', value })
        }
      />
    </ActiveDraftScope>
  );
}
