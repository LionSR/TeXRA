// Ink TUI root: conversation, optional side column, status, approval modal,
// and input bar. Tab / Shift-Tab cycles focus across subagent streams.

import { Box, Text, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import { ApprovalModal } from './modals/ApprovalModal';
import { ChildControlPicker } from './modals/ChildControlPicker';
import { ConversationPane } from './panes/ConversationPane';
import { HeaderPane } from './panes/HeaderPane';
import { InputBar } from './panes/InputBar';
import { StatusBar } from './panes/StatusBar';
import { StreamTabsStrip } from './panes/StreamTabsStrip';
import { SubagentList } from './panes/SubagentList';
import { TipRow } from './panes/TipRow';
import { TodosPlanPanel } from './panes/TodosPlanPanel';
import { currentApproval } from './state/approvalQueue';
import {
  numericFocusTarget,
  type ChildControlMode,
} from './state/childControls';
import { cliState } from './state/cliState';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
import { useSignal } from './state/useSignal';
import type { InputHistory } from './history/inputHistory';

const SIDE_COLUMN_WIDTH = 28;
const MIN_TRANSCRIPT_WIDTH = 20;

const PINNED_CHROME_ROWS = {
  accent: 1,
  header: 3,
  tip: 1,
  input: 3,
  streamTabsWorstCase: 1,
  status: 2,
} as const;
const SLASH_PALETTE_ROWS = 12;

function pinnedChromeRows(slashPaletteOpen: boolean): number {
  const baseRows = Object.values(PINNED_CHROME_ROWS).reduce(
    (sum, rows) => sum + rows,
    0,
  );
  return baseRows + (slashPaletteOpen ? SLASH_PALETTE_ROWS : 0);
}

export interface AppProps {
  readonly onSubmit: (line: string) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly inputDisabled?: boolean;
  readonly history?: InputHistory;
}

export function App(props: AppProps): React.JSX.Element {
  // Single subscription site; pass the value down so ApprovalModal renders
  // off the same read and InputBar can stay mounted but disabled.
  const pending = useSignal(currentApproval);
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const activeForm = useSignal(cliState.activeForm);
  const slashPaletteOpen = useSignal(cliState.slashPaletteOpen);
  const { columns, rows } = useWindowSize();
  const [childControlMode, setChildControlMode] = useState<
    ChildControlMode | undefined
  >(undefined);
  const inputDisabled =
    props.inputDisabled ||
    pending !== undefined ||
    activeForm !== undefined ||
    childControlMode !== undefined;

  // Hide the side column when both side panes would render empty —
  // otherwise the conversation loses 28 columns of width for nothing.
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const showSideColumn =
    activeSlice !== undefined &&
    (activeSlice.activeSubagents.length > 0 ||
      activeSlice.activeProcesses.length > 0 ||
      activeSlice.todos.length > 0 ||
      activeSlice.plan !== null);
  const transcriptWidth = Math.max(
    MIN_TRANSCRIPT_WIDTH,
    columns - (showSideColumn ? SIDE_COLUMN_WIDTH : 0),
  );
  const transcriptRows = Math.max(1, rows - pinnedChromeRows(slashPaletteOpen));

  // Tab / Shift-Tab cycles stream focus at the App layer. Stand down while a
  // modal/form is up (they own input) or the slash palette is open (Tab there
  // means "accept selection") — Ink broadcasts useInput, so both handlers
  // would otherwise fire on the same chord.
  useInput(
    (_input, key) => {
      if (!key.tab) return;
      const next = key.shift ? nextFocusBack() : nextFocusForward();
      if (next) cliState.activeStreamId.set(next);
    },
    { isActive: !inputDisabled && !slashPaletteOpen },
  );

  useInput(
    (input, key) => {
      if (!key.meta) return;
      const lower = input.toLowerCase();
      if (lower === 's') {
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
    { isActive: !inputDisabled && !slashPaletteOpen },
  );

  return (
    <Box flexDirection="column" height={rows}>
      <Box>
        <Text color="cyan">{'─'.repeat(columns)}</Text>
      </Box>
      <HeaderPane />
      <Box flexDirection="row" flexGrow={1} overflowY="hidden">
        <Box flexDirection="column" flexGrow={1} overflowY="hidden">
          <ConversationPane width={transcriptWidth} maxRows={transcriptRows} />
          <ApprovalModal pending={pending} />
          {childControlMode ? (
            <ChildControlPicker
              activeStreamId={activeStreamId}
              mode={childControlMode}
              onClose={() => setChildControlMode(undefined)}
              onFocusStream={(streamId) =>
                cliState.activeStreamId.set(streamId)
              }
              onKillExecution={props.onKillExecution}
              slice={activeSlice}
              streams={streams}
            />
          ) : null}
          {activeForm
            ? activeForm.render(() => cliState.activeForm.set(undefined))
            : null}
        </Box>
        {showSideColumn ? (
          <Box flexDirection="column" minWidth={SIDE_COLUMN_WIDTH}>
            <SubagentList />
            <TodosPlanPanel />
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
  );
}
