/**
 * History list construction shared between desktop and extension settings
 * controllers.
 *
 * Both hosts iterate `listExecutions()` and turn each entry into the same
 * `HistoryItem` shape for the settings UI. Action handlers (delete, rerun,
 * export) remain host-specific because they touch host-only UI surfaces.
 */
import {
  deriveResumability,
  getExecutionStore,
  isUserVisibleExecution,
  listExecutions,
} from '@agent/storage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  resolveHistoryRunStatus,
  type HistoryItem,
  type UpdateHistoryMessage,
} from '@shared/schemas';

export async function buildHistoryMessage(): Promise<UpdateHistoryMessage> {
  const entries = await listExecutions();
  const visibleEntries = entries.filter(isUserVisibleExecution);
  const historyItems = await Promise.all(
    visibleEntries.map(async (entry): Promise<HistoryItem> => {
      const cfg = entry.record;
      const base = {
        agent: cfg.agent,
        model: cfg.model,
        instruction: cfg.instruction,
      };
      const [editedFiles, resumability] = await Promise.all([
        cfg.agentCategory === 'toolUse'
          ? getExecutionStore(entry.id).readWorkspaceFiles()
          : [],
        deriveResumability(entry.id),
      ]);
      return {
        id: entry.id,
        timestamp: entry.timestamp,
        status: resolveHistoryRunStatus(resumability),
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
