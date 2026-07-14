import { render, useApp } from 'ink';

import { CliConfigForm } from '../chat/tui/forms/CliConfigForm';
import { tuiOutputStreamForColor } from '../chat/tui/render/noColorOutput';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';

function ConfigApp(props: { readonly onError?: (error: unknown) => void }) {
  const { exit } = useApp();
  return <CliConfigForm onClose={exit} onError={props.onError} />;
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
