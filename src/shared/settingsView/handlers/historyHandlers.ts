/**
 * History list construction shared between desktop and extension hosts.
 *
 * Both hosts iterate `listExecutions()` and turn each entry into the same
 * `HistoryItem` shape for the settings UI. Action handlers (delete, rerun,
 * export) remain host-specific because they touch host-only UI surfaces.
 */
import { listExecutions } from '@agent/storage';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import type {
  HistoryItem,
  UpdateHistoryMessage,
} from '@shared/schemas/historyViewMessages';

export async function buildHistoryMessage(): Promise<UpdateHistoryMessage> {
  const entries = await listExecutions();
  const historyItems = entries
    .filter(
      (entry) => entry.agentConfig !== null && entry.category !== 'process',
    )
    .map((entry): HistoryItem => {
      const cfg = entry.agentConfig!;
      const base = {
        agent: cfg.agent,
        model: cfg.model,
        instruction: cfg.instruction,
      };
      return {
        id: entry.id,
        timestamp: entry.timestamp,
        agentConfig:
          cfg.agentCategory === 'toolUse'
            ? { agentCategory: 'toolUse' as const, ...base }
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
    });
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
    historyItems,
  };
}
