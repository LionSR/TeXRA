import { Effect } from 'effect';
import { useApp, useWindowSize } from 'ink';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import { ChatProcessProvider, type ChatProcess } from '../chat/tui/chatProcess';
import {
  CliConfigForm,
  type CliConfigFormProps,
} from '../chat/tui/forms/CliConfigForm';

/** `texra config edit` holds no session, so it takes no approval hook. */
type ConfigAppProps = Omit<
  CliConfigFormProps,
  'availableRows' | 'onClose' | 'onApprovalPolicyChanged'
>;

function ConfigApp(props: ConfigAppProps) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  return <CliConfigForm {...props} availableRows={rows} onClose={exit} />;
}

export function runConfigTui({
  colorEnabled,
  runtime,
  roots,
  ...props
}: ConfigAppProps &
  ChatProcess & { readonly colorEnabled?: boolean }): Effect.Effect<void> {
  return Effect.asVoid(
    renderCliPrompt(
      () => (
        <ChatProcessProvider value={{ runtime, roots }}>
          <ConfigApp {...props} />
        </ChatProcessProvider>
      ),
      {
        stdout: process.stdout,
        stderr: process.stderr,
        colorEnabled,
      },
    ),
  );
}
