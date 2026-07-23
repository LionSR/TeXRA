import { render, useApp, useWindowSize } from 'ink';

import { CliConfigForm } from '../chat/tui/forms/CliConfigForm';
import { tuiOutputStreamForColor } from '../chat/tui/render/noColorOutput';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';

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
  const instance = render(<ConfigApp onError={options.onError} />, {
    stdout: tuiOutputStreamForColor(
      process.stdout,
      options.colorEnabled ?? true,
    ),
    stderr: process.stderr,
    stdin: process.stdin,
  });
  await instance.waitUntilExit();
  clearTerminalVisibleScreen();
}
