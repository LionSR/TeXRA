// Phase 1 Ink skeleton — Header + ConversationPane + StatusBar + InputBar
// over the cliState signals. Approvals + tool cards + subagents + markdown
// + slash forms land in Phases 2–5.

import { Box, useApp } from 'ink';

import { ConversationPane } from './panes/ConversationPane';
import { Header } from './panes/Header';
import { InputBar } from './panes/InputBar';
import { StatusBar } from './panes/StatusBar';

export interface AppProps {
  readonly onSubmit: (line: string) => void;
  readonly inputDisabled?: boolean;
}

export function App(props: AppProps): React.JSX.Element {
  const { exit } = useApp();
  // `exit` is reachable for future approval-modal / Ctrl-D handlers that
  // unmount via React; runChatTui currently drives lifecycle externally.
  void exit;

  return (
    <Box flexDirection="column">
      <Header />
      <ConversationPane />
      <StatusBar />
      <InputBar onSubmit={props.onSubmit} disabled={props.inputDisabled} />
    </Box>
  );
}
