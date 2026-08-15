import type { HistoryItem, HistoryRunStatus } from '@shared/schemas';
import { AgentCategory, HISTORY_RUN_STATUS } from '@shared/schemas';
import { getAgentCategoryDecorator } from '@shared/utils/icons';
import { formatShortDateTime } from '@utils/text/stringUtils';

export type HistoryConfigValue =
  string | number | boolean | string[] | null | undefined;

interface HistoryConfigSection {
  readonly label: string;
  readonly icon?: 'screwdriver-wrench';
  readonly entries: Array<[string, HistoryConfigValue]>;
}

interface HistoryStatusBadge {
  readonly label: string;
  readonly variant: 'brand' | 'neutral' | 'success' | 'warning' | 'danger';
}

/**
 * `unknown` gets its own badge instead of being softened into "completed":
 * a run whose terminal write never landed did not finish, and a success
 * badge would hide that crash from the list.
 */
const HISTORY_STATUS_BADGES: Record<HistoryRunStatus, HistoryStatusBadge> = {
  [HISTORY_RUN_STATUS.RESUMABLE]: { label: 'Resumable', variant: 'warning' },
  [HISTORY_RUN_STATUS.COMPLETED]: { label: 'Completed', variant: 'success' },
  [HISTORY_RUN_STATUS.CANCELLED]: { label: 'Cancelled', variant: 'neutral' },
  [HISTORY_RUN_STATUS.FAILED]: { label: 'Failed', variant: 'danger' },
  [HISTORY_RUN_STATUS.UNKNOWN]: { label: 'Unknown', variant: 'neutral' },
};

/** The one presentation model shared by history rendering and search. */
export function getHistoryItemPresentation(item: HistoryItem) {
  const config = item.agentConfig;
  const isToolUse = config.agentCategory === AgentCategory.ToolUse;
  const instruction = config.instruction?.trim() ? config.instruction : null;
  const description = item.description?.trim() || null;
  const sections: HistoryConfigSection[] = [];

  if (isToolUse) {
    sections.push({
      label: 'Edited files',
      entries: [['Files', config.editedFiles]],
    });
  } else {
    sections.push(
      { label: 'Context', entries: [['ContextFiles', config.contextFiles]] },
      { label: 'Output files', entries: [['Files', config.outputFiles]] },
    );
    if (config.toolConfig) {
      sections.push({
        label: 'Config',
        icon: 'screwdriver-wrench',
        entries: Object.entries(config.toolConfig),
      });
    }
  }

  return {
    id: item.id,
    rawTimestamp: item.timestamp,
    timestamp: formatShortDateTime(item.timestamp) ?? 'Unknown',
    decorator: getAgentCategoryDecorator(config.agentCategory),
    status: HISTORY_STATUS_BADGES[item.status],
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
    inputFiles: isToolUse ? [] : (config.inputFiles ?? []),
    mediaFiles: isToolUse ? [] : (config.mediaFiles ?? []),
    sections,
  };
}

export function hasHistoryConfigValue(value: unknown): boolean {
  if (value == null) return false;
  return !Array.isArray(value) || value.length > 0;
}
