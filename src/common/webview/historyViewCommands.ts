/**
 * Command constants for the history view.
 */
import { COMMON_COMMANDS } from './commonCommands';

// History view specific commands
export const HISTORY_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  GET_HISTORY_DATA: 'getHistoryData',
  UPDATE_HISTORY: 'updateHistory',
  CLEAR_HISTORY: 'clearHistory',
  HISTORY_CLEARED: 'historyCleared',
  RERUN_AGENT: 'rerunAgent',
  RESTORE_AGENT: 'restoreAgent',
  DELETE_AGENT: 'deleteAgent',
  EXPORT_CHAT_MD: 'exportChatMd',
  EXPORT_CHAT_TEX: 'exportChatTex',
  EXPORT_CHAT_HTML: 'exportChatHtml',
} as const;
