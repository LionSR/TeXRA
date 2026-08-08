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
import { type StreamTabId } from '@shared/schemas';
import { SESSION_LIST } from '@shared/copy/nestedRuns';

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
  groupPendingApprovalsByRow,
  selectedChildRowWorkflowControllable,
  shouldDeferEscapeInterruptForMetaChord,
  triggerAppCtrlC,
  triggerEscapeInterrupt,
  type EscapeInterruptState,
} from './appInteractionPolicy';
import { ApprovalModal } from './modals/ApprovalModal';
import { InfoPane } from './panes/InfoPane';
import {
  TranscriptReader,
  transcriptReaderTitle,
} from './panes/TranscriptReader';
import { InputBar, type InputBarHandle } from './panes/InputBar';
import { ConversationRegion } from './panes/ConversationRegion';
import { StatusBar } from './panes/StatusBar';
import {
  currentApproval,
  pendingApprovalSummaries,
  promoteApprovalsForStream,
} from './state/approvalQueue';
import {
  isEscapeInput,
  isUnhandledControlInput,
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
  focusStream,
  rootRunStartAvailable as rootRunStartAvailableSignal,
  rootStreamId as rootStreamIdSignal,
  activeForm as activeFormSignal,
  closeInfoPane,
  closeTranscriptReader,
  formProgress as formProgressSignal,
  infoPane as infoPaneSignal,
  openTranscriptReader,
  transcriptReaderStreamId as transcriptReaderStreamIdSignal,
  reverseSearchOpen as reverseSearchOpenSignal,
  slashPaletteOpen as slashPaletteOpenSignal,
  streams as streamsSignal,
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
  childListStreamId,
  childStreamListValue,
  isWorkflowTaskListValue,
  workflowTaskListValue,
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListValue,
} from './state/childListSelection';
import {
  uniqueWorkflowChildStreamId,
  workflowDashboardModel,
} from './state/workflowDashboardModel';
import { streamDisplayLabel, streamTreeViews } from './state/streamViews';
import { useSignal } from './state/useSignal';
import type { InputHistory } from './history/inputHistory';

// Narrow subset of Ink's internal stdin emitter used to synthesize Enter.
interface InputEventEmitterLike {
  emit(event: 'input', data: string): void;
  on(event: 'input', listener: (data: string) => void): void;
  off(event: 'input', listener: (data: string) => void): void;
}

