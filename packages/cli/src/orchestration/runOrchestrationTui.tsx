import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useState } from 'react';

import { Select } from '@cli/tui/ui/Select';
import type { KeyHint } from '@cli/tui/ui/KeyHints';
import { WizardStepShell } from '@cli/tui/ui/WizardStepShell';
import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { computeSelectWindowSize } from '@cli/tui/selectWindow';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import {
  isCliOrchestrationModelPickAction,
  orchestrationModelAccessView,
  type CliOrchestrationAction,
  type CliOrchestrationItem,
  type CliOrchestrationModelPickAction,
} from '../runtime/orchestration';
import { CLI_ACCOUNT_ACCESS_DESCRIPTION } from '../runtime/modelAccessRoute';
import type { CliModelAccess } from '../runtime/modelAccess';

interface OrchestrationAppProps {
  readonly items: readonly CliOrchestrationItem[];
  readonly resumeItems?: readonly CliOrchestrationItem[];
  readonly agentItems?: readonly CliOrchestrationItem[];
  readonly teamItems?: readonly CliOrchestrationItem[];
  /** Rows of the "Account & access" step — preference toggles plus account
   *  sign-in/out actions, already resolvable launcher actions. */
  readonly accountAccessItems?: readonly CliOrchestrationItem[];
  /** Model access list for the second step. An empty list means unknown
   *  registry state, so the launcher still starts chats with runtime defaults;
   *  a known list with no runnable model disables chat/team starts. */
  readonly models: readonly CliModelAccess[];
  /** CLI version, shown in the launcher header (matches the chat session
   *  header) so a directly-launched `texra` reports which build is running. */
  readonly version: string;
  readonly statusLines?: readonly string[];
  readonly allowDefaultModelLaunch?: boolean;
  readonly onResolve: (action: CliOrchestrationAction) => void;
}

type OrchestrationLauncherStep =
  | { readonly kind: 'launcher' }
  | {
      readonly kind: 'model';
      readonly action: CliOrchestrationModelPickAction;
      readonly backTo: 'launcher' | 'agent' | 'team';
    }
  | { readonly kind: 'account-access' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'agent' }
  | { readonly kind: 'team' };

/** Return the parent picker for Escape, or null when Escape exits the launcher. */
export function orchestrationPreviousStep(
  step: OrchestrationLauncherStep,
): OrchestrationLauncherStep | null {
  if (step.kind === 'launcher') return null;
  if (step.kind === 'model') return { kind: step.backTo };
  return { kind: 'launcher' };
}

/** Every picker in the launcher shares one hint row; only the verb for the
 *  select key and the destination of Escape change between steps. */
function orchestrationStepKeyHints(
  selectAction: string,
  escapeAction: string,
): readonly KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: '1-9/a-z/Enter', action: selectAction },
    { key: 'Esc', action: escapeAction },
  ];
}

