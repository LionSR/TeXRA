// Ink TUI root. Phase 1 skeleton + Phase 2 approval-modal overlay + Phase 4
// SubagentList / TodosPlanPanel side panels and Ctrl-A / Ctrl-B focus cycle.

import { Box, useApp, useInput } from 'ink';

import { ApprovalModal } from './modals/ApprovalModal';
import { ConversationPane } from './panes/ConversationPane';
import { Header } from './panes/Header';
import { InputBar } from './panes/InputBar';
import { StatusBar } from './panes/StatusBar';
import { SubagentList } from './panes/SubagentList';
import { TodosPlanPanel } from './panes/TodosPlanPanel';
import { currentApproval } from './state/approvalQueue';
import { cliState } from './state/cliState';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
import { useSignal } from './state/useSignal';

export interface AppProps {
  readonly onSubmit: (line: string) => void;
  readonly inputDisabled?: boolean;
}

export function App(props: AppProps): React.JSX.Element {
  const { exit } = useApp();
  void exit;
  // Single subscription site; pass the value down so ApprovalModal renders
  // off the same read and InputBar can stay mounted but disabled.
  const pending = useSignal(currentApproval);
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const inputDisabled = props.inputDisabled || pending !== undefined;

  // Hide the side column when both side panes would render empty —
  // otherwise the conversation loses 28 columns of width for nothing.
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const showSideColumn = activeSlice
    ? activeSlice.activeSubagents.length > 0 ||
      activeSlice.activeProcesses.length > 0 ||
      activeSlice.todos.length > 0 ||
      activeSlice.plan !== null
    : false;

  // Ctrl-A / Ctrl-B focus cycle — runs at the App layer so the same chord
  // lands no matter which pane the user just glanced at. The readline-style
  // start-of-line / back-one-char binding of those chords inside the input
  // bar lands in Phase 5 alongside the explicit focus-mode toggle; until
  // then ink-text-input ignores ctrl chords anyway.
  useInput((_input, key) => {
    if (!key.ctrl) return;
    if (_input === 'a') {
      const next = nextFocusForward();
      if (next) cliState.activeStreamId.set(next);
    } else if (_input === 'b') {
      const next = nextFocusBack();
      if (next) cliState.activeStreamId.set(next);
    }
  });

  return (
    <Box flexDirection="column">
      <Header />
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          <ConversationPane />
        </Box>
        {showSideColumn ? (
          <Box flexDirection="column" minWidth={28}>
            <SubagentList />
            <TodosPlanPanel />
          </Box>
        ) : null}
      </Box>
      <StatusBar />
      <ApprovalModal pending={pending} />
      <InputBar onSubmit={props.onSubmit} disabled={inputDisabled} />
    </Box>
  );
}
