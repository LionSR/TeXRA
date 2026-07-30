import { render, Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import { Select } from '@cli/tui/ui/Select';
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { clearTerminalVisibleScreen } from '@cli/tui/terminalCleanup';
import { computeSelectWindowSize } from '@cli/tui/selectWindow';
import {
  isCliOrchestrationModelPickAction,
  orchestrationModelAccessView,
  type CliOrchestrationAction,
  type CliOrchestrationItem,
  type CliOrchestrationModelPickAction,
} from '../runtime/orchestration';
import {
  buildCliModelAccessItems,
  cliApiFallbackSelection,
  CLI_MODEL_ACCESS_DESCRIPTION,
  type CliModelAccessStatus,
} from '../runtime/modelAccessRoute';
import type { CliApiMode } from '../runtime/apiAccessMode';
import type { CliModelAccess } from '../runtime/modelAccess';

export interface OrchestrationAppProps {
  readonly items: readonly CliOrchestrationItem[];
  readonly resumeItems?: readonly CliOrchestrationItem[];
  readonly agentItems?: readonly CliOrchestrationItem[];
  readonly teamItems?: readonly CliOrchestrationItem[];
  readonly accountItems?: readonly CliOrchestrationItem[];
  /** Model access list for the second step. An empty list means unknown
   *  registry state, so the launcher still starts chats with runtime defaults;
   *  a known list with no runnable model disables chat/team starts. */
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
  readonly modelAccess?: CliModelAccessStatus;
  /** CLI version, shown in the launcher header (matches the chat session
   *  header) so a directly-launched `texra` reports which build is running. */
  readonly version: string;
  readonly statusLines?: readonly string[];
  readonly allowDefaultModelLaunch?: boolean;
  readonly onResolve: (action: CliOrchestrationAction) => void;
}

export type OrchestrationLauncherStep =
  | { readonly kind: 'launcher' }
  | {
      readonly kind: 'model';
      readonly action: CliOrchestrationModelPickAction;
      readonly backTo: 'launcher' | 'agent' | 'team';
    }
  | { readonly kind: 'model-access' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'agent' }
  | { readonly kind: 'team' }
  | { readonly kind: 'account' };

/** Return the parent picker for Escape, or null when Escape exits the launcher. */
export function orchestrationPreviousStep(
  step: OrchestrationLauncherStep,
): OrchestrationLauncherStep | null {
  if (step.kind === 'launcher') return null;
  if (step.kind === 'model') return { kind: step.backTo };
  return { kind: 'launcher' };
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
  return 1 + orchestrationLinesRowCost(lines, columns);
}

export interface OrchestrationLauncherLayout {
  readonly statusLines: readonly string[];
  readonly footerHints: readonly string[];
  readonly maxVisibleItems: number | undefined;
  readonly showOverflow: boolean;
}

interface OrchestrationLauncherLayoutCandidate {
  readonly statusLines: readonly string[];
  readonly footerHints: readonly string[];
}

interface OrchestrationLauncherLayoutInput {
  readonly rows: number;
  readonly columns: number;
  readonly itemCount: number;
  readonly headerLines: readonly string[];
  readonly statusLines: readonly string[];
  readonly footerHints: readonly string[];
}

const ORCHESTRATION_SELECT_MARGIN_ROWS = 1;
const ORCHESTRATION_KEY_HINT_ROWS = 2;
const ORCHESTRATION_TARGET_VISIBLE_ITEMS = 4;

function orchestrationLinesRowCost(
  lines: readonly string[],
  columns: number,
): number {
  return lines.reduce(
    (rows, line) => rows + orchestrationWrappedLineRows(line, columns),
    0,
  );
}

function compactOrchestrationStatusLines(
  statusLines: readonly string[],
): readonly string[] {
  return statusLines.map((line) => {
    if (!line.startsWith('auth: signed in')) return line;
    const suffix = line.indexOf(' · ');
    return suffix < 0 ? line : line.slice(0, suffix);
  });
}

function orchestrationLauncherLayoutCandidates(
  statusLines: readonly string[],
  footerHints: readonly string[],
): OrchestrationLauncherLayoutCandidate[] {
  const compactStatusLines = compactOrchestrationStatusLines(statusLines);
  const hasCompactFallback = compactStatusLines.some(
    (line, index) => line !== statusLines[index],
  );
  const candidates: OrchestrationLauncherLayoutCandidate[] = [
    { statusLines, footerHints },
  ];
  if (hasCompactFallback) {
    candidates.push({ statusLines: compactStatusLines, footerHints });
  }
  if (footerHints.length > 0) {
    candidates.push({ statusLines, footerHints: [] });
    if (hasCompactFallback) {
      candidates.push({ statusLines: compactStatusLines, footerHints: [] });
    }
  }

  for (let count = statusLines.length - 1; count > 0; count -= 1) {
    candidates.push({
      statusLines: statusLines.slice(0, count),
      footerHints: [],
    });
    if (hasCompactFallback) {
      candidates.push({
        statusLines: compactStatusLines.slice(0, count),
        footerHints: [],
      });
    }
  }
  candidates.push({ statusLines: [], footerHints: [] });
  return candidates;
}

export function orchestrationLauncherLayout(
  input: OrchestrationLauncherLayoutInput,
): OrchestrationLauncherLayout {
  const textColumns = Math.max(1, input.columns - 2);
  const baseRows =
    orchestrationLinesRowCost(input.headerLines, textColumns) +
    ORCHESTRATION_SELECT_MARGIN_ROWS +
    ORCHESTRATION_KEY_HINT_ROWS;
  const targetVisibleItems = Math.min(
    ORCHESTRATION_TARGET_VISIBLE_ITEMS,
    input.itemCount,
  );

  for (const candidate of orchestrationLauncherLayoutCandidates(
    input.statusLines,
    input.footerHints,
  )) {
    const detailRows =
      orchestrationBlockRowCost(candidate.statusLines, textColumns) +
      orchestrationBlockRowCost(candidate.footerHints, textColumns);
    const selectWindow = computeSelectWindowSize({
      availableRows: input.rows,
      itemCount: input.itemCount,
      chromeRows: baseRows + detailRows,
    });
    if (
      (selectWindow.maxVisibleItems ?? input.itemCount) >= targetVisibleItems
    ) {
      return {
        statusLines: candidate.statusLines,
        footerHints: candidate.footerHints,
        ...selectWindow,
      };
    }
  }

  const selectWindow = computeSelectWindowSize({
    availableRows: input.rows,
    itemCount: input.itemCount,
    chromeRows: baseRows,
  });
  return {
    statusLines: [],
    footerHints: [],
    ...selectWindow,
  };
}

function modelPickKeyHints(): readonly KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: '1-9/a-z/Enter', action: 'select' },
    { key: 'Esc', action: 'back' },
  ];
}

