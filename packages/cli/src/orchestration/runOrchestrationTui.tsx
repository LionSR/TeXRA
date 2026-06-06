import { render, Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import { Select } from '../chat/tui/ui/Select';
import { KeyHints, type KeyHint } from '../chat/tui/ui/KeyHints';
import { tuiOutputStreamForColor } from '../chat/tui/render/noColorOutput';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import {
  modelAccessLaunchBlockDescriptionForCliMode,
  modelSelectItemsForCliMode,
} from '../chat/tui/modelAccessDisplay';
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

export function orchestrationModelAccessView(
  items: readonly CliOrchestrationItem[],
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
  options: {
    readonly allowDefaultModelLaunch?: boolean;
  } = {},
): {
  readonly items: readonly CliOrchestrationItem[];
  readonly modelItems: ReturnType<typeof modelSelectItemsForCliMode>;
} {
  const modelItems = modelSelectItemsForCliMode(models, apiMode);
  if (
    models.length === 0 ||
    modelItems.length > 0 ||
    options.allowDefaultModelLaunch === true
  ) {
    return { items, modelItems };
  }

  const description = modelAccessLaunchBlockDescriptionForCliMode(
    models,
    apiMode,
  );
  return {
    modelItems,
    items: items.map((item) =>
      isModelPickAction(item.value)
        ? item.disabled
          ? item
          : { ...item, description, disabled: true }
        : item,
    ),
  };
}

export interface OrchestrationAppProps {
  readonly items: readonly CliOrchestrationItem[];
  /** Model access list for the second step. An empty list means unknown
   *  registry state, so the launcher still starts chats with runtime defaults;
   *  a known list with no runnable model disables chat/team starts. */
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
  readonly statusLines?: readonly string[];
  readonly allowDefaultModelLaunch?: boolean;
  readonly onResolve: (action: CliOrchestrationAction) => void;
}

export function orchestrationKeyHints(): readonly KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: '1-9/a-z/Enter', action: 'open' },
    { key: 'Esc', action: 'exit' },
  ];
}

export function orchestrationFooterHints(
  items: readonly CliOrchestrationItem[],
): readonly string[] {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const item of items) {
    for (const hint of item.footerHints ?? []) {
      if (seen.has(hint)) continue;
      seen.add(hint);
      hints.push(hint);
    }
  }
  return hints;
}

function orchestrationFooterRowCost(footerHints: readonly string[]): number {
  return footerHints.length === 0 ? 0 : footerHints.length + 1;
}

function orchestrationStatusRowCost(statusLines: readonly string[]): number {
  return statusLines.length === 0 ? 0 : statusLines.length + 1;
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
  const { items, modelItems } = orchestrationModelAccessView(
    props.items,
    props.models,
    props.apiMode,
    { allowDefaultModelLaunch: props.allowDefaultModelLaunch },
  );
  const listFooterHints = orchestrationFooterHints(items);
  const statusLines = props.statusLines ?? [];
  // When set, the launcher is on its second step: choosing the model for this
  // chat/team. Esc returns to the item list rather than exiting.
  const [pending, setPending] = useState<ModelPickAction | undefined>(
    undefined,
  );
  const footerHints = pending ? [] : listFooterHints;
  const maxVisibleItems = Math.max(
    4,
    rows -
      8 -
      orchestrationStatusRowCost(pending ? [] : statusLines) -
      orchestrationFooterRowCost(footerHints),
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
      {statusLines.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {statusLines.map((line, index) => (
            <Text key={`${index}:${line}`} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Select
          items={items}
          maxVisibleItems={maxVisibleItems}
          showOverflow={items.length > maxVisibleItems}
          onSelect={onItemSelect}
          onCancel={() => finish({ kind: 'exit' })}
        />
      </Box>
      {footerHints.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {footerHints.map((hint) => (
            <Text key={hint} dimColor wrap="truncate-end">
              {hint}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints hints={orchestrationKeyHints()} confirmCancel={false} />
      </Box>
    </Box>
  );
}

export interface RunOrchestrationTuiOptions {
  /** Available models for the second step; an empty list means registry
   *  unavailable/unknown, while a non-empty all-unavailable list disables
   *  model-dependent launch rows unless runtime defaults can still resolve a
   *  hidden configured model. */
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
  readonly statusLines?: readonly string[];
  readonly allowDefaultModelLaunch?: boolean;
  readonly colorEnabled?: boolean;
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
        statusLines={options.statusLines}
        allowDefaultModelLaunch={options.allowDefaultModelLaunch}
        onResolve={record}
      />,
      {
        stdout: tuiOutputStreamForColor(
          process.stdout,
          options.colorEnabled ?? true,
        ),
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
