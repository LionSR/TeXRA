/** Typed agent-options builder (Lit-native) for dropdown rendering. */

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentOptionData } from '@shared/schemas';
import { agentKey as createKey } from '@shared/schemas/agent';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName } from '@utils/core';
import type { AgentEntry } from './agentEntry';

const DECORATED_AGENT_NAME_SEPARATOR = /\s+(?:—|---|--)\s+/;
const TITLE_CASE_AGENT_NAME = /^[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*$/;

export interface AgentOptionsDataPayload {
  workflow: AgentOptionData[];
  toolUse: AgentOptionData[];
}

function canonicalAgentOptionLabel(name: string): string {
  const trimmed = name.trim();
  const [head, suffix] = trimmed.split(DECORATED_AGENT_NAME_SEPARATOR, 2);
  if (suffix === undefined) return trimmed;

  const base = head?.trim() || trimmed;
  if (!TITLE_CASE_AGENT_NAME.test(base)) return base;

  const words = base.split(/\s+/);
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word,
    )
    .join('');
}

function optionLabelForEntry(entry: AgentEntry): string {
  return entry.source === 'remote'
    ? canonicalAgentOptionLabel(entry.name)
    : entry.name;
}

function uniqueAgentOptionLabels(labels: readonly string[]): string[] {
  const totals = new Map<string, number>();
  for (const label of labels) {
    totals.set(label, (totals.get(label) ?? 0) + 1);
  }

  const reserved = new Set(
    labels.filter((label) => (totals.get(label) ?? 0) === 1),
  );
  const seen = new Map<string, number>();
  return labels.map((label) => {
    if ((totals.get(label) ?? 0) < 2) return label;
    // Do not restore decorated remote names here: duplicate canonical labels
    // get numbered so a bare id cannot silently bind to one of them.
    let next = (seen.get(label) ?? 0) + 1;
    let unique = `${label}${next}`;
    while (reserved.has(unique)) {
      next += 1;
      unique = `${label}${next}`;
    }
    seen.set(label, next);
    reserved.add(unique);
    return unique;
  });
}

function entryToOptionData(entry: AgentEntry, label: string): AgentOptionData {
  const key = createKey(entry.source, entry.name);
  return {
    value: key,
    label,
    isToolUse: entry.category === AgentCategory.ToolUse,
    isOrchestrator: hasDelegationTool(entry.tools),
    isRemote: entry.source === 'remote',
    isCustom: entry.source === 'custom',
    description: entry.description,
  };
}

export function entriesToOptionData(
  entries: readonly AgentEntry[],
): AgentOptionData[] {
  const labels = uniqueAgentOptionLabels(entries.map(optionLabelForEntry));
  return entries.map((entry, index) =>
    entryToOptionData(entry, labels[index] ?? optionLabelForEntry(entry)),
  );
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
