// Phase 1 Ink skeleton — Header + ConversationPane + StatusBar + InputBar
// over the cliState signals. Approvals + tool cards + subagents + markdown
// + slash forms land in Phases 2–5.

import { useEffect } from 'react';
import { Box, useApp } from 'ink';

import { ConversationPane } from './panes/ConversationPane';
import { Header } from './panes/Header';
import { InputBar } from './panes/InputBar';
import { StatusBar } from './panes/StatusBar';
import { makeFrameLogger } from './render/frameTelemetry';

export interface AppProps {
  readonly onSubmit: (line: string) => void;
  readonly inputDisabled?: boolean;
}

export function App(props: AppProps): React.JSX.Element {
  const { exit } = useApp();
  useEffect(() => {
    const onFrame = makeFrameLogger();
    const tick = (): void => onFrame(Date.now());
    const interval = setInterval(tick, 16);
    return () => clearInterval(interval);
  }, []);

  // Surface Ctrl-D as exit when input is empty — handled higher up in
  // runChat (via `requestChatExit`); we keep `exit` reachable for that path.
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
