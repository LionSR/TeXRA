import type { HistoryItem } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { getAgentCategoryDecorator } from '@shared/utils/icons';
import { formatShortDateTime } from '@shared/utils/string';

export type HistoryConfigValue =
  string | number | boolean | string[] | null | undefined;

interface HistoryConfigSection {
  readonly label: string;
  readonly icon?: 'tools';
  readonly entries: Array<[string, HistoryConfigValue]>;
}

/** The one presentation model shared by history rendering and search. */
export function getHistoryItemPresentation(item: HistoryItem) {
  const config = item.agentConfig;
  const isToolUse = config.agentCategory === AgentCategory.ToolUse;
  const instruction = config.instruction?.trim() ? config.instruction : null;
  const description = item.description?.trim() || null;
  const sections: HistoryConfigSection[] = [];

  if (config.agentCategory === AgentCategory.Workflow) {
    sections.push(
      { label: 'Context', entries: [['ContextFiles', config.contextFiles]] },
      { label: 'Output Files', entries: [['Files', config.outputFiles]] },
    );
    if (config.toolConfig) {
      sections.push({
        label: 'Config',
        icon: 'tools',
        entries: Object.entries(config.toolConfig),
      });
    }
  } else {
    sections.push({
      label: 'Edited Files',
      entries: [['Files', config.editedFiles]],
    });
  }

  return {
    id: item.id,
    rawTimestamp: item.timestamp,
    timestamp: formatShortDateTime(item.timestamp) ?? 'Unknown',
    decorator: getAgentCategoryDecorator(config.agentCategory),
    isToolUse,
    agent: config.agent ?? 'Unknown',
    model: config.model ?? 'Unknown',
    instruction,
    description,
    title: instruction ?? description ?? '(no instruction)',
    summary:
      instruction && description && description !== instruction
        ? description
        : null,
    inputFiles:
      config.agentCategory === AgentCategory.Workflow
        ? (config.inputFiles ?? [])
        : [],
    mediaFiles:
      config.agentCategory === AgentCategory.Workflow
        ? (config.mediaFiles ?? [])
        : [],
    sections,
  };
}

export function hasHistoryConfigValue(value: unknown): boolean {
  if (value == null) return false;
  return !Array.isArray(value) || value.length > 0;
}