function resumeKeyHints(): readonly KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: '1-9/a-z/Enter', action: 'resume' },
    { key: 'Esc', action: 'back' },
  ];
}

export function OrchestrationApp(
  props: OrchestrationAppProps,
): React.JSX.Element {
  const app = useApp();
  const { columns, rows } = useWindowSize();
  const accessView = (source: readonly CliOrchestrationItem[]) =>
    orchestrationModelAccessView(source, props.models, props.apiMode, {
      allowDefaultModelLaunch: props.allowDefaultModelLaunch,
    });
  const { items, modelItems } = accessView(props.items);
  const agentItems = accessView(props.agentItems ?? []).items;
  const teamItems = accessView(props.teamItems ?? []).items;
  const listFooterHints = orchestrationFooterHints(items);
  const statusLines = props.statusLines ?? [];
  const [step, setStep] = useState<OrchestrationLauncherStep>({
    kind: 'launcher',
  });
  const pending = step.kind === 'model' ? step.action : undefined;
  const modelAccessOpen = step.kind === 'model-access';
  const resumeOpen = step.kind === 'resume';
  const agentOpen = step.kind === 'agent';
  const teamOpen = step.kind === 'team';
  const accountOpen = step.kind === 'account';
  const modelAccessItems = props.modelAccess
    ? buildCliModelAccessItems({
        kind: 'loaded',
        access: props.modelAccess,
      })
    : [];
  const isPendingTeam = pending?.kind === 'preset';
  // One header per step, shared between the wrapped-row measurement below and
  // the styled render further down so the measured and displayed text can't
  // drift.
  let title: string;
  let subtitle: string;
  let itemCount: number;
  switch (step.kind) {
    case 'model-access':
      title = 'Model access';
      subtitle = CLI_MODEL_ACCESS_DESCRIPTION;
      itemCount = modelAccessItems.length;
      break;
    case 'resume':
      title = 'Resume';
      subtitle = 'Choose a previous session to continue.';
      itemCount = props.resumeItems?.length ?? 0;
      break;
    case 'agent':
      title = 'Agent';
      subtitle = 'Choose one agent for this session.';
      itemCount = agentItems.length;
      break;
    case 'team':
      title = 'Team';
      subtitle = 'Choose a team for this session.';
      itemCount = teamItems.length;
      break;
    case 'account':
      title = 'Account';
      subtitle = 'Sign in, change account, or sign out.';
      itemCount = props.accountItems?.length ?? 0;
      break;
    case 'model':
      title = isPendingTeam ? 'Lead model' : 'Model';
      subtitle = isPendingTeam
        ? 'Runs the orchestrator agent and is the model it can choose for delegation.'
        : 'Model for the first message.';
      itemCount = modelItems.length;
      break;
    case 'launcher':
      // The launcher renders its own branded header; measure the same rows.
      title = `TeXRA v${props.version}`;
      subtitle = 'Start a session or configure model access.';
      itemCount = items.length;
      break;
  }
  const headerLines: readonly string[] = [title, subtitle];

  let footerHints: readonly string[];
  if (teamOpen) {
    footerHints = orchestrationFooterHints(teamItems);
  } else if (step.kind === 'launcher') {
    footerHints = listFooterHints;
  } else {
    footerHints = [];
  }

  const layout = orchestrationLauncherLayout({
    rows,
    columns,
    itemCount,
    headerLines,
    statusLines: step.kind === 'launcher' ? statusLines : [],
    footerHints,
  });

  const finish = (action: CliOrchestrationAction): void => {
    props.onResolve(action);
    app.exit();
  };

  const goBack = (): void => {
    const previous = orchestrationPreviousStep(step);
    if (previous) {
      setStep(previous);
    } else {
      finish({ kind: 'exit' });
    }
  };

  const onItemSelect = (action: CliOrchestrationAction): void => {
    if (action.kind === 'configure-model-access') {
      setStep({ kind: 'model-access' });
      return;
    }
    if (action.kind === 'browse-resumes') {
      setStep({ kind: 'resume' });
      return;
    }
    if (action.kind === 'browse-agents') {
      setStep({ kind: 'agent' });
      return;
    }
    if (action.kind === 'browse-teams') {
      setStep({ kind: 'team' });
      return;
    }
    if (action.kind === 'browse-accounts') {
      setStep({ kind: 'account' });
      return;
    }
    if (isCliOrchestrationModelPickAction(action) && modelItems.length > 0) {
      setStep({
        kind: 'model',
        action,
        backTo:
          step.kind === 'agent' || step.kind === 'team'
            ? step.kind
            : 'launcher',
      });
    } else {
      finish(action);
    }
  };

  useInput((_input, key) => {
    if (!key.escape) return;
    goBack();
  });

  if (modelAccessOpen) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>{subtitle}</Text>
        <Box marginTop={1}>
          <Select
            key="orchestration-model-access-picker"
            items={modelAccessItems}
            activeValue={cliApiFallbackSelection(props.apiMode)}
            maxVisibleItems={layout.maxVisibleItems}
            showOverflow={layout.showOverflow}
            onSelect={(access) => finish({ kind: 'set-model-access', access })}
            onCancel={goBack}
          />
        </Box>
        <Box marginTop={1}>
          <KeyHints hints={modelPickKeyHints()} confirmCancel={false} />
        </Box>
      </Box>
    );
  }

  if (resumeOpen) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>{subtitle}</Text>
        <Box marginTop={1}>
          <Select
            key="orchestration-resume-picker"
            items={props.resumeItems ?? []}
            maxVisibleItems={layout.maxVisibleItems}
            showOverflow={layout.showOverflow}
            onSelect={finish}
            onCancel={goBack}
          />
        </Box>
        <Box marginTop={1}>
          <KeyHints hints={resumeKeyHints()} confirmCancel={false} />
        </Box>
      </Box>
    );
  }

  if (agentOpen || teamOpen || accountOpen) {
    let pickerItems: readonly CliOrchestrationItem[];
    if (agentOpen) {
      pickerItems = agentItems;
    } else if (teamOpen) {
      pickerItems = teamItems;
    } else {
      pickerItems = props.accountItems ?? [];
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>{subtitle}</Text>
        <Box marginTop={1}>
          <Select
            key={`orchestration-${step.kind}-picker`}
            items={pickerItems}
            maxVisibleItems={layout.maxVisibleItems}
            showOverflow={layout.showOverflow}
            onSelect={onItemSelect}
            onCancel={goBack}
          />
        </Box>
        {layout.footerHints.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            {layout.footerHints.map((hint) => (
              <Text key={hint} dimColor wrap="wrap">
                {hint}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <KeyHints hints={modelPickKeyHints()} confirmCancel={false} />
        </Box>
      </Box>
    );
  }

  if (pending) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {title}
        </Text>
        <Text dimColor>{subtitle}</Text>
        <Box marginTop={1}>
          <Select
            key="orchestration-model-picker"
            items={modelItems}
            maxVisibleItems={layout.maxVisibleItems}
            showOverflow={layout.showOverflow}
            onSelect={(model) => finish({ ...pending, model })}
            onCancel={goBack}
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
          {'{ T } TeXRA'}
        </Text>
        <Text dimColor>v{props.version}</Text>
      </Box>
      <Text dimColor>{subtitle}</Text>
      {layout.statusLines.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {layout.statusLines.map((line, index) => (
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
          maxVisibleItems={layout.maxVisibleItems}
          showOverflow={layout.showOverflow}
          onSelect={onItemSelect}
          onCancel={goBack}
        />
      </Box>
      {layout.footerHints.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {layout.footerHints.map((hint) => (
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
  readonly resumeItems?: readonly CliOrchestrationItem[];
  readonly agentItems?: readonly CliOrchestrationItem[];
  readonly teamItems?: readonly CliOrchestrationItem[];
  readonly accountItems?: readonly CliOrchestrationItem[];
  readonly apiMode: CliApiMode;
  readonly modelAccess?: CliModelAccessStatus;
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
        resumeItems={options.resumeItems}
        agentItems={options.agentItems}
        teamItems={options.teamItems}
        accountItems={options.accountItems}
        models={options.models}
        apiMode={options.apiMode}
        modelAccess={options.modelAccess}
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
