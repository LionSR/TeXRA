import { Effect } from 'effect';
import { useApp, useWindowSize } from 'ink';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
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
  ...props
}: ConfigAppProps & { readonly colorEnabled?: boolean }): Effect.Effect<void> {
  return Effect.asVoid(
    renderCliPrompt(() => <ConfigApp {...props} />, {
      stdout: process.stdout,
      stderr: process.stderr,
      colorEnabled,
    }),
  );
}
