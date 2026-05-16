// Ink TUI root: header, conversation, optional side column, status, approval
// modal, and input bar. Tab / Shift-Tab cycles focus across subagent streams.

import { Box, useInput } from 'ink';

import { ApprovalModal } from './modals/ApprovalModal';
import { ConversationPane } from './panes/ConversationPane';
import { InputBar } from './panes/InputBar';
import { StatusBar } from './panes/StatusBar';
import { SubagentList } from './panes/SubagentList';
import { TodosPlanPanel } from './panes/TodosPlanPanel';
import { currentApproval } from './state/approvalQueue';
import { cliState } from './state/cliState';
import { nextFocusBack, nextFocusForward } from './state/focusCycle';
import { useSignal } from './state/useSignal';
import type { InputHistory } from './history/inputHistory';

export interface AppProps {
  readonly onSubmit: (line: string) => void;
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
  const inputDisabled =
    props.inputDisabled || pending !== undefined || activeForm !== undefined;

  // Hide the side column when both side panes would render empty —
  // otherwise the conversation loses 28 columns of width for nothing.
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const showSideColumn =
    activeSlice !== undefined &&
    (activeSlice.activeSubagents.length > 0 ||
      activeSlice.activeProcesses.length > 0 ||
      activeSlice.todos.length > 0 ||
      activeSlice.plan !== null);

  // Tab / Shift-Tab cycles stream focus at the App layer. Chosen over Ctrl-A/B
  // so the text-input chord for "go to line start" (Emacs/readline standard)
  // doesn't collide once cursor-controlled inputs propagate the chord.
  useInput((_input, key) => {
    if (!key.tab) return;
    const next = key.shift ? nextFocusBack() : nextFocusForward();
    if (next) cliState.activeStreamId.set(next);
  });

  return (
    <Box flexDirection="column">
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
      {activeForm
        ? activeForm.render(() => cliState.activeForm.set(undefined))
        : null}
      <InputBar
        onSubmit={props.onSubmit}
        disabled={inputDisabled}
        history={props.history}
      />
    </Box>
  );
}
