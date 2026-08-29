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
import { type StreamTabId, type WorkflowControlAction } from '@shared/schemas';
import {
  isActivePhase,
  workflowRunSettled,
} from '@shared/streams/streamStatus';
import { SESSION_LIST } from '@shared/copy/nestedRuns';

// Local imports - TUI surfaces and state
import {
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/streams/workflowRunModel';
import {
  appDraftDiscardActive,
  approvalVisibleForActiveStream,
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
import { WorkPlanReader, workPlanReaderTitle } from './panes/WorkPlanReader';
import {
  TranscriptReader,
  transcriptReaderTitle,
} from './panes/TranscriptReader';
import { WorkflowPopup } from './panes/WorkflowPopup';
import { InputBar, type InputBarHandle } from './panes/InputBar';
import { ConversationRegion } from './panes/ConversationRegion';
import { StatusBar } from './panes/StatusBar';
import {
  approvalPayloadStreamId,
  currentApproval,
  pendingApprovalSummaries,
  promoteApprovalsForStream,
} from './state/approvalQueue';
import {
  ActiveDraftScope,
  createActiveDraftRegistry,
} from './input/activeDraft';
import {
  isWorkflowScriptStream,
  numericFocusTargetForActiveStream,
  presentStream,
  resolveChildListTarget,
} from './state/childControls';
import {
  activeStreamId as activeStreamIdSignal,
  rootStreamId as rootStreamIdSignal,
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
  streams as streamsSignal,
  streamPhaseFor,
} from './state/cliState';
import { appendLocalAssistantTranscript } from './state/transcript';
import {
  activeSubagentsFor,
  childRosters as childRostersSignal,
  parentStream as parentStreamSignal,
  sessionStateRevision,
  streamMetadataFor,
  streamStateFor,
  subagentExecutionLabels as subagentExecutionLabelsSignal,
  visibleSubagentRows,
} from './state/childExecutions';
import {
  readStreamArtifacts,
  streamArtifactRevision,
} from './state/subscribeStreamArtifacts';
import { focusedChildFollowUpRoute } from './state/focusedChildFollowUp';
import {
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListValue,
} from './state/childListSelection';
import { streamLabelForId, streamTreeViews } from './state/streamViews';
import { useSignal } from './state/useSignal';
import type { InputHistory } from './history/inputHistory';
import type { PastedImageEntry } from './input/draftAttachments';

// Narrow subset of Ink's internal stdin emitter used to synthesize Enter.
interface InputEventEmitterLike {
  emit(event: 'input', data: string): void;
  on(event: 'input', listener: (data: string) => void): void;
  off(event: 'input', listener: (data: string) => void): void;
}

// Jump-to-waiting: surface the newly focused stream's pending approval right
// away instead of leaving it queued behind other streams' items. The visible
// list-root row also owns session-wide (stream-less) approvals.
function focusStreamAndPromoteApprovals(streamId: StreamTabId): void {
  // A workflow-script run presents as a popup over its parent (the rule
  // lives in `presentStream`); the popup's own stream owns the approvals
  // that surface.
  if (presentStream(streamId) === 'workflowPopup') {
    promoteApprovalsForStream(streamId, { includeSessionWide: false });
    return;
  }
  const visibleListRootStreamId = resolveChildListTarget({
    activeStreamId: streamId,
    childRosters: childRostersSignal.get(),
    parentStream: parentStreamSignal.get(),
    streams: streamsSignal.get(),
  });
  promoteApprovalsForStream(streamId, {
    includeSessionWide: streamId === visibleListRootStreamId,
  });
}

export interface AppProps {
  readonly onSubmit: (
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ) => void;
  readonly onKillExecution: (executionId: string) => void;
  /** Skip or retry a focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onWorkflowControl: (
    executionId: string,
    action: WorkflowControlAction,
  ) => void;
  /** Whether bare Escape may stop the identified focused stream. */
  readonly canInterruptStream: (streamId: StreamTabId) => boolean;
  readonly colorEnabled?: boolean;
  readonly commandName?: string;
  /** Stop only the focused stream captured by bare Escape. */
  readonly onInterruptStream: (streamId: StreamTabId) => void;
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
  // Single subscription site; pass the value down so ApprovalModal renders
  // off the same read and InputBar can stay mounted but disabled.
  const pending = useSignal(currentApproval);
  const activeStreamId = useSignal(activeStreamIdSignal);
  const rootStreamId = useSignal(rootStreamIdSignal);
  const streams = useSignal(streamsSignal);
  const parentStream = useSignal(parentStreamSignal);
  const childRosters = useSignal(childRostersSignal);
  const subagentExecutionLabels = useSignal(subagentExecutionLabelsSignal);
  const activeForm = useSignal(activeFormSignal);
  const formProgress = useSignal(formProgressSignal);
  const goalAutoApproveAll = useSignal(goalAutoApproveAllSignal);
  const infoPane = useSignal(infoPaneSignal);
  const foregroundReader = useSignal(foregroundReaderSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  // Render reads shared stream metadata through `streamMetadataFor`; the
  // revision signal re-renders on metadata changes the roster signal misses.
  const sessionRevision = useSignal(sessionStateRevision);
  const artifactRevision = useSignal(streamArtifactRevision);
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
  const activeDraftRegistry = useMemo(() => createActiveDraftRegistry(), []);
  // While a workflow's popup or its log is in the foreground, that stream is
  // the one whose approvals show: it is where the user is looking, not the
  // parent under it.
  const foregroundWorkflowStreamId =
    foregroundReader !== undefined &&
    isWorkflowScriptStream(foregroundReader.streamId)
      ? foregroundReader.streamId
      : undefined;
  const pendingApprovalStreamId = pending
    ? approvalPayloadStreamId(pending.payload)
    : undefined;
  const foregroundApprovalStreamId =
    foregroundWorkflowStreamId !== undefined &&
    pendingApprovalStreamId !== undefined &&
    (parentStream.get(pendingApprovalStreamId) === foregroundWorkflowStreamId ||
      childRosters
        .get(foregroundWorkflowStreamId)
        ?.some((child) => child.childStreamId === pendingApprovalStreamId))
      ? pendingApprovalStreamId
      : foregroundWorkflowStreamId;
  const activeApprovalVisible = approvalVisibleForActiveStream({
    activeStreamId: foregroundApprovalStreamId ?? activeStreamId,
    pending,
  });
  // Walks the child-stream tree, so keep it at data-change frequency rather
  // than recomputing on every keystroke and elapsed-second render.
  const childListTarget = useMemo(
    () =>
      resolveChildListTarget({
        activeStreamId,
        childRosters,
        parentStream,
        streams,
      }),
    [activeStreamId, childRosters, parentStream, streams],
  );

  const stdin = useStdin();
  const foregroundOpen =
    activeApprovalVisible ||
    activeForm !== undefined ||
    infoPane !== undefined ||
    foregroundReader !== undefined;
  const childInputHidden =
    focusedChildFollowUpRoute({
      activeStreamId,
      parentStream,
      metadata: activeStreamId ? streamMetadataFor(activeStreamId) : undefined,
    }).kind === 'reject';
  const appInputDisabled = foregroundOpen || childListFocused;
  const inputDisabledMessage = childListFocused
    ? SESSION_LIST.choosing
    : undefined;
  const inputDisabled = appInputDisabled || childInputHidden;
  // One gate for "the App owns the keyboard": both focus shortcuts and bare
  // Escape were separately derived from these same three facts.
  const focusShortcutsActive =
    !appInputDisabled && !slashPaletteOpen && !reverseSearchOpen;
  const escapeInterruptState: EscapeInterruptState = {
    shortcutsActive: focusShortcutsActive,
    canInterruptStream: props.canInterruptStream,
    onInterruptStream: props.onInterruptStream,
  };
  const escapeInterruptStateRef = useRef(escapeInterruptState);
  useLayoutEffect(() => {
    escapeInterruptStateRef.current = escapeInterruptState;
  });
  const inputBarVisible =
    !foregroundOpen && (!childInputHidden || childListFocused);

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
        childRosters,
        parentStream,
        rootStreamId: childListTarget,
        streams,
      }),
    [activeStreamId, childListTarget, childRosters, parentStream, streams],
  );
  // Rows Tab navigates to that are still in flight — the count the status bar
  // advertises next to the Tab binding. `sessionViews` leads with the list
  // root, which is never one of its own children: excluding it by identity
  // (not by "has a parent") keeps a focused workflow stream, itself a child
  // of main, from counting as its own active agent.
  const childRunningCount = sessionViews.filter(
    (view) =>
      view.id !== childListTarget &&
      view.slice !== undefined &&
      isActivePhase(streamPhaseFor(view.id)?.phase),
  ).length;
  const activeSubagentExecutionIds = useMemo(() => {
    const executionIds = new Map<StreamTabId, string>();
    const parentIds = new Set(
      sessionViews
        .map((session) => session.parentId)
        .filter((parentId): parentId is StreamTabId => parentId !== undefined),
    );
    for (const parentId of parentIds) {
      for (const child of activeSubagentsFor(parentId, childRosters)) {
        executionIds.set(child.childStreamId, child.executionId);
      }
    }
    return executionIds;
  }, [childRosters, sessionViews]);
  // The popup's model: derived once here so its rows and the focus targets
  // resolved from them can never disagree. A plan-only phase a finished run
  // never reached is nothing to list; only a known, no-longer-active phase
  // counts as settled (an unknown phase is a stream still being created).
  const workflowPopupStreamId =
    foregroundReader?.kind === 'workflow'
      ? foregroundReader.streamId
      : undefined;
  const workflowPopupRoot =
    workflowPopupStreamId !== undefined
      ? streams.get(workflowPopupStreamId)
      : undefined;
  const workflowRootPhase =
    workflowPopupStreamId === undefined
      ? undefined
      : streamPhaseFor(workflowPopupStreamId)?.phase;
  const workflowPopupRunSettled = workflowRunSettled(workflowRootPhase);
  // Each child's live progress is read once here off the session's own
  // record of that child (status machine, execution state, usage) and joined
  // to its card by the model; the popup paints the join and reads no stream.
  const workflowPopupModel = useMemo(() => {
    if (!workflowPopupRoot || workflowPopupStreamId === undefined) {
      return undefined;
    }
    const childProgress = new Map<StreamTabId, ChildRunProgress>();
    for (const child of visibleSubagentRows(
      workflowPopupStreamId,
      childRosters,
    )) {
      const runStartedAt = streamPhaseFor(child.childStreamId)?.runStartedAt;
      const usage = readStreamArtifacts(child.childStreamId)?.cumulativeUsage;
      childProgress.set(child.childStreamId, {
        runStartedAt,
        toolCallCount:
          streamStateFor(child.childStreamId)?.conversationProgress
            .toolCallCount ?? 0,
        outputTokens: usage?.outputTokens,
        costUsd: usage?.cost,
      });
    }
    return workflowRunModel({
      taskGroups: workflowPopupRoot.taskGroups,
      rows: workflowPopupRoot.entries,
      plan: workflowPopupRoot.workflowPlan,
      runSettled: workflowPopupRunSettled,
      childProgress,
    });
    // The two revisions are the signals that a child's progress or usage
    // moved; they carry no value of their own.
  }, [
    workflowPopupRoot,
    workflowPopupRunSettled,
    workflowPopupStreamId,
    childRosters,
    sessionRevision,
    artifactRevision,
  ]);
  const workflowPopup = useSignal(workflowPopupViewSignal);
  // The popup controls its own grandchildren: their execution ids live on the
  // workflow's roster, not on the parent conversation's.
  const workflowPopupExecutionIds = useMemo(
    () =>
      new Map(
        workflowPopupStreamId === undefined
          ? []
          : activeSubagentsFor(workflowPopupStreamId, childRosters).map(
              (child) => [child.childStreamId, child.executionId] as const,
            ),
      ),
    [childRosters, workflowPopupStreamId],
  );
  // Stream-less approvals fold onto the root of the visible surface: the
  // scoped child-list root while one replaces the session list, else the
  // session root.
  const pendingApprovalsForRows = useMemo(
    () =>
      groupPendingApprovalsByRow(
        pendingSummaries,
        childListTarget ?? rootStreamId,
      ),
    [childListTarget, pendingSummaries, rootStreamId],
  );
  const childListValues = useMemo<readonly ChildListValue[]>(
    () => sessionViews.map((session) => session.id),
    [sessionViews],
  );
  const childListAvailable = childListValues.length > 0;
  const selectedChildStreamId = selectedChildValue;
  const selectedChildKillable =
    selectedChildStreamId !== undefined &&
    activeSubagentExecutionIds.has(selectedChildStreamId);
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
    if (!activeStreamId) return;
    dispatchChildListSelection({
      kind: 'syncActiveStream',
      streamId: activeStreamId,
      values: childListValues,
    });
  }, [activeStreamId, childListValues]);
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
  const focusSession = useCallback((streamId: StreamTabId) => {
    dispatchChildListSelection({ kind: 'focusStream', streamId });
    focusStreamAndPromoteApprovals(streamId);
  }, []);
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    formBusy,
    infoPaneOpen: infoPane !== undefined,
    pendingApproval: activeApprovalVisible,
    readerKind: foregroundReader?.kind,
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
          <ApprovalModal
            availableRows={availableRows}
            goalAutoApproveAll={goalAutoApproveAll}
            pending={pending}
          />
        ) : null;
      case 'transcriptReader': {
        if (foregroundReader?.kind !== 'transcript') return null;
        const title = transcriptReaderTitle(
          streamLabelForId({
            childRosters,
            parentStream,
            streamId: foregroundReader.streamId,
          }),
        );
        return (
          <TranscriptReader
            availableRows={availableRows}
            executionLabels={subagentExecutionLabels}
            onClose={() => {
              // A workflow's log is only ever opened from its popup (a
              // workflow is never a viewport), so closing it goes back there.
              if (isWorkflowScriptStream(foregroundReader.streamId)) {
                openWorkflowPopup(foregroundReader.streamId);
              } else {
                closeForegroundReader();
              }
            }}
            streamId={foregroundReader.streamId}
            title={title}
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
            activeSubagentExecutionIds={workflowPopupExecutionIds}
            availableRows={availableRows}
            model={workflowPopupModel}
            onClose={closeForegroundReader}
            onFocusStream={(streamId) => {
              closeForegroundReader();
              focusStreamAndPromoteApprovals(streamId);
            }}
            onKillExecution={props.onKillExecution}
            onOpenTranscript={openTranscriptReader}
            onViewChange={updateWorkflowPopupView}
            onWorkflowControl={props.onWorkflowControl}
            pendingApprovals={pendingApprovalsForRows}
            streamId={foregroundReader.streamId}
            streams={streams}
            view={workflowPopup}
          />
        );
      }
      case 'workPlanReader': {
        if (foregroundReader?.kind !== 'workPlan') return null;
        const title = workPlanReaderTitle(
          streamLabelForId({
            childRosters,
            parentStream,
            streamId: foregroundReader.streamId,
          }),
        );
        return (
          <WorkPlanReader
            availableRows={availableRows}
            authority={
              foregroundReader.loading === true
                ? undefined
                : foregroundReader.authority
            }
            loading={foregroundReader.loading === true}
            onClose={closeForegroundReader}
            streamId={foregroundReader.streamId}
            title={title}
          />
        );
      }
      case undefined:
        return null;
    }
  }

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
        childRosters,
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

  const appOwnsEscape = (): boolean =>
    escapeInterruptStateRef.current.shortcutsActive;

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
      return true;
    }
    // `bareEscapeActive` already proved `canInterruptStream(streamId)` for a
    // parentless stream: `parentStream` never stores an undefined value, so
    // once `.get()` returned undefined the `has` disjunct is false too.
    escapeInterruptStateRef.current.onInterruptStream(streamId);
    return true;
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

  // Shared tail of both bare-Escape trigger sites below: defer through the
  // meta-chord disambiguation window when one may be in flight, otherwise
  // handle the escape immediately.
  const deferOrHandleBareEscape = (streamId: StreamTabId): void => {
    if (
      shouldDeferEscapeInterruptForMetaChord({
        shortcutModifierLabel: defaultShortcutModifierLabel(),
        streamFocusAvailable: sessionViews.length > 0,
      })
    ) {
      scheduleBareEscape(streamId);
    } else {
      handleBareEscape(streamId);
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
        deferOrHandleBareEscape(currentStreamId);
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
      deferOrHandleBareEscape(activeStreamId);
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
              chatInputAvailable={!childInputHidden}
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
              childNavigationAvailable={childListAvailable}
              runningSessions={childRunningCount}
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
          selectedChildStreamId,
          streams,
          subagentExecutionLabels,
          activeSubagentExecutionIds,
          listRootStreamId: childListTarget,
          pendingApprovals: pendingApprovalsForRows,
        }}
        onCancelChildList={cancelChildList}
        onFocusSession={focusSession}
        onKillExecution={props.onKillExecution}
        onChildSelectionChange={(value) =>
          dispatchChildListSelection({ kind: 'highlight', value })
        }
      />
    </ActiveDraftScope>
  );
}
