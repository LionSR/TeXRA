// Ink TUI root: conversation, optional side column, status, approval modal,
// and input bar. Tab / Shift-Tab cycles focus across subagent streams.

import { Box, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import { SLASH_PALETTE_ROWS } from './commands/SlashPalette';
import { REVERSE_SEARCH_ROWS } from './input/ReverseSearch';
import { ApprovalModal } from './modals/ApprovalModal';
import { ChildControlPicker } from './modals/ChildControlPicker';
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
  hasChildExecutionRows,
  numericFocusTarget,
  type ChildControlMode,
} from './state/childControls';
import { canShowSubagentControls, cliState } from './state/cliState';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
import { useSignal } from './state/useSignal';
import type { InputHistory } from './history/inputHistory';

const SIDE_COLUMN_WIDTH = 28;
const MIN_TRANSCRIPT_WIDTH = 20;
const FOREGROUND_TRANSCRIPT_ROWS = 1;

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
  const { columns, rows } = useWindowSize();
  const [childControlMode, setChildControlMode] = useState<
    ChildControlMode | undefined
  >(undefined);
  const foregroundOpen =
    pending !== undefined ||
    activeForm !== undefined ||
    childControlMode !== undefined;
  const inputDisabled = props.inputDisabled === true || foregroundOpen;

  // Hide the side column when both side panes would render empty —
  // otherwise the conversation loses 28 columns of width for nothing.
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
  const showSideColumn = hasSubagentPanel || hasTodosPlanPanel;
  const transcriptWidth = Math.max(
    MIN_TRANSCRIPT_WIDTH,
    columns - (showSideColumn ? SIDE_COLUMN_WIDTH : 0),
  );
  const { foregroundRows, transcriptRows } = allocateMiddleRows({
    foregroundOpen,
    reverseSearchOpen,
    rows,
    slashPaletteOpen,
  });
  const { subagentRows, todosPlanRows } = allocateSidePanelRows({
    hasSubagentPanel,
    hasTodosPlanPanel,
    rows: transcriptRows,
  });
  function renderForegroundSurface(): React.ReactNode {
    if (pending) {
      return <ApprovalModal pending={pending} availableRows={foregroundRows} />;
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

  // Tab / Shift-Tab cycles stream focus at the App layer. Stand down while a
  // modal/form/input overlay owns the keyboard. Ink broadcasts useInput, so
  // both handlers would otherwise fire on the same chord.
  useInput(
    (_input, key) => {
      if (!key.tab) return;
      const next = key.shift ? nextFocusBack() : nextFocusForward();
      if (next) cliState.activeStreamId.set(next);
    },
    { isActive: focusShortcutsActive },
  );

  useInput(
    (input, key) => {
      if (!key.meta) return;
      const lower = input.toLowerCase();
      if (lower === 's') {
        if (!subagentControlsAvailable) return;
        setChildControlMode('subagents');
        return;
      }
      if (lower === 'p') {
        setChildControlMode('tasks');
        return;
      }
      const digit = Number(input);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const target = numericFocusTarget(activeSlice, digit - 1);
        if (target) cliState.activeStreamId.set(target);
      }
    },
    { isActive: focusShortcutsActive },
  );

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (
        !appEscapeInterruptActive({
          inputDisabled,
          reverseSearchOpen,
          runPending: props.canInterruptActiveRun(),
          slashPaletteOpen,
        })
      ) {
        return;
      }
      props.onInterruptActive();
    },
    { isActive: focusShortcutsActive },
  );

  return (
    <>
      <StaticConversationTranscript width={transcriptWidth} />
      <Box flexDirection="column">
        <Box flexDirection="row" overflowY="hidden">
          <Box flexDirection="column" overflowY="hidden">
            {transcriptRows > 0 ? (
              <ConversationPane
                width={transcriptWidth}
                maxRows={transcriptRows}
              />
            ) : null}
            {foregroundSurface ? (
              <Box height={foregroundRows} overflowY="hidden">
                {foregroundSurface}
              </Box>
            ) : null}
          </Box>
          {showSideColumn ? (
            <Box
              flexDirection="column"
              minWidth={SIDE_COLUMN_WIDTH}
              height={transcriptRows}
              overflowY="hidden"
            >
              <SubagentList maxRows={subagentRows} />
              <TodosPlanPanel maxRows={todosPlanRows} />
            </Box>
          ) : null}
        </Box>
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
