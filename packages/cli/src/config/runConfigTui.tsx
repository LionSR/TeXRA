import { useApp, useWindowSize } from 'ink';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { CliConfigForm } from '../chat/tui/forms/CliConfigForm';

export function ConfigApp(props: {
  /** The settings slots this view reads and writes, from the command's roots. */
  readonly stores: SettingsStores;
  /**
   * The secret store the API-key rows read and write, threaded from the
   * command that opened this view; Ink components run no Effect.
   */
  readonly secrets: PlatformSecrets;
  /** The process runtime the tools row runs on, from the same command. */
  readonly runtime: ProcessRuntime;
  readonly onError?: (error: unknown) => void;
}) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  return (
    <CliConfigForm
      stores={props.stores}
      availableRows={rows}
      secrets={props.secrets}
      runtime={props.runtime}
      onClose={exit}
      onError={props.onError}
    />
  );
}

export async function runConfigTui(options: {
  readonly stores: SettingsStores;
  readonly secrets: PlatformSecrets;
  readonly runtime: ProcessRuntime;
  readonly colorEnabled?: boolean;
  readonly onError?: (error: unknown) => void;
}): Promise<void> {
  await renderCliPrompt(
    () => (
      <ConfigApp
        stores={options.stores}
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