function orchestrationKeyHints(): readonly KeyHint[] {
  return orchestrationStepKeyHints('open', 'exit');
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

function orchestrationWrappedLineRows(line: string, columns: number): number {
  return Math.max(
    1,
    wrapAnsiToWidth(line, Math.max(1, columns)).split('\n').length,
  );
}

/** Rows a marginTop=1 block of lines occupies (wrapped lines plus the margin). */
function orchestrationBlockRowCost(
  lines: readonly string[],
  columns: number,
): number {
  if (lines.length === 0) return 0;
  return 1 + orchestrationLinesRowCost(lines, columns);
}

interface OrchestrationLauncherLayout {
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
// Shared by the launcher's branded header render and the row measurement that
// budgets around it, so the two can never disagree about the header's width.
const LAUNCHER_BRAND = '{ T } TeXRA';

function orchestrationLinesRowCost(
  lines: readonly string[],
  columns: number,
): number {
  return lines.reduce(
    (rows, line) => rows + orchestrationWrappedLineRows(line, columns),
    0,
  );
}

function orchestrationLauncherLayoutCandidates(
  statusLines: readonly string[],
  footerHints: readonly string[],
): OrchestrationLauncherLayoutCandidate[] {
  const candidates: OrchestrationLauncherLayoutCandidate[] = [
    { statusLines, footerHints },
  ];
  if (footerHints.length > 0) {
    candidates.push({ statusLines, footerHints: [] });
  }

  for (let count = statusLines.length - 1; count > 0; count -= 1) {
    candidates.push({
      statusLines: statusLines.slice(0, count),
      footerHints: [],
    });
  }
  // No empty-detail candidate: the caller's post-loop fallback is that layout.
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

export function OrchestrationApp(
  props: OrchestrationAppProps,
): React.JSX.Element {
  const app = useApp();
  const { columns, rows } = useWindowSize();
  const accessView = (source: readonly CliOrchestrationItem[]) =>
    orchestrationModelAccessView(source, props.models, {
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
  const isPendingTeam = pending?.kind === 'preset';
  // One header per step, shared between the wrapped-row measurement below and
  // the styled render further down so the measured and displayed text can't
  // drift.
  let title: string;
  let subtitle: string;
  let itemCount: number;
  switch (step.kind) {
    case 'account-access':
      title = 'Account & access';
      subtitle = CLI_ACCOUNT_ACCESS_DESCRIPTION;
      itemCount = props.accountAccessItems?.length ?? 0;
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
    case 'model':
      title = isPendingTeam ? 'Lead model' : 'Model';
      subtitle = isPendingTeam
        ? 'Runs the orchestrator agent and is the model it can choose for delegation.'
        : 'Model for the first message.';
      itemCount = modelItems.length;
      break;
    case 'launcher':
      // The launcher renders its own branded header; measure the same rows.
      title = `${LAUNCHER_BRAND} v${props.version}`;
      subtitle = 'Start a session or configure model access.';
      itemCount = items.length;
      break;
  }
  const headerLines: readonly string[] = [title, subtitle];

  let footerHints: readonly string[];
  if (step.kind === 'team') {
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
    if (action.kind === 'browse-account-access') {
      setStep({ kind: 'account-access' });
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

  const selectProps = {
    maxVisibleItems: layout.maxVisibleItems,
    showOverflow: layout.showOverflow,
    onCancel: goBack,
  } as const;

  // One picker per step. Everything around it — header, status lines, footer
  // hints, key hints — is the shared `WizardStepShell`, so a new step only
  // declares the list it shows and how Enter reads.
  let stepSelect: React.JSX.Element;
  let stepKeyHints: readonly KeyHint[];
  switch (step.kind) {
    case 'account-access':
      stepSelect = (
        <Select
          key="orchestration-account-access-picker"
          items={props.accountAccessItems ?? []}
          onSelect={finish}
          {...selectProps}
        />
      );
      stepKeyHints = orchestrationStepKeyHints('select', 'back');
      break;
    case 'resume':
      stepSelect = (
        <Select
          key="orchestration-resume-picker"
          items={props.resumeItems ?? []}
          onSelect={finish}
          {...selectProps}
        />
      );
      stepKeyHints = orchestrationStepKeyHints('resume', 'back');
      break;
    case 'agent':
    case 'team': {
      const pickerItems = step.kind === 'agent' ? agentItems : teamItems;
      stepSelect = (
        <Select
          key={`orchestration-${step.kind}-picker`}
          items={pickerItems}
          onSelect={onItemSelect}
          {...selectProps}
        />
      );
      stepKeyHints = orchestrationStepKeyHints('select', 'back');
      break;
    }
    case 'model':
      stepSelect = (
        <Select
          key="orchestration-model-picker"
          items={modelItems}
          onSelect={(model) => finish({ ...step.action, model })}
          {...selectProps}
        />
      );
      stepKeyHints = orchestrationStepKeyHints('select', 'back');
      break;
    case 'launcher':
      stepSelect = (
        <Select
          key="orchestration-launcher"
          items={items}
          onSelect={onItemSelect}
          {...selectProps}
        />
      );
      stepKeyHints = orchestrationKeyHints();
      break;
  }

  return (
    <WizardStepShell
      title={
        step.kind === 'launcher' ? (
          <Box gap={1}>
            <Text bold color={COLOR_HINT}>
              {LAUNCHER_BRAND}
            </Text>
            <Text dimColor>v{props.version}</Text>
          </Box>
        ) : (
          <Text bold color={COLOR_HINT}>
            {title}
          </Text>
        )
      }
      subtitle={subtitle}
      statusLines={layout.statusLines}
      footerHints={layout.footerHints}
      keyHints={stepKeyHints}
    >
      {stepSelect}
    </WizardStepShell>
  );
}

interface RunOrchestrationTuiOptions extends Omit<
  OrchestrationAppProps,
  'items' | 'onResolve'
> {
  readonly colorEnabled?: boolean;
}

export async function runOrchestrationTui(
  items: readonly CliOrchestrationItem[],
  options: RunOrchestrationTuiOptions,
): Promise<CliOrchestrationAction> {
  const { colorEnabled, ...appProps } = options;
  const chosen = await renderCliPrompt<CliOrchestrationAction>(
    (resolve) => (
      <OrchestrationApp {...appProps} items={items} onResolve={resolve} />
    ),
    {
      stdout: process.stdout,
      stderr: process.stderr,
      colorEnabled,
    },
  );
  return chosen ?? { kind: 'exit' };
}
