import { render, Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import { Select } from '../chat/tui/ui/Select';
import { KeyHints, type KeyHint } from '../chat/tui/ui/KeyHints';
import { tuiOutputStreamForColor } from '../chat/tui/render/noColorOutput';
import { wrapAnsiToWidth } from '../chat/tui/render/ansiWrap';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import { formatCliApiMode, type CliApiMode } from '../runtime/apiAccessMode';
import {
  isCliOrchestrationModelPickAction,
  orchestrationModelAccessView,
  type CliOrchestrationAction,
  type CliOrchestrationItem,
  type CliOrchestrationModelPickAction,
} from '../runtime/orchestration';
import type { CliModelAccess } from '../runtime/modelAccess';

export interface OrchestrationAppProps {
  readonly items: readonly CliOrchestrationItem[];
  /** Model access list for the second step. An empty list means unknown
   *  registry state, so the launcher still starts chats with runtime defaults;
   *  a known list with no runnable model disables chat/team starts. */
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
  /** CLI version, shown in the launcher header (matches the chat session
   *  header) so a directly-launched `texra` reports which build is running. */
  readonly version: string;
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

export function orchestrationWrappedLineRows(
  line: string,
  columns: number,
): number {
  return Math.max(
    1,
    wrapAnsiToWidth(line, Math.max(1, columns)).split('\n').length,
  );
}

/** Rows a marginTop=1 block of lines occupies (wrapped lines plus the margin). */
export function orchestrationBlockRowCost(
  lines: readonly string[],
  columns: number,
): number {
  if (lines.length === 0) return 0;
  return (
    1 +
    lines.reduce(
      (rows, line) => rows + orchestrationWrappedLineRows(line, columns),
      0,
    )
  );
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
  const { columns, rows } = useWindowSize();
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
  const [pending, setPending] = useState<
    CliOrchestrationModelPickAction | undefined
  >(undefined);
  const footerHints = pending ? [] : listFooterHints;
  const textColumns = Math.max(1, columns - 2);
  const maxVisibleItems = Math.max(
    4,
    rows -
      8 -
      orchestrationBlockRowCost(pending ? [] : statusLines, textColumns) -
      orchestrationBlockRowCost(footerHints, textColumns),
  );

  const finish = (action: CliOrchestrationAction): void => {
    props.onResolve(action);
    app.exit();
  };

  const onItemSelect = (action: CliOrchestrationAction): void => {
    if (isCliOrchestrationModelPickAction(action) && modelItems.length > 0) {
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
            key="orchestration-model-picker"
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
      <Box gap={1}>
        <Text bold color="cyan">
          TeXRA
        </Text>
        <Text dimColor>v{props.version}</Text>
      </Box>
      <Text dimColor>Choose how to start this CLI session.</Text>
      {statusLines.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {statusLines.map((line, index) => (
            <Text key={`${index}:${line}`} dimColor wrap="wrap">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Select
          key="orchestration-launcher"
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
            <Text key={hint} dimColor wrap="wrap">
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
  readonly version: string;
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
        version={options.version}
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
