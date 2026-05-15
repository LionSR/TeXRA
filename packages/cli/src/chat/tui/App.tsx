// Ink TUI root. Phase 1 skeleton + Phase 2 approval-modal overlay.

import { Box, useApp } from 'ink';

import { ApprovalModal } from './modals/ApprovalModal';
import { ConversationPane } from './panes/ConversationPane';
import { Header } from './panes/Header';
import { InputBar } from './panes/InputBar';
import { StatusBar } from './panes/StatusBar';
import { currentApproval } from './state/approvalQueue';
import { useSignal } from './state/useSignal';

export interface AppProps {
  readonly onSubmit: (line: string) => void;
  readonly inputDisabled?: boolean;
}

export function App(props: AppProps): React.JSX.Element {
  const { exit } = useApp();
  void exit;
  // Read the signal once and pass-as-prop. `<InputBar>` stays mounted (so
  // its draft `useState` survives the modal) — `disabled` suspends key
  // handling while the modal owns the screen. `<ApprovalModal>` returns
  // null when no approval is pending, so it can render unconditionally.
  const pending = useSignal(currentApproval);

  return (
    <Box flexDirection="column">
      <Header />
      <ConversationPane />
      <StatusBar />
      <ApprovalModal />
      <InputBar
        onSubmit={props.onSubmit}
        disabled={props.inputDisabled || pending !== undefined}
      />
    </Box>
  );
}
