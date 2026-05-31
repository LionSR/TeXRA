import { render, Box, Text, useApp, useInput, useWindowSize } from 'ink';

import { Select } from '../chat/tui/ui/Select';
import { KeyHints, type KeyHint } from '../chat/tui/ui/KeyHints';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import type {
  CliOrchestrationAction,
  CliOrchestrationItem,
} from '../runtime/orchestration';

export interface OrchestrationAppProps {
  readonly items: readonly CliOrchestrationItem[];
  readonly onResolve: (action: CliOrchestrationAction) => void;
}

export function orchestrationKeyHints(): readonly KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: '1-9/a-z/Enter', action: 'open' },
    { key: 'Esc', action: 'exit' },
  ];
}

export function OrchestrationApp(
  props: OrchestrationAppProps,
): React.JSX.Element {
  const app = useApp();
  const { rows } = useWindowSize();
  const maxVisibleItems = Math.max(4, rows - 8);

  const finish = (action: CliOrchestrationAction): void => {
    props.onResolve(action);
    app.exit();
  };

  useInput((_input, key) => {
    if (key.escape) {
      finish({ kind: 'exit' });
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        TeXRA
      </Text>
      <Text dimColor>Choose how to start this CLI session.</Text>
      <Box marginTop={1}>
        <Select
          items={props.items}
          maxVisibleItems={maxVisibleItems}
          showOverflow={props.items.length > maxVisibleItems}
          onSelect={finish}
          onCancel={() => finish({ kind: 'exit' })}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={orchestrationKeyHints()} confirmCancel={false} />
      </Box>
    </Box>
  );
}

export async function runOrchestrationTui(
  items: readonly CliOrchestrationItem[],
): Promise<CliOrchestrationAction> {
  return new Promise((resolve) => {
    let chosen: CliOrchestrationAction | undefined;
    const record = (action: CliOrchestrationAction): void => {
      if (chosen) return;
      chosen = action;
    };

    const instance = render(
      <OrchestrationApp items={items} onResolve={record} />,
      {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
      },
    );

    // Wipe the picker out of the visible screen once Ink has finished
    // unmounting without erasing the user's primary-buffer scrollback.
    void instance.waitUntilExit().then(() => {
      clearTerminalVisibleScreen();
      resolve(chosen ?? { kind: 'exit' });
    });
  });
}
