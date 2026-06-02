import { render, Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import { Select } from '../chat/tui/ui/Select';
import { KeyHints, type KeyHint } from '../chat/tui/ui/KeyHints';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import { modelSelectItemsForCliMode } from '../chat/tui/forms/ModelListForm';
import { formatCliApiMode, type CliApiMode } from '../runtime/apiAccessMode';
import type { CliModelAccess } from '../runtime/modelAccess';
import type {
  CliOrchestrationAction,
  CliOrchestrationItem,
} from '../runtime/orchestration';

/** Launcher items that chain into a model pick before launching the chat. */
type ModelPickAction = Extract<
  CliOrchestrationAction,
  { kind: 'chat' | 'preset' }
>;

function isModelPickAction(
  action: CliOrchestrationAction,
): action is ModelPickAction {
  return action.kind === 'chat' || action.kind === 'preset';
}

export interface OrchestrationAppProps {
  readonly items: readonly CliOrchestrationItem[];
  /** Model access list for the second step; if no entries are runnable in the
   *  active API mode, the launcher skips the model pick. */
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
  readonly onResolve: (action: CliOrchestrationAction) => void;
}

export function orchestrationKeyHints(): readonly KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: '1-9/a-z/Enter', action: 'open' },
    { key: 'Esc', action: 'exit' },
  ];
}

function modelPickKeyHints(): readonly KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: '1-9/a-z/Enter', action: 'select' },
    { key: 'Esc', action: 'back' },
  ];
}

export function OrchestrationApp(
  props: OrchestrationAppProps,
): React.JSX.Element {
  const app = useApp();
  const { rows } = useWindowSize();
  const maxVisibleItems = Math.max(4, rows - 8);
  const modelItems = modelSelectItemsForCliMode(props.models, props.apiMode);
  // When set, the launcher is on its second step: choosing the model for this
  // chat/team. Esc returns to the item list rather than exiting.
  const [pending, setPending] = useState<ModelPickAction | undefined>(
    undefined,
  );

  const finish = (action: CliOrchestrationAction): void => {
    props.onResolve(action);
    app.exit();
  };

  const onItemSelect = (action: CliOrchestrationAction): void => {
    if (isModelPickAction(action) && modelItems.length > 0) {
      setPending(action);
    } else {
      finish(action);
    }
  };

  useInput((_input, key) => {
    if (!key.escape) return;
    if (pending) {
      setPending(undefined);
    } else {
      finish({ kind: 'exit' });
    }
  });

  if (pending) {
    const isTeam = pending.kind === 'preset';
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {isTeam ? 'Lead model' : 'Model'}
          {' · '}
          <Text dimColor>{formatCliApiMode(props.apiMode)}</Text>
        </Text>
        <Text dimColor>
          {isTeam
            ? 'Runs the orchestrator agent and is the model it can choose for delegation.'
            : 'Model for the first message.'}
        </Text>
        <Box marginTop={1}>
          <Select
            items={modelItems}
            maxVisibleItems={maxVisibleItems}
            showOverflow={modelItems.length > maxVisibleItems}
            onSelect={(model) => finish({ ...pending, model })}
            onCancel={() => setPending(undefined)}
          />
        </Box>
        <Box marginTop={1}>
          <KeyHints hints={modelPickKeyHints()} confirmCancel={false} />
        </Box>
      </Box>
    );
  }

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
          onSelect={onItemSelect}
          onCancel={() => finish({ kind: 'exit' })}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={orchestrationKeyHints()} confirmCancel={false} />
      </Box>
    </Box>
  );
}

export interface RunOrchestrationTuiOptions {
  /** Available models for the second step; the launcher filters to runnable
   *  ones. Empty or all-unavailable skips the model pick. */
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
}

export async function runOrchestrationTui(
  items: readonly CliOrchestrationItem[],
  options: RunOrchestrationTuiOptions,
): Promise<CliOrchestrationAction> {
  return new Promise((resolve) => {
    let chosen: CliOrchestrationAction | undefined;
    const record = (action: CliOrchestrationAction): void => {
      if (chosen) return;
      chosen = action;
    };

    const instance = render(
      <OrchestrationApp
        items={items}
        models={options.models}
        apiMode={options.apiMode}
        onResolve={record}
      />,
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
