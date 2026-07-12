import type { AgentEntry } from '@agent/index';
import type { ExecutionId } from '@shared/schemas';
import { agentKeyOf } from '@shared/schemas/agent';

import {
  cliMultiAgentPresetCanLaunchTeam,
  formatCliMultiAgentPresetLauncherHints,
  formatCliMultiAgentPresetLauncherSummary,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';
import {
  implicitDefaultToolUseAgents,
  pickDefaultToolUseAgent,
} from './defaultAgents';
import { formatCliHistoryResumeSummary } from './historyLabels';
import {
  resumableCliHistoryEntries,
  userStartedCliHistoryEntries,
  type CliHistoryEntry,
} from './history';
import {
  modelAccessLaunchBlockDescriptionForCliMode,
  modelSelectItemsForCliMode,
  type CliModelAccess,
  type CliModelPickerItem,
} from './modelAccess';
import type { CliApiMode } from './apiAccessMode';

export type CliOrchestrationAction =
  | { readonly kind: 'chat'; readonly agent?: string; readonly model?: string }
  | {
      readonly kind: 'preset';
      readonly preset: string;
      /** Lead model the orchestrator agent starts on (and is offered for
       *  delegation). Chosen in the launcher's model step. */
      readonly model?: string;
    }
  | { readonly kind: 'resume'; readonly id: ExecutionId }
  | { readonly kind: 'browse-resumes' }
  | { readonly kind: 'browse-agents' }
  | { readonly kind: 'browse-teams' }
  | { readonly kind: 'browse-accounts' }
  | {
      readonly kind: 'account';
      readonly provider: CliAccountProvider;
      readonly operation: CliAccountOperation;
    }
  | { readonly kind: 'configure-model-access' }
  | {
      readonly kind: 'set-model-access';
      readonly access: CliModelAccessRoute;
    }
  | { readonly kind: 'help' }
  | { readonly kind: 'exit' };

/** Launcher items that chain into a model pick before launching the chat. */
export type CliOrchestrationModelPickAction = Extract<
  CliOrchestrationAction,
  { kind: 'chat' | 'preset' }
>;

export interface CliOrchestrationItem {
  readonly value: CliOrchestrationAction;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly footerHints?: readonly string[];
}

export interface BuildCliOrchestrationItemsInput {
  readonly presetPlans: readonly CliMultiAgentPresetRunPlan[];
  readonly history: readonly CliHistoryEntry[];
  readonly toolUseAgents: readonly AgentEntry[];
  readonly includeMultiAgentLoginHint?: boolean;
  readonly modelAccess?: CliModelAccessStatus;
  readonly account?: CliAccountStatus;
}

export type CliModelAccessRoute = 'chatgpt' | 'included' | 'personal';
export type CliAccountProvider = 'chatgpt' | 'texra';
export type CliAccountOperation = 'sign-in' | 'switch' | 'sign-out';

export interface CliAccountStatus {
  readonly texraSignedIn: boolean;
  readonly texraAccountLabel?: string;
  readonly texraCredentialSource?: 'session' | 'relayToken';
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
}

export interface CliModelAccessStatus {
  readonly active: CliModelAccessRoute;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
  readonly texraSignedIn?: boolean;
}

export interface CliModelAccessItem {
  readonly value: CliModelAccessRoute;
  readonly label: string;
  readonly description: string;
}

export function isCliOrchestrationModelPickAction(
  action: CliOrchestrationAction,
): action is CliOrchestrationModelPickAction {
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
  readonly modelItems: readonly CliModelPickerItem[];
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
    items: items.map((item) => {
      if (!isCliOrchestrationModelPickAction(item.value) || item.disabled) {
        return item;
      }
      return { ...item, description, disabled: true };
    }),
  };
}

export function buildCliOrchestrationItems(
  input: BuildCliOrchestrationItemsInput,
): CliOrchestrationItem[] {
  const userStartedHistory = userStartedCliHistoryEntries(input.history);
  const items: CliOrchestrationItem[] = [
    {
      value: { kind: 'chat' },
      label: 'New chat',
      description: `Start with ${pickDefaultToolUseAgent(input.toolUseAgents)}`,
    },
  ];

  const resumeItems = buildCliResumeItems(userStartedHistory);
  if (resumeItems.length > 0) {
    items.push({
      value: { kind: 'browse-resumes' },
      label: 'Resume',
      description: `${resumeItems.length} resumable ${resumeItems.length === 1 ? 'session' : 'sessions'}`,
    });
  }
  if (buildCliAgentItems(input.toolUseAgents).length > 0) {
    items.push({
      value: { kind: 'browse-agents' },
      label: 'Agent',
      description: 'Choose one agent',
    });
  }
  if (input.presetPlans.length > 0) {
    items.push({
      value: { kind: 'browse-teams' },
      label: 'Team',
      description: 'Choose a team',
    });
  }
  if (input.modelAccess) {
    items.push(modelAccessItem(input.modelAccess));
  }
  if (input.account) {
    items.push({
      value: { kind: 'browse-accounts' },
      label: 'Account',
      description: accountSummary(input.account),
    });
  }
  items.push({
    value: { kind: 'help' },
    label: 'Help',
    description: 'Show CLI commands',
  });
  return items;
}

function accountSummary(status: CliAccountStatus): string {
  if (status.texraCredentialSource === 'relayToken') {
    return status.chatGptSignedIn
      ? 'TeXRA relay token and ChatGPT signed in'
      : 'TeXRA relay token configured';
  }
  if (status.texraSignedIn && status.chatGptSignedIn) {
    return 'TeXRA and ChatGPT signed in';
  }
  if (status.chatGptSignedIn) {
    return `ChatGPT · ${status.chatGptAccountLabel ?? 'signed in'}`;
  }
  if (status.texraSignedIn) {
    return `TeXRA · ${status.texraAccountLabel ?? 'signed in'}`;
  }
  return 'Sign in or manage accounts';
}

