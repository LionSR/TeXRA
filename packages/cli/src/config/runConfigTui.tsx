import { Effect } from 'effect';
import { useApp, useWindowSize } from 'ink';

import type { ProcessRuntime } from '@texra-ai/worldline/host';
import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import { scopeRunner } from '../chat/scopeRunner';
import { ChatProcessProvider, type ChatProcess } from '../chat/tui/chatProcess';
import {
  CliConfigForm,
  type CliConfigFormProps,
} from '../chat/tui/forms/CliConfigForm';

type ConfigAppProps = Omit<CliConfigFormProps, 'availableRows' | 'onClose'>;

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
  Pick<ChatProcess, 'roots'> & {
    /** The process runtime the editor's reads and writes run over. */
    readonly runtime: ProcessRuntime;
    readonly colorEnabled?: boolean;
  }): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      // The editor's own scope: leaving it ends a read or write still in
      // flight.
      const chat = scopeRunner(runtime, yield* Effect.scope);
      yield* renderCliPrompt(
        () => (
          <ChatProcessProvider value={{ chat, roots }}>
            <ConfigApp {...props} />
          </ChatProcessProvider>
        ),
        {
          stdout: process.stdout,
          stderr: process.stderr,
          colorEnabled,
        },
      );
    }),
  );
}
