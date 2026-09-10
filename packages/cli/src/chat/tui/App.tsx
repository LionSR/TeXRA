// Ink root: conversation and optional panels above stable status, approval, and input chrome.

// Third-party imports
import { useInput, useStdin, useWindowSize } from 'ink';
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
import {
  isEscapeInput,
  isUnhandledControlInput,
  metaChordInput,
  rewriteKittyEnterInput,
} from '@cli/tui/inputKeys';
import { type RunId, type WorkflowControlAction } from '@shared/schemas';
import { SESSION_LIST } from '@shared/copy/nestedRuns';
import type { SessionView } from '@shared/session/sessionView';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import {
  appDraftDiscardActive,
  approvalVisibleForSelection,
  digitFromMetaShortcut,
  ESC_META_CHORD_INTERRUPT_DELAY_MS,
  foregroundEscapeAction,
  foregroundMaxRowsForKind,
  foregroundSurfaceKind,
  groupPendingApprovalsByRow,
  shouldDeferEscapeInterruptForMetaChord,
  triggerAppCtrlC,
  type EscapeInterruptState,
} from './appInteractionPolicy';
import { ApprovalModal } from './modals/ApprovalModal';
import { InfoPane } from './panes/InfoPane';
import { WorkPlanReader } from './panes/WorkPlanReader';
import { TranscriptReader } from './panes/TranscriptReader';
import { WorkflowPopup } from './panes/WorkflowPopup';
import { InputBar, type InputBarHandle } from './panes/InputBar';
import { ConversationRegion } from './panes/ConversationRegion';
import { StatusBar } from './panes/StatusBar';
import {
  currentApproval,
  promoteApprovalsForRun,
} from './state/approvalQueue';
import {
  ActiveDraftScope,
  createActiveDraftRegistry,
} from './input/activeDraft';
import {
  isWorkflowScriptRun,
  presentRun,
  resolveChildListTarget,
} from './state/childControls';
import {
  selectedRunId as selectedRunIdSignal,
  rootRunId as rootRunIdSignal,
  activeForm as activeFormSignal,
  closeInfoPane,
  closeForegroundReader,
  foregroundReader as foregroundReaderSignal,
  formProgress as formProgressSignal,
  goalAutoApproveAll as goalAutoApproveAllSignal,
  infoPane as infoPaneSignal,
  openTranscriptReader,
  openWorkflowPopup,
  updateWorkflowPopupView,
  workflowPopupView as workflowPopupViewSignal,
  reverseSearchOpen as reverseSearchOpenSignal,
  slashPaletteOpen as slashPaletteOpenSignal,
  sessionListRows,
  sessionListRunIds,
} from './state/cliState';
import { appendLocalAssistantTranscript } from './state/transcript';
import {
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
} from './state/childListSelection';
import {
  currentView,
  killableRunId,
  sessionView,
  runLabelOf,
  runViewOf,
  focusedChildAcceptsFollowUps,
  runningChildCount,
} from './state/sessionView';
import { useSignal } from './state/useSignal';
import type { InputHistory } from './history/inputHistory';
import type { PastedImageEntry } from './input/draftAttachments';

interface InputEventEmitterLike {
  emit(event: 'input', data: string): void;
  on(event: 'input', listener: (data: string) => void): void;
  off(event: 'input', listener: (data: string) => void): void;
}

// Jump-to-waiting: surface the newly focused stream's pending approval right
// away instead of leaving it queued behind other runs' items. The visible
// list-root row also owns session-wide (stream-less) approvals.
function focusRunAndPromoteApprovals(runId: RunId): void {
  const view = currentView();
  if (presentRun(runId) === 'workflowPopup') {
    promoteApprovalsForRun(runId, {
      includeRunIds: new Set(runViewOf(view, runId)?.childIds ?? []),
    });
    return;
  }
  promoteApprovalsForRun(runId);
}

/** Labels for child executions whose label differs from the id. */
function runLabelsOf(view: SessionView): RunLabels {
  const labels = new Map<string, string>();
  for (const stream of view.runs.values()) {
    if (stream.parentId !== null && stream.label !== stream.runId) {
      labels.set(stream.runId, stream.label);
    }
  }
  return labels;
}

