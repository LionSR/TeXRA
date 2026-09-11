import { useApp, useWindowSize } from 'ink';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import type { PlatformSecrets } from '@platform/secrets';
import { CliConfigForm } from '../chat/tui/forms/CliConfigForm';

export function ConfigApp(props: {
  /**
   * The secret store the API-key rows read and write, threaded from the
   * command that opened this view; Ink components run no Effect.
   */
  readonly secrets: PlatformSecrets;
  readonly onError?: (error: unknown) => void;
}) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  return (
    <CliConfigForm
      availableRows={rows}
      secrets={props.secrets}
      onClose={exit}
      onError={props.onError}
    />
  );
}

export async function runConfigTui(options: {
  readonly secrets: PlatformSecrets;
  readonly colorEnabled?: boolean;
  readonly onError?: (error: unknown) => void;
}): Promise<void> {
  await renderCliPrompt(
    () => <ConfigApp secrets={options.secrets} onError={options.onError} />,
    {
      stdout: process.stdout,
      stderr: process.stderr,
      colorEnabled: options.colorEnabled,
    },
  );
}
