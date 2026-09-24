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
import { type SessionHandle } from '@agent/runtime';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  isEscapeInput,
  isUnhandledControlInput,
  metaChordInput,
  rewriteKittyEnterInput,
} from '@cli/tui/inputKeys';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { type RunId, type WorkflowControlAction } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import { SESSION_LIST } from '@ui/copy/nestedRuns';
import {
  APPROVAL_FOREGROUND_MAX_ROWS,
  approvalVisibleForSelection,
  ESC_META_CHORD_INTERRUPT_DELAY_MS,
  FORM_FOREGROUND_MAX_ROWS,
  foregroundSurfaceKind,
  type ForegroundSurfaceKind,
} from './appInteractionPolicy';
import { ApprovalModal } from './modals/ApprovalModal';
import { InfoPane } from './panes/InfoPane';
import { WorkPlanReader } from './panes/WorkPlanReader';
import { TranscriptReader } from './panes/TranscriptReader';
import { WorkflowPopup } from './panes/WorkflowPopup';
import { InputBar, type InputBarHandle } from './panes/InputBar';
import { ConversationRegion } from './panes/ConversationRegion';
import { StatusBar } from './panes/StatusBar';
import { currentApproval, promoteApprovalsForRun } from './state/approvalQueue';
import {
  ActiveDraftScope,
  createActiveDraftRegistry,
} from './input/activeDraft';
import {
  isWorkflowScriptRun,
  presentRun,
  resolveChildListTarget,
} from './state/childControls';
import { activeForm, closeActiveForm } from './state/formSlot';
import {
  selectedRunId as selectedRunIdSignal,
  sessionViewFailure as sessionViewFailureSignal,
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

// Jump-to-waiting: surface the newly focused run's pending approval right
// away instead of leaving it queued behind other runs' items.
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

/** Labels for child executions whose label differs from the id. Returns
 *  `previous` when the content is unchanged, so layout caches keyed on the
 *  map's identity survive the fold ticks that do not touch a label. */
function runLabelsOf(view: SessionView, previous: RunLabels): RunLabels {
  const labels = new Map<string, string>();
  for (const run of view.runs.values()) {
    if (run.parentId !== null && run.label !== run.id) {
      labels.set(run.id, run.label);
    }
  }
  const unchanged =
    labels.size === previous.size &&
    [...labels].every(([id, label]) => previous.get(id) === label);
  return unchanged ? previous : labels;
}

export interface AppProps {
  /**
   * The secret store the status bar's subscription probes read, threaded from
   * the chat surface that opened it — this component runs no Effect.
   */
  readonly secrets: PlatformSecrets;
  /** The session's three setting slots, for the status bar's route probe. */
  readonly stores: SettingsStores;
  /**
   * The process runtime the input bar's history write and image paste run
   * on, threaded from the same chat surface — this component runs no Effect.
   */
  readonly runtime: ProcessRuntime;
  /** The chat's session: the approval modal's decisions land on it and the
   *  work-plan reader renders from it, threaded from the chat surface that
   *  opened it. */
  readonly session: SessionHandle;
  readonly onSubmit: (
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ) => void;
  readonly onKillRun: (runId: RunId) => void;
  /** Skip or retry a focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onWorkflowControl: (
    runId: RunId,
    action: WorkflowControlAction,
  ) => void;
  readonly colorEnabled?: boolean;
  readonly commandName?: string;
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
  const sessionViewFailure = useSignal(sessionViewFailureSignal);
  const foregroundForm = useSignal(activeForm);
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
  const runLabelsRef = useRef<RunLabels>(new Map());
  const subagentRunLabels = useMemo(
    () => (runLabelsRef.current = runLabelsOf(view, runLabelsRef.current)),
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
    activeFormOpen: foregroundForm !== undefined,
    formBusy,
    infoPaneOpen: infoPane !== undefined,
    pendingApproval: activeApprovalVisible,
    readerOpen: foregroundReader !== undefined,
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
    : (sessionViewFailure ?? unavailableDetail);
  const inputDisabled =
    appInputDisabled ||
    childInputHidden ||
    unavailableDetail !== undefined ||
    sessionViewFailure !== undefined;
  // One gate for "the App owns the keyboard": focus shortcuts and bare Escape
  // both derive from these same three facts.
  const focusShortcutsActive =
    !appInputDisabled && !slashPaletteOpen && !reverseSearchOpen;
  // Bare Escape's deferred chord timer reads the committed render's gate
  // through this ref.
  const focusShortcutsActiveRef = useRef(focusShortcutsActive);
  useLayoutEffect(() => {
    focusShortcutsActiveRef.current = focusShortcutsActive;
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
  const childRunningCount = runningChildCount(
    view,
    runViewOf(view, childListTarget),
  );
  const workflowPopup = useSignal(workflowPopupViewSignal);
  const childListValues = sessions;
  const childListAvailable = childListValues.length > 0;
  const selectedChild = runViewOf(view, selectedChildValue);
  const selectedChildKillable = killableRunId(selectedChild) !== undefined;
  const reconcileSelection = {
    kind: 'reconcile' as const,
    activeRunId,
    values: childListValues,
  };
  if (
    reduceChildListSelection(childListSelection, reconcileSelection) !==
    childListSelection
  ) {
    dispatchChildListSelection(reconcileSelection);
  }
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
    const run = view.runs.get(runId)!;
    if (run.group === 'interrupted' && run.resumeEligible) {
      props.onSubmit(`/resume ${run.id}`);
    } else {
      focusRunAndPromoteApprovals(runId);
    }
  };
  const archiveInfoPane = useCallback((lines: readonly string[]) => {
    if (infoPaneSignal.get()?.lines !== lines) return;
    closeInfoPane();
    appendLocalAssistantTranscript(lines.join('\n'));
  }, []);
  function renderReader(
    reader: NonNullable<typeof foregroundReader>,
    availableRows: number,
  ): React.ReactNode {
    const run = runViewOf(view, reader.runId);
    const label = run ? runLabelOf(run) : reader.runId;
    switch (reader.kind) {
      case 'transcript':
        return (
          <TranscriptReader
            availableRows={availableRows}
            runLabels={subagentRunLabels}
            onClose={() => {
              // A workflow's log is only ever opened from its popup (a
              // workflow is never a viewport), so closing it goes back there.
              if (isWorkflowScriptRun(view, reader.runId)) {
                openWorkflowPopup(reader.runId);
              } else {
                closeForegroundReader();
              }
            }}
            runId={reader.runId}
            title={`Transcript: ${label}`}
          />
        );
      case 'workflow': {
        const model = run?.transcript.run ?? undefined;
        if (model === undefined) return null;
        return (
          <WorkflowPopup
            availableRows={availableRows}
            model={model}
            onClose={closeForegroundReader}
            onFocusRun={(runId) => {
              closeForegroundReader();
              focusRunAndPromoteApprovals(runId);
            }}
            onKillRun={props.onKillRun}
            onOpenTranscript={openTranscriptReader}
            onViewChange={updateWorkflowPopupView}
            onWorkflowControl={props.onWorkflowControl}
            runId={reader.runId}
            view={workflowPopup}
          />
        );
      }
      case 'workPlan':
        return (
          <WorkPlanReader
            availableRows={availableRows}
            loading={reader.loading === true}
            onClose={closeForegroundReader}
            runId={reader.runId}
            session={props.session}
            title={`Work plan: ${label}`}
          />
        );
    }
  }
  // One row per foreground surface: its row cap and how it renders. Which
  // surface is up is `foregroundSurfaceKind`'s precedence. A reader, like the
  // info pane, takes every row the layout can spare.
  const foregroundSurfaces: Record<
    ForegroundSurfaceKind,
    {
      readonly maxRows: number | undefined;
      readonly render: (availableRows: number) => React.ReactNode;
    }
  > = {
    form: {
      maxRows: FORM_FOREGROUND_MAX_ROWS,
      render: (availableRows) =>
        foregroundForm?.render(() => {
          formProgressSignal.set(undefined);
          // Through the slot owner, which hands the slot to whichever form
          // queued behind this one. A form that already lost the slot can
          // still run this from an in-flight operation, and the owner ignores
          // that close rather than unmounting whatever took its place, which
          // would leave a host dialog's fiber with no form to answer it and
          // its lane permit held for the session.
          closeActiveForm(foregroundForm);
        }, availableRows),
    },
    infoPane: {
      maxRows: undefined,
      render: (availableRows) =>
        infoPane ? (
          <InfoPane
            availableRows={availableRows}
            colorEnabled={props.colorEnabled}
            lines={infoPane.lines}
            onClose={closeInfoPane}
            onOverflow={archiveInfoPane}
            title={infoPane.title}
          />
        ) : null,
    },
    approval: {
      maxRows: pending && APPROVAL_FOREGROUND_MAX_ROWS[pending.payload.kind],
      render: (availableRows) =>
        pending ? (
          <ApprovalModal
            runtime={props.runtime}
            session={props.session}
            availableRows={availableRows}
            goalAutoApproveAll={goalAutoApproveAll}
            pending={pending}
          />
        ) : null,
    },
    reader: {
      maxRows: undefined,
      render: (availableRows) =>
        foregroundReader && renderReader(foregroundReader, availableRows),
    },
  };
  const foregroundSurface =
    foregroundKind === undefined
      ? undefined
      : foregroundSurfaces[foregroundKind];

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

  useEffect(() => clearPendingEscapeInterrupt, []);

  const handleMetaShortcut = (value: string): boolean => {
    if (!/^[1-9]$/.test(value)) return false;
    const target = sessionListRunIds.get()[Number(value) - 1];
    if (!target) return false;
    focusRunAndPromoteApprovals(target);
    return true;
  };

  const appOwnsEscape = (): boolean => focusShortcutsActiveRef.current;

  const parentIdOf = (runId: RunId): RunId | undefined =>
    runViewOf(currentView(), runId)?.parentId ?? undefined;
  // Bare Escape only navigates: it never stops a run (Ctrl-C does), so an
  // extra Escape after closing a panel cannot cost the user their turn.
  const bareEscapeActive = (runId: RunId): boolean =>
    appOwnsEscape() && parentIdOf(runId) !== undefined;

  const handleBareEscape = (runId: RunId): boolean => {
    if (selectedRunIdSignal.get() !== runId || !bareEscapeActive(runId)) {
      return false;
    }
    focusRunAndPromoteApprovals(parentIdOf(runId)!);
    return true;
  };

  const handlePendingBareEscape = (
    runId: RunId,
    parentRunId: RunId | undefined,
  ): boolean => parentIdOf(runId) === parentRunId && handleBareEscape(runId);

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
  // handle the escape immediately. Bare Esc must give a numbered run-focus
  // chord a chance to resolve while that binding is on screen; `Alt`-chord
  // platforms are unaffected, since their Esc+key sequences arrive as one
  // burst, resolved synchronously by `metaChordInput`.
  const deferOrHandleBareEscape = (runId: RunId): void => {
    if (defaultShortcutModifierLabel() === 'Esc' && sessions.length > 0) {
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
    // A background draft never consumes Ctrl+C: only the composer the keyboard
    // is on discards.
    if (key.ctrl && input === 'c') {
      if (formBusy) {
        formProgress?.cancel();
      } else if (
        !activeDraftRegistry.discard() &&
        (inputDisabled ||
          reverseSearchOpen ||
          childListFocused ||
          !(inputBarRef.current?.discardDraft() ?? false))
      ) {
        props.onCtrlC();
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

    // Esc/Alt 1-9 focuses a run directly in the persistent list order.
    const metaInput = metaChordInput(input, key);
    if (metaInput) {
      handleMetaShortcut(metaInput);
      return;
    }

    // Bare Escape walks to the immediate parent. It is deferred even where
    // it has nowhere to go, so an `Esc 1..9` chord on the root still resolves;
    // `handleBareEscape` re-checks for a parent when the timer fires.
    if (
      isEscapeInput(input, key) &&
      activeRunId !== undefined &&
      appOwnsEscape()
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
              runtime={props.runtime}
              roots={props.session.roots}
              controlRef={inputBarRef}
              onSubmit={props.onSubmit}
              collapseWhenDisabled={!inputBarVisible}
              disabledMessage={inputDisabledMessage}
              disabled={inputDisabled}
              history={props.history}
              keyboardActive={!childListFocused}
            />
            <StatusBar
              secrets={props.secrets}
              stores={props.stores}
              runtime={props.runtime}
              chatInputAvailable={
                !childInputHidden && unavailableDetail === undefined
              }
              commandName={props.commandName}
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
              transcriptAvailable={(activeRun?.transcript.rows.length ?? 0) > 0}
            />
          </>
        )}
        renderForegroundSurface={(availableRows) =>
          foregroundSurface?.render(availableRows)
        }
        rows={rows}
        snapshot={{
          foregroundMaxRows: foregroundSurface?.maxRows,
          foregroundKind,
          childListFocused,
          selectedChildValue,
          subagentRunLabels,
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
