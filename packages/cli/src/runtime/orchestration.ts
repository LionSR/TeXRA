import type { AgentEntry } from '@agent/index';
import {
  canLaunchTeam,
  teamTexraHostedMissingNames,
} from '@common/teams/TeamPlan';
import type { ExecutionId } from '@shared/schemas';
import { agentKeyOf, agentName } from '@shared/schemas';
import { implicitDefaultToolUseAgents } from '@shared/constants/agents';
import { CHATGPT_AUTH, GROK_AUTH } from '@shared/copy/accountAuth';
import { formatResultCount } from '@utils/text/stringUtils';

import {
  formatCliMultiAgentPresetLauncherHints,
  formatCliMultiAgentPresetLauncherSummary,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';
import {
  DEFAULT_AGENT_PRIORITY,
  pickDefaultToolUseAgent,
} from './defaultAgents';
import { formatCliHistoryResumeSummary } from './historyLabels';
import {
  resumableCliHistoryEntries,
  RESUME_LIST_LIMIT,
  type CliHistoryEntry,
} from './history';
import {
  modelAccessLaunchBlockDescription,
  modelSelectItemsForCli,
  type CliModelAccess,
  type CliModelPickerItem,
} from './modelAccess';
import {
  formatCliModelAccessSummary,
  type CliModelAccessSelection,
  type CliModelAccessStatus,
} from './modelAccessRoute';

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
  | { readonly kind: 'configure-settings' }
  | {
      readonly kind: 'account';
      readonly provider: CliAccountProvider;
      readonly operation: CliAccountOperation;
    }
  | { readonly kind: 'configure-model-access' }
  | {
      readonly kind: 'set-model-access';
      readonly access: CliModelAccessSelection;
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

type CliPresetLaunchBlockReason = 'delegation-denied';

export interface BuildCliOrchestrationItemsInput {
  readonly presetPlans: readonly CliMultiAgentPresetRunPlan[];
  /**
   * User-visible history rows, as produced by `listCliHistoryEntries` —
   * which already applies `isUserVisibleExecution`. Menu builders trust
   * that filter rather than re-applying it.
   */
  readonly history: readonly CliHistoryEntry[];
  readonly toolUseAgents: readonly AgentEntry[];
  readonly includeMultiAgentLoginHint?: boolean;
  readonly modelAccess?: CliModelAccessStatus;
  readonly account?: CliAccountStatus;
  readonly presetLaunchBlockReason?: CliPresetLaunchBlockReason;
}

type CliAccountProvider = 'chatgpt' | 'grok' | 'texra';
type CliAccountOperation = 'sign-in' | 'sign-out';

export interface CliAccountStatus {
  readonly texraSignedIn: boolean;
  readonly texraAccountLabel?: string;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
  readonly grokSignedIn: boolean;
  readonly grokAccountLabel?: string;
}

export function isCliOrchestrationModelPickAction(
  action: CliOrchestrationAction,
): action is CliOrchestrationModelPickAction {
  return action.kind === 'chat' || action.kind === 'preset';
}

export function orchestrationModelAccessView(
  items: readonly CliOrchestrationItem[],
  models: readonly CliModelAccess[],
  options: {
    readonly allowDefaultModelLaunch?: boolean;
  } = {},
): {
  readonly items: readonly CliOrchestrationItem[];
  readonly modelItems: readonly CliModelPickerItem[];
} {
  const modelItems = modelSelectItemsForCli(models);
  if (
    models.length === 0 ||
    modelItems.length > 0 ||
    options.allowDefaultModelLaunch === true
  ) {
    return { items, modelItems };
  }

  const description = modelAccessLaunchBlockDescription();
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

const TEAM_DELEGATION_DENIED_DESCRIPTION =
  'Delegation blocked by "never"; use ask or yolo';
export function buildCliOrchestrationItems(
  input: BuildCliOrchestrationItemsInput,
): CliOrchestrationItem[] {
  const items: CliOrchestrationItem[] = [
    {
      value: { kind: 'chat' },
      label: 'New chat',
      description: `Start with ${pickDefaultToolUseAgent(input.toolUseAgents)}`,
    },
  ];

  if (input.presetPlans.length > 0) {
    const launchBlocked = input.presetLaunchBlockReason === 'delegation-denied';
    items.push({
      value: { kind: 'browse-teams' },
      label: 'Team',
      description: launchBlocked
        ? TEAM_DELEGATION_DENIED_DESCRIPTION
        : 'Choose a team',
      disabled: launchBlocked,
    });
  }
  // Count only — the rows themselves are built when the browser opens, and
  // the count is capped at the same limit so it never reports more sessions
  // than the browser can list.
  const resumableCount = Math.min(
    resumableCliHistoryEntries(input.history).length,
    RESUME_LIST_LIMIT,
  );
  if (resumableCount > 0) {
    items.push({
      value: { kind: 'browse-resumes' },
      label: 'Resume',
      description: formatResultCount(resumableCount, 'session'),
    });
  }
  if (implicitDefaultToolUseAgents(input.toolUseAgents).length > 0) {
    items.push({
      value: { kind: 'browse-agents' },
      label: 'Agent',
      description: 'Choose one agent',
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
    value: { kind: 'configure-settings' },
    label: 'Settings',
    description: 'Agents and CLI configuration',
  });
  items.push({
    value: { kind: 'help' },
    label: 'Help',
    description: 'Show CLI commands',
  });
  return items;
}

function accountSummary(status: CliAccountStatus): string {
  const signed: string[] = [];
  if (status.texraSignedIn) {
    signed.push('TeXRA');
  }
  if (status.chatGptSignedIn) signed.push('ChatGPT');
  if (status.grokSignedIn) signed.push('Grok');
  if (signed.length === 0) return 'Sign in or manage accounts';
  if (signed.length === 1) {
    if (status.chatGptSignedIn) {
      return `ChatGPT · ${status.chatGptAccountLabel ?? 'signed in'}`;
    }
    if (status.grokSignedIn) {
      return `Grok · ${status.grokAccountLabel ?? 'signed in'}`;
    }
    return `TeXRA · ${status.texraAccountLabel ?? 'signed in'}`;
  }
  // Oxford list for 3+ accounts ("A, B, and C"), plain "A and B" for two.
  if (signed.length === 2) return `${signed[0]} and ${signed[1]} signed in`;
  return `${signed.slice(0, -1).join(', ')}, and ${signed.at(-1)} signed in`;
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
      label: CHATGPT_AUTH.signOutLabel,
      description: status.chatGptAccountLabel ?? CHATGPT_AUTH.subscriptionLabel,
    });
  } else {
    items.push({
      value: {
        kind: 'account',
        provider: 'chatgpt',
        operation: 'sign-in',
      },
      label: CHATGPT_AUTH.signInLabel,
      description: 'Use a ChatGPT subscription',
    });
  }

  if (status.grokSignedIn) {
    items.push({
      value: {
        kind: 'account',
        provider: 'grok',
        operation: 'sign-out',
      },
      label: GROK_AUTH.signOutLabel,
      description: status.grokAccountLabel ?? GROK_AUTH.subscriptionLabel,
    });
  } else {
    items.push({
      value: {
        kind: 'account',
        provider: 'grok',
        operation: 'sign-in',
      },
      label: GROK_AUTH.signInLabel,
      description: 'Use a Grok / SuperGrok subscription',
    });
  }

  if (status.texraSignedIn) {
    items.push({
      value: { kind: 'account', provider: 'texra', operation: 'sign-out' },
      label: 'Log out of TeXRA',
      description: '',
    });
  } else {
    items.push({
      value: { kind: 'account', provider: 'texra', operation: 'sign-in' },
      label: 'Log in to TeXRA',
      description: '',
    });
  }
  return items;
}

export function buildCliAgentItems(
  toolUseAgents: readonly AgentEntry[],
): CliOrchestrationItem[] {
  // Order by the implicit-default priority (`pickDefaultToolUseAgent`) so the
  // first row is the agent a bare Enter starts. Stable sorting preserves roster
  // input order when no preferred name is visible, matching the picker's final
  // fallback. `agentName` keeps name normalization owned by the same helper.
  const unprioritized = DEFAULT_AGENT_PRIORITY.length;
  const priorityOf = (name: string): number => {
    const index = DEFAULT_AGENT_PRIORITY.indexOf(agentName(name));
    return index === -1 ? unprioritized : index;
  };
  return implicitDefaultToolUseAgents(toolUseAgents)
    .toSorted((left, right) => priorityOf(left.name) - priorityOf(right.name))
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
    description: formatCliModelAccessSummary(status),
  };
}

export function buildCliResumeItems(
  history: readonly CliHistoryEntry[],
): CliOrchestrationItem[] {
  return resumableCliHistoryEntries(history)
    .slice(0, RESUME_LIST_LIMIT)
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
    readonly launchBlockReason?: CliPresetLaunchBlockReason;
    readonly remoteAgentCatalogAvailable?: boolean;
  },
): CliOrchestrationItem[] {
  const launchBlockedDescription =
    options.launchBlockReason === 'delegation-denied'
      ? TEAM_DELEGATION_DENIED_DESCRIPTION
      : undefined;
  return plans.map((plan) => ({
    value: { kind: 'preset', preset: plan.preset.id },
    label: `Team ${plan.preset.id}`,
    description:
      launchBlockedDescription ??
      [formatCliMultiAgentPresetLauncherSummary(plan), plan.preset.name].join(
        '; ',
      ),
    disabled:
      launchBlockedDescription !== undefined ||
      (!canLaunchTeam(plan) &&
        !(
          options.remoteAgentCatalogAvailable === false &&
          teamTexraHostedMissingNames(plan).length > 0
        )),
    footerHints: formatCliMultiAgentPresetLauncherHints(plan, {
      includeLoginHint: options.includeLoginHint,
    }),
  }));
}
