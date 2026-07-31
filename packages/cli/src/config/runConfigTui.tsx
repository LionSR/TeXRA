import { useApp, useWindowSize } from 'ink';

import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import { CliConfigForm } from '../chat/tui/forms/CliConfigForm';

export function ConfigApp(props: {
  readonly onError?: (error: unknown) => void;
}) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  return (
    <CliConfigForm
      availableRows={rows}
      onClose={exit}
      onError={props.onError}
    />
  );
}

export async function runConfigTui(options: {
  readonly colorEnabled?: boolean;
  readonly onError?: (error: unknown) => void;
}): Promise<void> {
  await renderCliPrompt(() => <ConfigApp onError={options.onError} />, {
    stdout: process.stdout,
    stderr: process.stderr,
    colorEnabled: options.colorEnabled,
  });
}
