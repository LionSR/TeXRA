// Ink root: conversation and optional panels above stable status, approval, and input chrome.

import { useApp, useInput, useStdin, useWindowSize } from 'ink';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  appEscapeInterruptActive,
  appFocusShortcutsActive,
  approvalVisibleForActiveStream,
  digitFromMetaShortcut,
  ESC_META_CHORD_INTERRUPT_DELAY_MS,
  foregroundEscapeAction,
  foregroundMaxRowsForKind,
  foregroundSurfaceKind,
  shouldDeferEscapeInterruptForMetaChord,
  triggerEscapeInterrupt,
  type EscapeInterruptState,
} from './appInteractionPolicy';
import { ApprovalModal } from './modals/ApprovalModal';
import { ChildControlPicker } from './modals/ChildControlPicker';
import { TranscriptViewer } from './modals/TranscriptViewer';
import { InputBar } from './panes/InputBar';
import { ConversationRegion } from './panes/ConversationRegion';
import { StatusBar } from './panes/StatusBar';
import {
  StreamTabsStrip,
  streamTabsDisplayItems,
} from './panes/StreamTabsStrip';
import { currentApproval } from './state/approvalQueue';
import {
  isEscapeInput,
  metaChordInput,
  rewriteKittyEnterInput,
} from './input/inputKeys';
import {
  numericFocusTargetForActiveStream,
  resolveChildControlDisplayTargets,
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
  streams as streamsSignal,
} from './state/cliState';
import {
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
} from './state/childExecutions';
import { focusedChildInputDisabledMessage } from './state/focusedChildFollowUp';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
import { streamDisplayLabel } from './state/streamViews';
import { useSignal } from './state/useSignal';
import type { TranscriptViewportChange } from './state/transcriptViewportMode';
import type { InputHistory } from './history/inputHistory';

// Narrow subset of Ink's internal stdin emitter used to synthesize Enter.
interface InputEventEmitterLike {
  emit(event: 'input', data: string): void;
  on(event: 'input', listener: (data: string) => void): void;
  off(event: 'input', listener: (data: string) => void): void;
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
  const childStreamEntries = useSignal(childStreamEntriesSignal);
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
    childStreamEntries,
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
  const streamTabItems = streamTabsDisplayItems({
    activeStreamId,
    childStreamEntries,
    parentStream,
    streams,
    width: columns,
  });
  const streamTabsVisible = streamTabItems.length > 0;
  const foregroundKind = foregroundSurfaceKind({
    activeFormOpen: activeForm !== undefined,
    childControlMode,
    pendingApproval: activeApprovalVisible,
    transcriptViewerOpen,
  });
  const approvalKind =
    foregroundKind === 'approval' ? pending?.payload.kind : undefined;
  const childControlTarget =
    childControlMode !== undefined
      ? childControlTargets[childControlMode]
      : undefined;
  useEffect(() => {
    if (childControlMode === undefined) {
      childControlEscapeActionSignal.set('close');
    }
  }, [childControlMode]);
  const foregroundMaxRows = foregroundMaxRowsForKind({
    approvalKind,
    childControlHasItems: childControlTarget?.hasItems ?? false,
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
      case 'childControls': {
        if (!childControlMode) return null;
        const target = childControlTarget;
        if (!target) return null;
        return (
          <ChildControlPicker
            availableColumns={columns}
            streamLabel={target.streamLabel}
            activeStreamId={target.streamId}
            availableRows={availableRows}
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
            childStreamEntries={childStreamEntries}
            slice={target.slice}
            streamScopeDetail={target.streamScopeDetail}
            streams={streams}
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
    <ConversationRegion
      agentSelectionAvailable={agentSelectionAvailable}
      colorEnabled={props.colorEnabled}
      columns={columns}
      onTranscriptViewportChange={props.onTranscriptViewportChange}
      renderFooterChrome={(queuedFollowUpPanelVisible) => (
        <>
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
              approvalKind,
              childControlEscapeAction,
              foregroundKind,
            })}
            queuedFollowUpPreview={!queuedFollowUpPanelVisible}
            shortcutsActive={focusShortcutsActive}
            subagentControlsAvailable={subagentControlsAvailable}
            taskControlsAvailable={taskControlsAvailable}
            transcriptAvailable={(activeSlice?.entries.length ?? 0) > 0}
          />
        </>
      )}
      renderForegroundSurface={renderForegroundSurface}
      rows={rows}
      snapshot={{
        activeStreamId,
        childStreamEntries,
        foregroundMaxRows,
        foregroundKind,
        parentStream,
        reverseSearchOpen,
        rootStreamId,
        slashPaletteOpen,
        streamTabsVisible,
        streams,
        childExecutionPanelTarget: childControlTargets.tasks,
        transcriptViewerStreamId,
      }}
    />
  );
}
