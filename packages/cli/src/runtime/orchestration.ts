import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@shared/schemas';

import type { CliHistoryEntry } from './history';
import type { CliMultiAgentPreset } from './multiAgentPresets';

export type CliOrchestrationAction =
  | { readonly kind: 'chat'; readonly agent?: string }
  | { readonly kind: 'preset'; readonly preset: string }
  | { readonly kind: 'resume'; readonly id: ExecutionId }
  | { readonly kind: 'help' }
  | { readonly kind: 'exit' };

export interface CliOrchestrationItem {
  readonly value: CliOrchestrationAction;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
}

export interface BuildCliOrchestrationItemsInput {
  readonly presets: readonly CliMultiAgentPreset[];
  readonly history: readonly CliHistoryEntry[];
  readonly toolUseAgents: readonly AgentEntry[];
}

const MAX_RECENT_RESUME_ITEMS = 3;
const MAX_RECENT_AGENT_ITEMS = 3;
const MAX_PRESET_ITEMS = 6;

export function buildCliOrchestrationItems(
  input: BuildCliOrchestrationItemsInput,
): CliOrchestrationItem[] {
  const items: CliOrchestrationItem[] = [
    {
      value: { kind: 'chat' },
      label: 'New chat',
      description: 'Start the default tool-use chat',
    },
  ];

  items.push(...recentResumeItems(input.history));
  items.push(...recentAgentItems(input.history, input.toolUseAgents));
  items.push(...presetItems(input.presets));
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
  return history.slice(0, MAX_RECENT_RESUME_ITEMS).map((entry) => ({
    value: { kind: 'resume', id: entry.id },
    label: `Resume ${entry.id}`,
    description: `${entry.agent}; ${entry.status}; ${entry.inputBasename}`,
  }));
}

function recentAgentItems(
  history: readonly CliHistoryEntry[],
  toolUseAgents: readonly AgentEntry[],
): CliOrchestrationItem[] {
  const toolUseNames = new Set(toolUseAgents.map((agent) => agent.name));
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
  presets: readonly CliMultiAgentPreset[],
): CliOrchestrationItem[] {
  return presets.slice(0, MAX_PRESET_ITEMS).map((preset) => ({
    value: { kind: 'preset', preset: preset.id },
    label: `Team ${preset.name}`,
    description: `${preset.source}; workflow:${preset.workflowAgents.length}; tool-use:${preset.toolUseAgents.length}`,
  }));
}
