import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ExecutionId } from '@shared/schemas';

import {
  cliMultiAgentPresetCanLaunchTeam,
  formatCliMultiAgentPresetLauncherHints,
  formatCliMultiAgentPresetLauncherSummary,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';
import { implicitDefaultToolUseAgents } from './defaultAgents';
import { formatCliHistoryResumeInputLabel } from './historyLabels';
import {
  resumableCliHistoryEntries,
  userStartedCliHistoryEntries,
  type CliHistoryEntry,
} from './history';

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

const MAX_RECENT_RESUME_ITEMS = 3;
const MAX_RECENT_AGENT_ITEMS = 3;
const MAX_PRESET_ITEMS = 6;

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
      description: `${entry.agent}; ${entry.status}; ${formatCliHistoryResumeInputLabel(entry)}`,
    }));
}

function recentAgentItems(
  history: readonly CliHistoryEntry[],
  toolUseAgents: readonly AgentEntry[],
): CliOrchestrationItem[] {
  const toolUseNames = new Set(
    implicitDefaultToolUseAgents(toolUseAgents).map((agent) => agent.name),
  );
  const seen = new Set<string>();
  const items: CliOrchestrationItem[] = [];

  for (const entry of history) {
    if (entry.category && entry.category !== AgentCategory.ToolUse) continue;
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

function presetItems(
  plans: readonly CliMultiAgentPresetRunPlan[],
  options: { readonly includeLoginHint?: boolean },
): CliOrchestrationItem[] {
  return plans.slice(0, MAX_PRESET_ITEMS).map((plan) => ({
    value: { kind: 'preset', preset: plan.preset.id },
    label: `Team ${plan.preset.name}`,
    description: formatCliMultiAgentPresetLauncherSummary(plan),
    disabled: !cliMultiAgentPresetCanLaunchTeam(plan),
    footerHints: formatCliMultiAgentPresetLauncherHints(plan, {
      includeLoginHint: options.includeLoginHint,
    }),
  }));
}