export interface AppProps {
  readonly onSubmit: (
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ) => void;
  readonly onKillRun: (runId: string) => void;
  /** Skip or retry a focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onWorkflowControl: (
    runId: string,
    action: WorkflowControlAction,
  ) => void;
  /** Whether bare Escape may stop the identified focused stream. */
  readonly canInterruptRun: (runId: RunId) => boolean;
  readonly colorEnabled?: boolean;
  readonly commandName?: string;
  /** Stop only the focused stream captured by bare Escape. */
  readonly onInterruptRun: (runId: RunId) => void;
  readonly onStaticTranscriptChange?: () => void;
  /** Hand the second Ctrl+C (the one no draft consumed) to the host's SIGINT
   *  policy. Required: the App owns draft discard, never process lifecycle. */
  readonly onCtrlC: () => void;
  /** Suspend the process (Ctrl-Z). Raw mode swallows the tty driver's own
   *  ^Z→SIGTSTP translation, so the parsed key must be routed explicitly. */
  readonly onSuspend?: () => void;
  readonly history?: InputHistory;
}

export function App(props: AppProps): React.JSX.Element {
  const view = useSignal(sessionView());
  const pending = useSignal(currentApproval);
  // The selection and the reader arrive already resolved against the view
  // (their signals own that rule), so render derives from settled values.
  const activeRunId = useSignal(selectedRunIdSignal);
  const rootRunId = useSignal(rootRunIdSignal);
  const activeForm = useSignal(activeFormSignal);
  const formProgress = useSignal(formProgressSignal);
  const goalAutoApproveAll = useSignal(goalAutoApproveAllSignal);
  const infoPane = useSignal(infoPaneSignal);
  const foregroundReader = useSignal(foregroundReaderSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const formBusy = formProgress?.status === 'running';
  const [childListSelection, dispatchChildListSelection] = useReducer(
    reduceChildListSelection,
    INITIAL_CHILD_LIST_SELECTION,
  );
  const childListActiveRunRef = useRef(activeRunId);
  const childListFocused = childListSelection.focused;
  const selectedChildValue = childListSelection.selectedValue;
  const { columns, rows } = useWindowSize();
  const activeDraftRegistry = useMemo(() => createActiveDraftRegistry(), []);
  const activeRun = runViewOf(view, activeRunId);
  const activeParentId = activeRun?.parentId ?? undefined;
  const subagentRunLabels = useMemo(
    () => runLabelsOf(view),
    [view],
  );
  const activeApprovalVisible = approvalVisibleForSelection({
    pending,
    selectedRunId: activeRunId,
    view,
  });
  const childListTarget = resolveChildListTarget(view, activeRunId);
  const stdin = useStdin();
  // One owner of "a foreground surface is up": the surface kind itself.
  // `undefined` is exactly the no-surface case (every reader target carries a
  // `kind`), so nothing derives that fact a second time and the two can never
  // disagree.
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    formBusy,
    infoPaneOpen: infoPane !== undefined,
    pendingApproval: activeApprovalVisible,
    readerKind: foregroundReader?.kind,
  });
  const foregroundOpen = foregroundKind !== undefined;
  const childInputHidden =
    activeRun !== undefined &&
    activeRun.parentId !== null &&
    !focusedChildAcceptsFollowUps(activeRun);
  const unavailableDetail = activeRun?.readOnly
    ? (activeRun.statusDetail ?? activeRun.statusLabel)
    : undefined;
  const appInputDisabled = foregroundOpen || childListFocused;
  const inputDisabledMessage = childListFocused
    ? SESSION_LIST.choosing
    : unavailableDetail;
  const inputDisabled =
    appInputDisabled || childInputHidden || unavailableDetail !== undefined;
  // One gate for "the App owns the keyboard": focus shortcuts and bare Escape
  // both derive from these same three facts.
  const focusShortcutsActive =
    !appInputDisabled && !slashPaletteOpen && !reverseSearchOpen;
  const escapeInterruptState: EscapeInterruptState = {
    shortcutsActive: focusShortcutsActive,
    canInterruptRun: props.canInterruptRun,
    onInterruptRun: props.onInterruptRun,
  };
  const escapeInterruptStateRef = useRef(escapeInterruptState);
  useLayoutEffect(() => {
    escapeInterruptStateRef.current = escapeInterruptState;
  });
  const inputBarVisible =
    !foregroundOpen &&
    (!childInputHidden || childListFocused || unavailableDetail !== undefined);

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

  const sessions = useSignal(sessionListRunIds);
  const sessionRows = useSignal(sessionListRows);
  const childRunningCount = runningChildCount(
    view,
    runViewOf(view, childListTarget),
  );
  const workflowPopupRunId =
    foregroundReader?.kind === 'workflow'
      ? foregroundReader.runId
      : undefined;
  const workflowPopupRoot = runViewOf(view, workflowPopupRunId);
  const workflowPopupModel = workflowPopupRoot?.transcript.run ?? undefined;
  const workflowPopup = useSignal(workflowPopupViewSignal);
  const pendingApprovalsForRows = useMemo(
    () => groupPendingApprovalsByRow(view.approvals),
    [view.approvals],
  );
  const childListValues = sessions;
  const childListAvailable = childListValues.length > 0;
  const selectedChild = runViewOf(view, selectedChildValue);
  const selectedChildKillable =
    killableRunId(selectedChild) !== undefined;
  useEffect(() => {
    dispatchChildListSelection({
      kind: 'reconcile',
      activeRunId,
      values: childListValues,
    });
  }, [activeRunId, childListValues]);
  // Stream focus can also move through lifecycle completion or a numeric
  // accelerator. Align the selected row before the changed frame is painted;
  // ordinary row reconciliation still preserves manual list selection.
  useLayoutEffect(() => {
    if (childListActiveRunRef.current === activeRunId) return;
    childListActiveRunRef.current = activeRunId;
    if (!activeRunId) return;
    dispatchChildListSelection({
      kind: 'syncActiveRun',
      runId: activeRunId,
      values: childListValues,
    });
  }, [activeRunId, childListValues]);
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
  const focusSession = (runId: RunId): void => {
    dispatchChildListSelection({ kind: 'focusRun', runId });
    const stream = view.runs.get(runId)!;
    if (stream.group === 'interrupted' && stream.resumeEligible) {
      props.onSubmit(`/resume ${stream.runId}`);
    } else {
      focusRunAndPromoteApprovals(runId);
    }
  };
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
          <ApprovalModal
            availableRows={availableRows}
            goalAutoApproveAll={goalAutoApproveAll}
            pending={pending}
          />
        ) : null;
      case 'transcriptReader': {
        if (foregroundReader?.kind !== 'transcript') return null;
        const stream = runViewOf(view, foregroundReader.runId);
        const label = stream
          ? runLabelOf(stream)
          : foregroundReader.runId;
        return (
          <TranscriptReader
            availableRows={availableRows}
            runLabels={subagentRunLabels}
            onClose={() => {
              // A workflow's log is only ever opened from its popup (a
              // workflow is never a viewport), so closing it goes back there.
              if (isWorkflowScriptRun(view, foregroundReader.runId)) {
                openWorkflowPopup(foregroundReader.runId);
              } else {
                closeForegroundReader();
              }
            }}
            runId={foregroundReader.runId}
            title={`Transcript: ${label}`}
          />
        );
      }
      case 'workflowPopup': {
        if (
          foregroundReader?.kind !== 'workflow' ||
          workflowPopupModel === undefined
        ) {
          return null;
        }
        return (
          <WorkflowPopup
            availableRows={availableRows}
            model={workflowPopupModel}
            onClose={closeForegroundReader}
            onFocusRun={(runId) => {
              closeForegroundReader();
              focusRunAndPromoteApprovals(runId);
            }}
            onKillRun={props.onKillRun}
            onOpenTranscript={openTranscriptReader}
            onViewChange={updateWorkflowPopupView}
            onWorkflowControl={props.onWorkflowControl}
            pendingApprovals={pendingApprovalsForRows}
            runId={foregroundReader.runId}
            view={workflowPopup}
          />
        );
      }
      case 'workPlanReader': {
        if (foregroundReader?.kind !== 'workPlan') return null;
        const stream = runViewOf(view, foregroundReader.runId);
        const label = stream
          ? runLabelOf(stream)
          : foregroundReader.runId;
        return (
          <WorkPlanReader
            availableRows={availableRows}
            loading={foregroundReader.loading === true}
            onClose={closeForegroundReader}
            runId={foregroundReader.runId}
            title={`Work plan: ${label}`}
          />
        );
      }
      case undefined:
        return null;
    }
  }

  const pendingEscapeInterrupt = useRef<
    | {
        readonly parentRunId: RunId | undefined;
        readonly runId: RunId;
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
      const target = sessionListRunIds.get()[digit - 1];
      if (!target) return false;
      focusRunAndPromoteApprovals(target);
      return true;
    }
    return false;
  };

  const appOwnsEscape = (): boolean =>
    escapeInterruptStateRef.current.shortcutsActive;

  const parentIdOf = (runId: RunId): RunId | undefined =>
    runViewOf(currentView(), runId)?.parentId ?? undefined;
  const bareEscapeActive = (runId: RunId): boolean => {
    const state = escapeInterruptStateRef.current;
    return (
      appOwnsEscape() &&
      (parentIdOf(runId) !== undefined || state.canInterruptRun(runId))
    );
  };

  const handleBareEscape = (runId: RunId): boolean => {
    if (
      selectedRunIdSignal.get() !== runId ||
      !bareEscapeActive(runId)
    ) {
      return false;
    }
    const parentId = parentIdOf(runId);
    if (parentId !== undefined) {
      focusRunAndPromoteApprovals(parentId);
      return true;
    }
    // `bareEscapeActive` already proved `canInterruptRun(runId)` for a
    // parentless stream: `parentRun` never stores an undefined value, so
    // once `.get()` returned undefined the `has` disjunct is false too.
    escapeInterruptStateRef.current.onInterruptRun(runId);
    return true;
  };

  const handlePendingBareEscape = (
    runId: RunId,
    parentRunId: RunId | undefined,
  ): boolean => {
    if (parentIdOf(runId) !== parentRunId) return false;
    return handleBareEscape(runId);
  };

  const scheduleBareEscape = (runId: RunId) => {
    clearPendingEscapeInterrupt();
    const parentRunId = parentIdOf(runId);
    const timer = setTimeout(() => {
      pendingEscapeInterrupt.current = undefined;
      handlePendingBareEscape(runId, parentRunId);
    }, ESC_META_CHORD_INTERRUPT_DELAY_MS);
    pendingEscapeInterrupt.current = { parentRunId, runId, timer };
  };

  // Shared tail of both bare-Escape trigger sites below: defer through the
  // meta-chord disambiguation window when one may be in flight, otherwise
  // handle the escape immediately.
  const deferOrHandleBareEscape = (runId: RunId): void => {
    if (
      shouldDeferEscapeInterruptForMetaChord({
        shortcutModifierLabel: defaultShortcutModifierLabel(),
        runFocusAvailable: sessions.length > 0,
      })
    ) {
      scheduleBareEscape(runId);
    } else {
      handleBareEscape(runId);
    }
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
        const previousRunId = selectedRunIdSignal.get();
        const handledPendingEscape = handlePendingBareEscape(
          pendingEscape.runId,
          pendingEscape.parentRunId,
        );
        const currentRunId = selectedRunIdSignal.get();
        if (
          currentRunId === undefined ||
          (handledPendingEscape && currentRunId === previousRunId) ||
          !bareEscapeActive(currentRunId)
        ) {
          return;
        }
        deferOrHandleBareEscape(currentRunId);
        return;
      }
      const arrowInput =
        key.upArrow || key.downArrow || key.leftArrow || key.rightArrow;
      if (!key.ctrl && !key.tab && (input.length > 0 || arrowInput)) {
        if (appOwnsEscape() && handleMetaShortcut(input)) return;
        const inputWasDisabled = inputDisabled;
        const handled = handlePendingBareEscape(
          pendingEscape.runId,
          pendingEscape.parentRunId,
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
    // Ctrl+C out of useInput. Draft discard is the App's half; everything past
    // it is the mount's SIGINT policy, wired through the required `onCtrlC`.
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
      if (activeRunId) openTranscriptReader(activeRunId);
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
      activeRunId !== undefined &&
      bareEscapeActive(activeRunId)
    ) {
      deferOrHandleBareEscape(activeRunId);
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
        inputBarVisible={inputBarVisible}
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
              chatInputAvailable={
                !childInputHidden && unavailableDetail === undefined
              }
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
              childListSelectionKillable={selectedChildKillable}
              childListSelectionResumable={
                selectedChild?.group === 'interrupted' &&
                selectedChild.resumeEligible
              }
              childNavigationAvailable={childListAvailable}
              runningSessions={childRunningCount}
              runFocusAvailable={sessions.length > 0}
              transcriptAvailable={
                (activeRun?.transcript.rows.length ?? 0) > 0
              }
            />
          </>
        )}
        renderForegroundSurface={renderForegroundSurface}
        rows={rows}
        snapshot={{
          activeRunId,
          foregroundMaxRows,
          foregroundKind,
          parentId: activeParentId,
          reverseSearchOpen,
          rootRunId,
          slashPaletteOpen,
          childListFocused,
          sessionRows,
          selectedChildValue,
          subagentRunLabels,
          pendingApprovals: pendingApprovalsForRows,
        }}
        onCancelChildList={cancelChildList}
        onFocusSession={focusSession}
        onKillRun={props.onKillRun}
        onChildSelectionChange={(value) =>
          dispatchChildListSelection({ kind: 'highlight', value })
        }
      />
    </ActiveDraftScope>
  );
}