// Jump-to-waiting: surface the newly focused stream's pending approval right
// away instead of leaving it queued behind other streams' items. The root
// row also owns session-wide (stream-less) approvals.
function focusStreamAndPromoteApprovals(streamId: StreamTabId): void {
  focusStream(streamId);
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
  const transcriptReaderStreamId = useSignal(transcriptReaderStreamIdSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
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
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const activeDraftRegistry = useMemo(() => createActiveDraftRegistry(), []);
  const canStopActiveRun =
    props.canStopActiveRun ?? props.canInterruptActiveRun;
  const activeApprovalVisible = approvalVisibleForActiveStream({
    activeStreamId,
    pending,
  });
  // Walks the child-stream tree, so keep it at data-change frequency rather
  // than recomputing on every keystroke and elapsed-second render.
  const childListTarget = useMemo(
    () =>
      resolveChildListTarget({
        activeStreamId,
        childStreamEntries,
        parentStream,
        streams,
      }),
    [activeStreamId, childStreamEntries, parentStream, streams],
  );

  const stdin = useStdin();
  const foregroundOpen =
    activeApprovalVisible ||
    activeForm !== undefined ||
    infoPane !== undefined ||
    transcriptReaderStreamId !== undefined;
  const childInputDisabledMessage = focusedChildInputDisabledMessage({
    activeStreamId,
    parentStream,
    status: activeStreamId ? streams.get(activeStreamId)?.status : undefined,
  });
  const appInputDisabled =
    props.inputDisabled === true || foregroundOpen || childListFocused;
  const inputDisabledMessage = childListFocused
    ? SESSION_LIST.choosing
    : childInputDisabledMessage;
  const inputDisabled = appInputDisabled || inputDisabledMessage !== undefined;
  const escapeInterruptState: EscapeInterruptState = {
    inputDisabled: appInputDisabled,
    reverseSearchOpen,
    slashPaletteOpen,
    canInterruptStream: props.canInterruptStream,
    onInterruptStream: props.onInterruptStream,
  };
  const escapeInterruptStateRef = useRef(escapeInterruptState);
  useLayoutEffect(() => {
    escapeInterruptStateRef.current = escapeInterruptState;
  });
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
  const pendingApprovalsForRows = useMemo(
    () => groupPendingApprovalsByRow(pendingSummaries, rootStreamId),
    [pendingSummaries, rootStreamId],
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
  const workflowDashboardRoot =
    childListTarget.slice?.identity?.kind === 'multiAgentWorkflow'
      ? childListTarget.slice
      : undefined;
  // The same derivation `SubagentList` renders from: rows must not be grouped,
  // ordered, or deduplicated twice or the keyboard drifts off the screen.
  const workflowDashboard = useMemo(
    () =>
      workflowDashboardRoot
        ? workflowDashboardModel(workflowDashboardRoot, columns)
        : undefined,
    [columns, workflowDashboardRoot],
  );
  const childListValues = useMemo<readonly ChildListValue[]>(
    () =>
      workflowDashboard?.listValues ??
      sessionViews.map((session) => childStreamListValue(session.id)),
    [sessionViews, workflowDashboard],
  );
  const childListAvailable = childListValues.length > 0;
  const selectedWorkflowTask =
    selectedChildValue && workflowDashboard
      ? workflowDashboard.taskByValue.get(selectedChildValue)
      : undefined;
  const selectedWorkflowChildStreamId =
    selectedWorkflowTask && workflowDashboard
      ? uniqueWorkflowChildStreamId(
          selectedWorkflowTask,
          workflowDashboard.childTaskIndex,
          streams,
        )
      : undefined;
  const selectedChildStreamId =
    childListStreamId(selectedChildValue) ?? selectedWorkflowChildStreamId;
  const selectedChildKind =
    selectedChildStreamId !== undefined ? 'stream' : undefined;
  const selectedChildKillable =
    selectedChildStreamId !== undefined &&
    activeSubagentExecutionIds.has(selectedChildStreamId);
  const selectedChildWorkflowControllable =
    selectedChildRowWorkflowControllable({
      parentStream,
      selectedChildKillable,
      selectedChildStreamId,
      streams,
    });
  useEffect(() => {
    dispatchChildListSelection({
      kind: 'reconcile',
      activeStreamId: workflowDashboard ? undefined : activeStreamId,
      values: childListValues,
    });
  }, [activeStreamId, childListValues, workflowDashboard]);
  // Stream focus can also move through lifecycle completion or a numeric
  // accelerator. Align the selected row before the changed frame is painted;
  // ordinary row reconciliation still preserves manual list selection.
  useLayoutEffect(() => {
    if (childListActiveStreamRef.current === activeStreamId) return;
    childListActiveStreamRef.current = activeStreamId;
    if (!activeStreamId) return;
    if (workflowDashboard) {
      if (activeStreamId === workflowDashboard.root.streamId) return;
      const matchingTask = workflowDashboard.childTaskIndex.get(activeStreamId);
      if (matchingTask === null) return;
      if (matchingTask) {
        dispatchChildListSelection({
          kind: 'highlight',
          value: workflowTaskListValue(matchingTask.id),
        });
      } else {
        dispatchChildListSelection({
          kind: 'syncActiveStream',
          streamId: activeStreamId,
          values: childListValues,
        });
      }
      return;
    }
    dispatchChildListSelection({
      kind: 'syncActiveStream',
      streamId: activeStreamId,
      values: childListValues,
    });
  }, [activeStreamId, childListValues, workflowDashboard]);
  useEffect(() => {
    if (!childListAvailable && childListFocused) {
      dispatchChildListSelection({ kind: 'blur' });
    }
  }, [childListAvailable, childListFocused]);
  const cancelChildList = useCallback(() => {
    dispatchChildListSelection({ kind: 'blur' });
  }, []);
  const focusChildList = useCallback(() => {
    const firstChildValue = childListValues.at(0);
    if (firstChildValue) {
      dispatchChildListSelection({ kind: 'focus', value: firstChildValue });
    }
  }, [childListValues]);
  const focusSession = useCallback(
    (streamId: StreamTabId) => {
      if (isWorkflowTaskListValue(selectedChildValue)) {
        dispatchChildListSelection({ kind: 'blur' });
      } else {
        dispatchChildListSelection({ kind: 'focusStream', streamId });
      }
      focusStreamAndPromoteApprovals(streamId);
    },
    [selectedChildValue],
  );
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    formBusy,
    infoPaneOpen: infoPane !== undefined,
    pendingApproval: activeApprovalVisible,
    transcriptReaderOpen: transcriptReaderStreamId !== undefined,
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
      case 'transcriptReader': {
        if (!transcriptReaderStreamId) return null;
        const title = transcriptReaderTitle(
          streamDisplayLabel({
            childStreamEntries,
            parentStream,
            streamId: transcriptReaderStreamId,
            streams,
          }),
        );
        return (
          <TranscriptReader
            availableRows={availableRows}
            executionLabels={subagentExecutionLabels}
            onClose={closeTranscriptReader}
            streamId={transcriptReaderStreamId}
            title={title}
          />
        );
      }
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
        readonly parentStreamId: StreamTabId | undefined;
        readonly streamId: StreamTabId;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);
  const inputBarRef = useRef<InputBarHandle>(null);

  const clearPendingEscapeInterrupt = () => {
    const scheduled = pendingEscapeInterrupt.current;
    if (scheduled === undefined) return;
    clearTimeout(scheduled.timer);
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

  const appOwnsEscape = (): boolean => {
    const state = escapeInterruptStateRef.current;
    return appEscapeInterruptActive({
      inputDisabled: state.inputDisabled,
      reverseSearchOpen: state.reverseSearchOpen,
      runPending: true,
      slashPaletteOpen: state.slashPaletteOpen,
    });
  };

  const bareEscapeActive = (streamId: StreamTabId): boolean => {
    const state = escapeInterruptStateRef.current;
    return (
      appOwnsEscape() &&
      (parentStreamSignal.get().has(streamId) ||
        state.canInterruptStream(streamId))
    );
  };

  const handleBareEscape = (streamId: StreamTabId): boolean => {
    if (
      activeStreamIdSignal.get() !== streamId ||
      !bareEscapeActive(streamId)
    ) {
      return false;
    }
    const parentId = parentStreamSignal.get().get(streamId);
    if (parentId !== undefined) {
      focusStreamAndPromoteApprovals(parentId);
      if (
        selectedWorkflowChildStreamId === streamId &&
        workflowDashboard?.root.streamId === parentId
      ) {
        dispatchChildListSelection({ kind: 'focus' });
      }
      return true;
    }
    return triggerEscapeInterrupt(escapeInterruptStateRef.current, streamId);
  };

  const handlePendingBareEscape = (
    streamId: StreamTabId,
    parentStreamId: StreamTabId | undefined,
  ): boolean => {
    if (parentStreamSignal.get().get(streamId) !== parentStreamId) return false;
    return handleBareEscape(streamId);
  };

  const scheduleBareEscape = (streamId: StreamTabId) => {
    clearPendingEscapeInterrupt();
    const parentStreamId = parentStreamSignal.get().get(streamId);
    const timer = setTimeout(() => {
      pendingEscapeInterrupt.current = undefined;
      handlePendingBareEscape(streamId, parentStreamId);
    }, ESC_META_CHORD_INTERRUPT_DELAY_MS);
    pendingEscapeInterrupt.current = { parentStreamId, streamId, timer };
  };

  // Single App-level keyboard entry point. Ink broadcasts every keystroke to all
  // mounted useInput handlers, so keeping the App's shortcuts in one always-on
  // handler (gating internally) is clearer than several hooks racing on the same
  // chord. Stays mounted so Ctrl+C works even while a modal/form owns the input.
  useInput((input, key) => {
    const pendingEscape = pendingEscapeInterrupt.current;
    if (pendingEscape !== undefined) {
      clearPendingEscapeInterrupt();
      if (isEscapeInput(input, key)) {
        const previousStreamId = activeStreamIdSignal.get();
        const handledPendingEscape = handlePendingBareEscape(
          pendingEscape.streamId,
          pendingEscape.parentStreamId,
        );
        const currentStreamId = activeStreamIdSignal.get();
        if (
          currentStreamId === undefined ||
          (handledPendingEscape && currentStreamId === previousStreamId) ||
          !bareEscapeActive(currentStreamId)
        ) {
          return;
        }
        if (
          shouldDeferEscapeInterruptForMetaChord({
            shortcutModifierLabel: defaultShortcutModifierLabel(),
            streamFocusAvailable: sessionViews.length > 0,
          })
        ) {
          scheduleBareEscape(currentStreamId);
        } else {
          handleBareEscape(currentStreamId);
        }
        return;
      }
      const arrowInput =
        key.upArrow || key.downArrow || key.leftArrow || key.rightArrow;
      if (!key.ctrl && !key.tab && (input.length > 0 || arrowInput)) {
        if (appOwnsEscape() && handleMetaShortcut(input)) return;
        const inputWasDisabled = inputDisabled;
        const handled = handlePendingBareEscape(
          pendingEscape.streamId,
          pendingEscape.parentStreamId,
        );
        const printableInput =
          input.length > 0 &&
          !key.meta &&
          !key.return &&
          metaChordInput(input, key) === undefined &&
          [...input].every((character) => !isUnhandledControlInput(character));
        if (handled && inputWasDisabled && printableInput) {
          inputBarRef.current?.appendInput(input);
        }
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
      } else {
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
      }
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
      if (activeStreamId) openTranscriptReader(activeStreamId);
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

    // Bare Escape walks to the immediate parent before falling back to the
    // root run's existing interruption behavior.
    if (
      isEscapeInput(input, key) &&
      activeStreamId !== undefined &&
      bareEscapeActive(activeStreamId)
    ) {
      if (
        shouldDeferEscapeInterruptForMetaChord({
          shortcutModifierLabel: defaultShortcutModifierLabel(),
          streamFocusAvailable: sessionViews.length > 0,
        })
      ) {
        scheduleBareEscape(activeStreamId);
      } else {
        handleBareEscape(activeStreamId);
      }
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
            />
            <StatusBar
              agentSelectionAvailable={rootRunStartAvailable}
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
          sessionViews,
          selectedChildValue,
          streams,
          subagentExecutionLabels,
          activeSubagentExecutionIds,
          childListTarget,
          pendingApprovals: pendingApprovalsForRows,
        }}
        onCancelChildList={cancelChildList}
        onFocusSession={focusSession}
        onKillExecution={props.onKillExecution}
        onSkipExecution={props.onSkipExecution}
        onRetryExecution={props.onRetryExecution}
        onChildSelectionChange={(value) =>
          dispatchChildListSelection({ kind: 'highlight', value })
        }
      />
    </ActiveDraftScope>
  );
}
