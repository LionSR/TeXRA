import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ExecutionId } from '@shared/schemas';

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

const MAX_RECENT_RESUME_ITEMS = 3;
const MAX_RECENT_AGENT_ITEMS = 3;

export function buildCliOrchestrationItems(
  input: BuildCliOrchestrationItemsInput,
): CliOrchestrationItem[] {
  const userStartedHistory = userStartedCliHistoryEntries(input.history);
  const items: CliOrchestrationItem[] = [
    {
      value: { kind: 'chat' },
      label: 'New chat',
      description: 'Start the default tool-use chat',
    },
  ];

  items.push(...recentResumeItems(userStartedHistory));
  items.push(...recentAgentItems(userStartedHistory, input.toolUseAgents));
  items.push(
    ...presetItems(input.presetPlans, {
      includeLoginHint: input.includeMultiAgentLoginHint,
    }),
  );
  items.push({
    value: { kind: 'help' },
    label: 'Help',
    description: 'Show CLI commands',
  });
  return items;
}

function recentResumeItems(
  history: readonly CliHistoryEntry[],
): CliOrchestrationItem[] {
  return resumableCliHistoryEntries(history)
    .slice(0, MAX_RECENT_RESUME_ITEMS)
    .map((entry) => ({
      value: { kind: 'resume', id: entry.id },
      label: `Resume ${entry.id}`,
      description: formatCliHistoryResumeSummary(entry),
    }));
}

function recentAgentItems(
  history: readonly CliHistoryEntry[],
  toolUseAgents: readonly AgentEntry[],
): CliOrchestrationItem[] {
  const toolUseNames = new Set(
    implicitDefaultToolUseAgents(toolUseAgents).map((agent) => agent.name),
  );
  // The agent "New chat" already starts (the roster-resolved default, which is
  // `assistant` on a full catalog but the team lead under a scoped roster), so
  // it isn't duplicated as a redundant "Chat with …" recent row.
  const defaultAgent = pickDefaultToolUseAgent(toolUseAgents);
  const seen = new Set<string>();
  const items: CliOrchestrationItem[] = [];

  for (const entry of history) {
    if (entry.category && entry.category !== AgentCategory.ToolUse) continue;
    if (entry.agent === defaultAgent) continue;
    if (!toolUseNames.has(entry.agent) || seen.has(entry.agent)) continue;
    seen.add(entry.agent);
    items.push({
      value: { kind: 'chat', agent: entry.agent },
      label: `Chat with ${entry.agent}`,
      description: 'Recent tool-use agent',
    });
    if (items.length >= MAX_RECENT_AGENT_ITEMS) break;
  }

  return items;
}

// Lists every available team (built-in and custom) so the user can pick and
// switch among them in the launcher, rather than being pinned to one. The
// Select component windows and scrolls the visible rows, so the full team list
// is offered without an artificial data cap that would hide extra custom teams.
function presetItems(
  plans: readonly CliMultiAgentPresetRunPlan[],
  options: {
    readonly includeLoginHint?: boolean;
  },
): CliOrchestrationItem[] {
  return plans.map((plan) => ({
    value: { kind: 'preset', preset: plan.preset.id },
    label: `Team ${plan.preset.name}`,
    description: formatCliMultiAgentPresetLauncherSummary(plan),
    disabled: !cliMultiAgentPresetCanLaunchTeam(plan),
    footerHints: formatCliMultiAgentPresetLauncherHints(plan, {
      includeLoginHint: options.includeLoginHint,
    }),
  }));
}
