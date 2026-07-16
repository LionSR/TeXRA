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
} from 'react';

// Local imports - shared runtime
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

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
import { TranscriptViewer } from './modals/TranscriptViewer';
import { InputBar, type InputBarHandle } from './panes/InputBar';
import { ConversationRegion } from './panes/ConversationRegion';
import { StatusBar } from './panes/StatusBar';
import { currentApproval } from './state/approvalQueue';
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
  reverseSearchOpen as reverseSearchOpenSignal,
  slashPaletteOpen as slashPaletteOpenSignal,
  taskDetailExecutionId as taskDetailExecutionIdSignal,
  transcriptViewerStreamId as transcriptViewerStreamIdSignal,
  streams as streamsSignal,
} from './state/cliState';
import {
  activeSubagentsFor,
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
} from './state/childExecutions';
import { focusedChildInputDisabledMessage } from './state/focusedChildFollowUp';
import {
  childListProcessId,
  childListStreamId,
  childProcessListValue,
  childStreamListValue,
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListValue,
} from './state/childListSelection';
import { activeStreamTreeViews, streamDisplayLabel } from './state/streamViews';
import { useSignal } from './state/useSignal';
import type { TranscriptViewportChange } from './state/transcriptViewportMode';
import type { InputHistory } from './history/inputHistory';

// Narrow subset of Ink's internal stdin emitter used to synthesize Enter.
interface InputEventEmitterLike {
  emit(event: 'input', data: string): void;
  on(event: 'input', listener: (data: string) => void): void;
  off(event: 'input', listener: (data: string) => void): void;
}

type ProcessChildInfo = Extract<ActiveChildInfo, { kind: 'process' }>;

export interface AppProps {
  readonly onSubmit: (line: string, mediaFiles?: readonly string[]) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly canInterruptActiveRun: () => boolean;
  readonly canStopActiveRun?: () => boolean;
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
  const childStreamEntries = useSignal(childStreamEntriesSignal);
  const activeForm = useSignal(activeFormSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const transcriptViewerStreamId = useSignal(transcriptViewerStreamIdSignal);
  const taskDetailExecutionId = useSignal(taskDetailExecutionIdSignal);
  const rootRunStartAvailable = useSignal(rootRunStartAvailableSignal);
  const [childListSelection, dispatchChildListSelection] = useReducer(
    reduceChildListSelection,
    INITIAL_CHILD_LIST_SELECTION,
  );
  const childListActiveStreamRef = useRef(activeStreamId);
  const childListFocused = childListSelection.focused;
  const selectedChildValue = childListSelection.selectedValue;
  const transcriptViewerOpen = transcriptViewerStreamId !== undefined;
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
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
    taskDetailExecutionId !== undefined ||
    transcriptViewerOpen;
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
  const sessionViews = useMemo(
    () =>
      activeStreamTreeViews({
        activeStreamId,
        childStreamEntries,
        parentStream,
        streams,
      }),
    [activeStreamId, childStreamEntries, parentStream, streams],
  );
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
      });
    }
  }, [activeStreamId]);
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
  const focusSession = useCallback((streamId: StreamTabId) => {
    dispatchChildListSelection({ kind: 'focusStream', streamId });
    activeStreamIdSignal.set(streamId);
  }, []);
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    pendingApproval: activeApprovalVisible,
    taskDetailOpen: taskDetailProcess !== undefined,
    transcriptViewerOpen,
  });
  const approvalKind =
    foregroundKind === 'approval' ? pending?.payload.kind : undefined;
  const foregroundMaxRows = foregroundMaxRowsForKind({
    approvalKind,
    kind: foregroundKind,
  });
  function renderForegroundSurface(
    availableRows: number,
    transcriptWidth: number,
  ): React.ReactNode {
    switch (foregroundKind) {
      case 'transcript': {
        // foregroundKind is 'transcript' only while transcriptViewerOpen, so
        // transcriptViewerStreamId is set here — guard once to narrow it.
        if (!transcriptViewerStreamId) return null;
        return (
          <TranscriptViewer
            availableRows={availableRows}
            onClose={() => transcriptViewerStreamIdSignal.set(undefined)}
            slice={streams.get(transcriptViewerStreamId)}
            title={streamDisplayLabel({
              childStreamEntries,
              parentStream,
              streamId: transcriptViewerStreamId,
              streams,
            })}
            width={transcriptWidth}
          />
        );
      }
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
        return activeForm?.render(
          () => activeFormSignal.set(undefined),
          availableRows,
        );
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
  const pendingEscapeInterruptTimer = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const inputBarRef = useRef<InputBarHandle>(null);

  const clearPendingEscapeInterrupt = () => {
    if (pendingEscapeInterruptTimer.current === undefined) return;
    clearTimeout(pendingEscapeInterruptTimer.current);
    pendingEscapeInterruptTimer.current = undefined;
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
      if (activeStreamId) transcriptViewerStreamIdSignal.set(activeStreamId);
      return;
    }

    // Tab transfers keyboard ownership from the input to the child list.
    if (key.tab) {
      if (childListAvailable) {
        dispatchChildListSelection({ kind: 'focus' });
      }
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
          streamFocusAvailable: sessionViews.length > 0,
        })
      ) {
        scheduleEscapeInterrupt();
        return;
      }
      triggerEscapeInterrupt(escapeInterruptStateRef.current);
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
        onTranscriptViewportChange={props.onTranscriptViewportChange}
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
            />
            <StatusBar
              agentSelectionAvailable={agentSelectionAvailable}
              commandName={props.commandName}
              foregroundEscapeAction={foregroundEscapeAction({
                activeFormEscapeAction: activeForm?.escapeAction,
                approvalKind,
                foregroundKind,
              })}
              childListFocused={childListFocused}
              childListSelectionKind={selectedChildKind}
              childListSelectionKillable={selectedChildKillable}
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
          sessionViews,
          selectedChildValue,
          streams,
          activeSubagentExecutionIds,
          childListTarget,
          transcriptViewerStreamId,
        }}
        onCancelChildList={cancelChildList}
        onFocusSession={focusSession}
        onKillExecution={props.onKillExecution}
        onOpenProcessDetail={(executionId) =>
          taskDetailExecutionIdSignal.set(executionId)
        }
        onViewStream={(streamId) =>
          transcriptViewerStreamIdSignal.set(streamId)
        }
        onChildSelectionChange={(value) =>
          dispatchChildListSelection({ kind: 'highlight', value })
        }
      />
    </ActiveDraftScope>
  );
}
