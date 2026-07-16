/**
 * History list construction shared between desktop and extension settings
 * controllers.
 *
 * Both hosts iterate `listExecutions()` and turn each entry into the same
 * `HistoryItem` shape for the settings UI. Action handlers (delete, rerun,
 * export) remain host-specific because they touch host-only UI surfaces.
 */
import {
  getExecutionStore,
  invalidateListingCache,
  isUserVisibleExecution,
  listExecutions,
} from '@agent/storage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  HistoryItem,
  UpdateHistoryMessage,
} from '@shared/schemas/historyViewMessages';

export async function buildHistoryMessage(): Promise<UpdateHistoryMessage> {
  // The in-process listing cache only sees this host's writes, but the shared
  // `~/.texra` root is also written by the other hosts (CLI/desktop/extension,
  // #8622) — rescan on every explicit history refresh so their runs appear.
  invalidateListingCache();
  const entries = await listExecutions();
  const visibleEntries = entries.filter(isUserVisibleExecution);
  const historyItems = await Promise.all(
    visibleEntries.map(async (entry): Promise<HistoryItem> => {
      const cfg = entry.agentConfig;
      const base = {
        agent: cfg.agent,
        model: cfg.model,
        instruction: cfg.instruction,
      };
      const editedFiles =
        cfg.agentCategory === 'toolUse'
          ? await getExecutionStore(entry.id).readWorkspaceFiles()
          : [];
      return {
        id: entry.id,
        timestamp: entry.timestamp,
        agentConfig:
          cfg.agentCategory === 'toolUse'
            ? {
                agentCategory: 'toolUse' as const,
                ...base,
                editedFiles,
              }
            : {
                agentCategory: 'workflow' as const,
                ...base,
                inputFiles: cfg.inputFiles,
                mediaFiles: cfg.mediaFiles,
                contextFiles: cfg.contextFiles,
                outputFiles: cfg.outputFiles,
                toolConfig: cfg.toolConfig,
              },
        description: entry.description,
      };
    }),
  );
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
    historyItems,
  };
}
