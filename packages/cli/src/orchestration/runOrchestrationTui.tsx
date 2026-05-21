import { render, Box, Text, useApp, useInput, useWindowSize } from 'ink';

import type {
  CliOrchestrationAction,
  CliOrchestrationItem,
} from '../runtime/orchestration';
import { Select } from '../chat/tui/ui/Select';
import { KeyHints } from '../chat/tui/ui/KeyHints';

interface OrchestrationAppProps {
  readonly items: readonly CliOrchestrationItem[];
  readonly onResolve: (action: CliOrchestrationAction) => void;
}

function OrchestrationApp(props: OrchestrationAppProps): React.JSX.Element {
  const app = useApp();
  const { rows } = useWindowSize();
  const maxVisibleItems = Math.max(4, rows - 8);

  const finish = (action: CliOrchestrationAction): void => {
    props.onResolve(action);
    app.exit();
  };

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') {
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
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-9/Enter', action: 'open' },
            { key: 'q/Esc', action: 'exit' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}

export async function runOrchestrationTui(
  items: readonly CliOrchestrationItem[],
): Promise<CliOrchestrationAction> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (action: CliOrchestrationAction): void => {
      if (settled) return;
      settled = true;
      resolve(action);
    };

    const instance = render(
      <OrchestrationApp items={items} onResolve={settle} />,
      {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
      },
    );

    void instance.waitUntilExit().then(() => settle({ kind: 'exit' }));
  });
}
