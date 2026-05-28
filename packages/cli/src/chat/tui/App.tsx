// Ink TUI root: a single vertical column — conversation, optional subagent /
// todos panels at the bottom, then status, approval modal, and input bar.
// Tab / Shift-Tab cycles focus across subagent streams.

import { Box, useApp, useInput, useStdin, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';

import { SLASH_PALETTE_ROWS } from './commands/SlashPalette';
import { REVERSE_SEARCH_ROWS } from './input/ReverseSearch';
import { ApprovalModal } from './modals/ApprovalModal';
import { ChildControlPicker } from './modals/ChildControlPicker';
import { TranscriptViewer } from './modals/TranscriptViewer';
import { ConversationPane } from './panes/ConversationPane';
import { StaticConversationTranscript } from './panes/StaticConversationTranscript';
import { InputBar } from './panes/InputBar';
import { StatusBar } from './panes/StatusBar';
import { StreamTabsStrip } from './panes/StreamTabsStrip';
import { SubagentList } from './panes/SubagentList';
import { TipRow } from './panes/TipRow';
import { TodosPlanPanel } from './panes/TodosPlanPanel';
import { currentApproval } from './state/approvalQueue';
import {
  isKittyKeypadEnter,
  metaChordDigit,
  metaChordInput,
} from './input/inputKeys';
import {
  hasChildExecutionRows,
  numericFocusTarget,
  type ChildControlMode,
} from './state/childControls';
import { canShowSubagentControls, cliState } from './state/cliState';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
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
// Cap the bottom subagent/todos panels so they never crowd out the
// conversation or push the input bar off-screen.
const BOTTOM_PANEL_MAX_ROWS = 10;

const PINNED_CHROME_ROWS = {
  tip: 1,
  input: 3,
  streamTabsWorstCase: 1,
  status: 2,
} as const;

function pinnedChromeRows({
  reverseSearchOpen,
  slashPaletteOpen,
}: {
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
}): number {
  const baseRows = Object.values(PINNED_CHROME_ROWS).reduce(
    (sum, rows) => sum + rows,
    0,
  );
  return (
    baseRows +
    (slashPaletteOpen ? SLASH_PALETTE_ROWS : 0) +
    (reverseSearchOpen ? REVERSE_SEARCH_ROWS : 0)
  );
}

export function allocateMiddleRows({
  foregroundOpen,
  reverseSearchOpen,
  rows,
  slashPaletteOpen,
}: {
  readonly foregroundOpen: boolean;
  readonly reverseSearchOpen: boolean;
  readonly rows: number;
  readonly slashPaletteOpen: boolean;
}): {
  readonly foregroundRows: number;
  readonly transcriptRows: number;
} {
  const availableRows = Math.max(
    0,
    rows - pinnedChromeRows({ reverseSearchOpen, slashPaletteOpen }),
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

  const transcriptRows = Math.min(
    FOREGROUND_TRANSCRIPT_ROWS,
    availableRows - 1,
  );
  return {
    foregroundRows: availableRows - transcriptRows,
    transcriptRows,
  };
}

export function allocateSidePanelRows({
  hasSubagentPanel,
  hasTodosPlanPanel,
  rows,
}: {
  readonly hasSubagentPanel: boolean;
  readonly hasTodosPlanPanel: boolean;
  readonly rows: number;
}): {
  readonly subagentRows: number;
  readonly todosPlanRows: number;
} {
  const availableRows = Math.max(0, rows);
  if (!hasSubagentPanel && !hasTodosPlanPanel) {
    return { subagentRows: 0, todosPlanRows: 0 };
  }
  if (!hasTodosPlanPanel) {
    return { subagentRows: availableRows, todosPlanRows: 0 };
  }
  if (!hasSubagentPanel) {
    return { subagentRows: 0, todosPlanRows: availableRows };
  }
  if (availableRows === 0) {
    return { subagentRows: 0, todosPlanRows: 0 };
  }

  const subagentRows = Math.max(1, Math.floor(availableRows / 2));
  return {
    subagentRows,
    todosPlanRows: availableRows - subagentRows,
  };
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

export interface AppProps {
  readonly onSubmit: (line: string) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly canInterruptActiveRun: () => boolean;
  readonly onInterruptActive: () => void;
  readonly inputDisabled?: boolean;
  readonly history?: InputHistory;
}

export function App(props: AppProps): React.JSX.Element {
  // Single subscription site; pass the value down so ApprovalModal renders
  // off the same read and InputBar can stay mounted but disabled.
  const pending = useSignal(currentApproval);
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const sessionMeta = useSignal(cliState.sessionMeta);
  const activeForm = useSignal(cliState.activeForm);
  const slashPaletteOpen = useSignal(cliState.slashPaletteOpen);
  const reverseSearchOpen = useSignal(cliState.reverseSearchOpen);
  const transcriptViewerOpen = useSignal(cliState.transcriptViewerOpen);
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const [childControlMode, setChildControlMode] = useState<
    ChildControlMode | undefined
  >(undefined);

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

  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const subagentControlsAvailable = canShowSubagentControls(
    sessionMeta,
    activeSlice,
  );
  const hasSubagentPanel =
    !foregroundOpen && hasChildExecutionRows(activeSlice);
  const hasTodosPlanPanel =
    !foregroundOpen &&
    activeSlice !== undefined &&
    (activeSlice.todos.length > 0 || activeSlice.plan !== null);
  const transcriptWidth = Math.max(MIN_TRANSCRIPT_WIDTH, columns);
  const { foregroundRows, transcriptRows } = allocateMiddleRows({
    foregroundOpen,
    reverseSearchOpen,
    rows,
    slashPaletteOpen,
  });
  // The subagent/todos panels live at the bottom of the same vertical
  // column. Carve a bounded slice off the transcript area so the
  // conversation keeps most of the height and the input stays pinned.
  const bottomPanelBudget =
    hasSubagentPanel || hasTodosPlanPanel
      ? Math.min(BOTTOM_PANEL_MAX_ROWS, Math.floor(transcriptRows / 2))
      : 0;
  const conversationRows = transcriptRows - bottomPanelBudget;
  const { subagentRows, todosPlanRows } = allocateSidePanelRows({
    hasSubagentPanel,
    hasTodosPlanPanel,
    rows: bottomPanelBudget,
  });
  function renderForegroundSurface(): React.ReactNode {
    if (pending) {
      return <ApprovalModal pending={pending} availableRows={foregroundRows} />;
    }
    if (transcriptViewerOpen) {
      return (
        <TranscriptViewer
          availableRows={foregroundRows}
          onClose={() => cliState.transcriptViewerOpen.set(false)}
          slice={activeSlice}
          width={transcriptWidth}
        />
      );
    }
    if (childControlMode) {
      return (
        <ChildControlPicker
          activeStreamId={activeStreamId}
          availableRows={foregroundRows}
          mode={childControlMode}
          onClose={() => setChildControlMode(undefined)}
          onFocusStream={(streamId) => cliState.activeStreamId.set(streamId)}
          onKillExecution={props.onKillExecution}
          slice={activeSlice}
          streams={streams}
        />
      );
    }
    if (activeForm) {
      return activeForm.render(
        () => cliState.activeForm.set(undefined),
        foregroundRows,
      );
    }
    return null;
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
    // Ctrl+C exits, even over a foreground surface. We render with
    // exitOnCtrlC: false (see runChatTui), so Ink neither auto-exits nor filters
    // Ctrl+C out of useInput — this handler is the single exit path. Ink decodes
    // both the raw \x03 and the Kitty CSI-u form (ESC[99;5u, emitted under the
    // disambiguate flag) to a ctrl+c key, so this one branch covers every
    // terminal; exit() is Ink's app-level shutdown (≡ useApp().exit).
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Everything below stands down while a modal/form/input overlay owns the
    // keyboard.
    if (!focusShortcutsActive) return;

    if (key.ctrl && input.toLowerCase() === 't') {
      if (activeSlice) cliState.transcriptViewerOpen.set(true);
      return;
    }

    // Tab / Shift-Tab cycles stream focus.
    if (key.tab) {
      const next = key.shift ? nextFocusBack() : nextFocusForward();
      if (next) cliState.activeStreamId.set(next);
      return;
    }

    // Option/Alt chords: s → subagent controls, p → tasks, 1-9 → focus stream.
    const metaInput = metaChordInput(input, key);
    if (metaInput) {
      const lower = metaInput.toLowerCase();
      if (lower === 's') {
        if (subagentControlsAvailable) setChildControlMode('subagents');
        return;
      }
      if (lower === 'p') {
        setChildControlMode('tasks');
        return;
      }
      const digit = metaChordDigit(input, key);
      if (digit !== undefined) {
        const target = numericFocusTarget(activeSlice, digit - 1);
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
      <StaticConversationTranscript width={transcriptWidth} />
      <Box flexDirection="column">
        <Box flexDirection="column" overflowY="hidden">
          {conversationRows > 0 ? (
            <ConversationPane
              width={transcriptWidth}
              maxRows={conversationRows}
            />
          ) : null}
          {foregroundSurface ? (
            <Box
              height={foregroundRows}
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
        <TipRow />
        <InputBar
          onSubmit={props.onSubmit}
          disabled={inputDisabled}
          history={props.history}
        />
        <StreamTabsStrip width={columns} />
        <StatusBar />
      </Box>
    </>
  );
}
