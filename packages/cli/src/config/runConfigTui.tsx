import { useApp, useWindowSize } from 'ink';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { CliConfigForm } from '../chat/tui/forms/CliConfigForm';

export function ConfigApp(props: {
  /**
   * The secret store the API-key rows read and write, threaded from the
   * command that opened this view; Ink components run no Effect.
   */
  readonly secrets: PlatformSecrets;
  /** The command's own runtime, for the rows that run a program. */
  readonly runtime: ProcessRuntime;
  readonly onError?: (error: unknown) => void;
}) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  return (
    <CliConfigForm
      availableRows={rows}
      runtime={props.runtime}
      secrets={props.secrets}
      onClose={exit}
      onError={props.onError}
    />
  );
}

export async function runConfigTui(options: {
  readonly secrets: PlatformSecrets;
  readonly runtime: ProcessRuntime;
  readonly colorEnabled?: boolean;
  readonly onError?: (error: unknown) => void;
}): Promise<void> {
  await renderCliPrompt(
    () => (
      <ConfigApp
        secrets={options.secrets}
        runtime={options.runtime}
        onError={options.onError}
      />
    ),
    {
      stdout: process.stdout,
      stderr: process.stderr,
      colorEnabled: options.colorEnabled,
    },
  );
}