export function buildCliAccountItems(
  status: CliAccountStatus,
): CliOrchestrationItem[] {
  const items: CliOrchestrationItem[] = [];
  if (status.chatGptSignedIn) {
    items.push({
      value: {
        kind: 'account',
        provider: 'chatgpt',
        operation: 'sign-out',
      },
      label: 'Sign out of ChatGPT',
      description: status.chatGptAccountLabel ?? 'ChatGPT subscription',
    });
  } else {
    items.push({
      value: {
        kind: 'account',
        provider: 'chatgpt',
        operation: 'sign-in',
      },
      label: 'Sign in with ChatGPT',
      description: 'Use a ChatGPT subscription',
    });
  }

  if (status.texraSignedIn) {
    if (status.texraCredentialSource === 'relayToken') {
      items.push({
        value: { kind: 'account', provider: 'texra', operation: 'sign-out' },
        label: 'TeXRA relay token',
        description: 'Managed by the TEXRA_RELAY_TOKEN environment variable',
        disabled: true,
      });
    } else {
      items.push(
        {
          value: { kind: 'account', provider: 'texra', operation: 'switch' },
          label: 'Change TeXRA account',
          description: status.texraAccountLabel ?? 'Researcher Access',
        },
        {
          value: { kind: 'account', provider: 'texra', operation: 'sign-out' },
          label: 'Sign out of TeXRA',
          description: status.texraAccountLabel ?? 'Researcher Access',
        },
      );
    }
  } else {
    items.push({
      value: { kind: 'account', provider: 'texra', operation: 'sign-in' },
      label: 'Sign in to TeXRA',
      description: 'Use included Researcher Access',
    });
  }
  return items;
}

export function buildCliAgentItems(
  toolUseAgents: readonly AgentEntry[],
): CliOrchestrationItem[] {
  const priority = new Map([
    ['assistant', 0],
    ['orchestrator', 1],
  ]);
  return implicitDefaultToolUseAgents(toolUseAgents)
    .toSorted((left, right) => {
      const byPriority =
        (priority.get(left.name) ?? 2) - (priority.get(right.name) ?? 2);
      return byPriority || left.name.localeCompare(right.name);
    })
    .map((agent) => ({
      value: { kind: 'chat', agent: agentKeyOf(agent) },
      label: agent.name,
      description: agent.description ?? 'Tool-use agent',
    }));
}

function modelAccessItem(status: CliModelAccessStatus): CliOrchestrationItem {
  return {
    value: { kind: 'configure-model-access' },
    label: 'Model access',
    description:
      status.active === 'chatgpt' && status.chatGptAccountLabel
        ? `ChatGPT subscription · ${status.chatGptAccountLabel}`
        : modelAccessRouteLabel(status.active),
  };
}

export function modelAccessRouteLabel(route: CliModelAccessRoute): string {
  switch (route) {
    case 'chatgpt':
      return 'ChatGPT subscription';
    case 'included':
      return 'Included TeXRA access';
    case 'personal':
      return 'Personal API keys';
  }
}

export function buildModelAccessItems(
  status: CliModelAccessStatus,
): CliModelAccessItem[] {
  return [
    {
      value: 'chatgpt',
      label: 'Prefer ChatGPT subscription',
      description:
        status.active === 'chatgpt'
          ? `On · ${status.chatGptAccountLabel ?? 'your account'}`
          : status.chatGptSignedIn
            ? `Off · ${status.chatGptAccountLabel ?? 'your account'}`
            : 'Sign in with ChatGPT Plus/Pro/Team',
    },
    {
      value: 'included',
      label: modelAccessRouteLabel('included'),
      description:
        status.texraSignedIn === false
          ? 'Sign in through Account to use included models'
          : 'Use your TeXRA account',
    },
    {
      value: 'personal',
      label: modelAccessRouteLabel('personal'),
      description: 'Use keys configured on this computer',
    },
  ];
}

export function buildCliResumeItems(
  history: readonly CliHistoryEntry[],
): CliOrchestrationItem[] {
  return resumableCliHistoryEntries(userStartedCliHistoryEntries(history))
    .slice(0, 50)
    .map((entry) => ({
      value: { kind: 'resume', id: entry.id },
      label: entry.id,
      description: `${entry.timestamp}; ${formatCliHistoryResumeSummary(entry)}`,
    }));
}

// Lists every available team (built-in and custom) so the user can pick and
// switch among them in the launcher, rather than being pinned to one. The
// Select component windows and scrolls the visible rows, so the full team list
// is offered without an artificial data cap that would hide extra custom teams.
export function buildCliTeamItems(
  plans: readonly CliMultiAgentPresetRunPlan[],
  options: {
    readonly includeLoginHint?: boolean;
  },
): CliOrchestrationItem[] {
  return plans.map((plan) => ({
    value: { kind: 'preset', preset: plan.preset.id },
    label: `Team ${plan.preset.id}`,
    description: [
      formatCliMultiAgentPresetLauncherSummary(plan),
      plan.preset.name,
    ].join('; '),
    disabled: !cliMultiAgentPresetCanLaunchTeam(plan),
    footerHints: formatCliMultiAgentPresetLauncherHints(plan, {
      includeLoginHint: options.includeLoginHint,
    }),
  }));
}
