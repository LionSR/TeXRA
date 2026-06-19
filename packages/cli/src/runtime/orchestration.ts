import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ExecutionId } from '@shared/schemas';

import {
  cliMultiAgentPresetAvailability,
  cliMultiAgentPresetCanLaunchTeam,
  cliMultiAgentPresetShouldIncludeLoginHint,
  cliMultiAgentPresetTeamLaunchBlockReason,
  MULTI_AGENT_NO_TEAM_ROOT_REASON,
  type CliMultiAgentPresetAgentAvailability,
  type CliMultiAgentPresetAvailability,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';
import {
  BUILTIN_DEFAULT_CHAT_AGENT,
  implicitDefaultToolUseAgents,
} from './defaultAgents';
import { formatCliHistoryResumeSummary } from './historyLabels';
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
const MULTI_AGENT_LAUNCHER_INSPECT_HINT =
  'Team setup: run `texra multi-agent inspect <team-id>` for unavailable or degraded teams.';
const MULTI_AGENT_LAUNCHER_LOGIN_HINT =
  'Relay teams may unlock more agents after texra login.';
const MULTI_AGENT_LAUNCHER_NO_TEAM_ROOT_REASON = 'no team root';

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
  const seen = new Set<string>();
  const items: CliOrchestrationItem[] = [];

  for (const entry of history) {
    if (entry.category && entry.category !== AgentCategory.ToolUse) continue;
    if (entry.agent === BUILTIN_DEFAULT_CHAT_AGENT) continue;
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

function formatCliMultiAgentPresetLauncherSummary(
  plan: CliMultiAgentPresetRunPlan,
): string {
  const availability = cliMultiAgentPresetAvailability(plan);
  const status =
    availability.status === 'available' ? 'ready' : availability.status;
  const details = formatPresetAvailabilityForLauncher(
    availability,
    cliMultiAgentPresetTeamLaunchBlockReason(plan),
  );

  return [status, details].filter((part): part is string => !!part).join('; ');
}

function formatCliMultiAgentPresetLauncherHints(
  plan: CliMultiAgentPresetRunPlan,
  options: { readonly includeLoginHint?: boolean },
): readonly string[] {
  const availability = cliMultiAgentPresetAvailability(plan);
  return [
    availability.status !== 'available'
      ? MULTI_AGENT_LAUNCHER_INSPECT_HINT
      : undefined,
    cliMultiAgentPresetShouldIncludeLoginHint(plan, options)
      ? MULTI_AGENT_LAUNCHER_LOGIN_HINT
      : undefined,
  ].filter((hint): hint is string => hint !== undefined);
}

function formatPresetAvailabilityForLauncher(
  availability: CliMultiAgentPresetAvailability,
  blockReason: string | undefined,
): string | undefined {
  const details = blockReason ? [formatLauncherBlockReason(blockReason)] : [];
  const countStyle = availability.status === 'available' ? 'total' : 'ratio';
  const parts = [
    formatPresetAgentCountForLauncher('tool-use', availability.toolUse, {
      countStyle,
    }),
    formatPresetAgentCountForLauncher('workflow', availability.workflow, {
      countStyle,
    }),
  ].filter((part): part is string => part != null);

  if (parts.length > 0) details.push(parts.join('; '));
  return details.length > 0 ? details.join('; ') : undefined;
}

function formatLauncherBlockReason(blockReason: string): string {
  return blockReason === MULTI_AGENT_NO_TEAM_ROOT_REASON
    ? MULTI_AGENT_LAUNCHER_NO_TEAM_ROOT_REASON
    : blockReason;
}

function formatPresetAgentCountForLauncher(
  label: 'workflow' | 'tool-use',
  availability: CliMultiAgentPresetAgentAvailability,
  options: { readonly countStyle: 'total' | 'ratio' },
): string | undefined {
  if (availability.total === 0) return undefined;
  const count =
    options.countStyle === 'total'
      ? String(availability.total)
      : `${availability.available}/${availability.total}`;
  return `${count} ${label}`;
}
