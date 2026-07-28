/** Typed agent-options builder (Lit-native) for dropdown rendering. */

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentOptionData } from '@shared/schemas';
import { agentKeyOf } from '@shared/schemas/agent';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName } from '@utils/core';
import type { AgentEntry } from './agentEntry';

export interface AgentOptionsDataPayload {
  workflow: AgentOptionData[];
  toolUse: AgentOptionData[];
}

function entryToOptionData(entry: AgentEntry): AgentOptionData {
  const key = agentKeyOf(entry);
  return {
    value: key,
    label: entry.name,
    isToolUse: entry.category === AgentCategory.ToolUse,
    isOrchestrator: hasDelegationTool(entry.tools),
    isRemote: entry.source === 'remote',
    isCustom: entry.source === 'custom',
    isInline: entry.source === 'inline',
  };
}

export function entriesToOptionData(
  entries: readonly AgentEntry[],
): AgentOptionData[] {
  return entries.map(entryToOptionData);
}

/** Sort entries: preferred agents first (in priority order), then alphabetically. */
export function sortAgentEntries(
  entries: AgentEntry[],
  preferredNames: readonly string[],
): AgentEntry[] {
  const preferredSet = new Map(
    preferredNames
      .map((name, i) => [entries.find((e) => e.name === name), i] as const)
      .filter(([entry]) => entry != null),
  );
  return entries.toSorted((a, b) => {
    const aIdx = preferredSet.get(a);
    const bIdx = preferredSet.get(b);
    if (aIdx != null && bIdx != null) return aIdx - bIdx;
    if (aIdx != null) return -1;
    if (bIdx != null) return 1;
    return byName(a, b);
  });
}
