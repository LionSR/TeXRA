// Local imports - history view
// Constants for History View

// Import standardized commands
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';

// Export command map for convenience
export const COMMANDS = HISTORY_VIEW_COMMANDS;

// DOM element IDs
export const ELEMENT_IDS = {
  SEARCH_INPUT: 'searchInput',
  PREV_MATCH: 'prevMatch',
  NEXT_MATCH: 'nextMatch',
  MATCH_COUNT: 'matchCount',
  CLEAR_BUTTON_CONTAINER: 'clearButtonContainer',
  HISTORY_CONTAINER: 'historyContainer',
  CLEAR_HISTORY_BTN: 'clearHistoryBtn',
};

// CSS class names used across modules
export const CLASS_NAMES = {
  HISTORY_COLLAPSIBLE: 'history-collapsible',
  CURRENT_MATCH: 'current-match',
};

// Text labels and messages
export const LABELS = {
  EMPTY_STATE: 'No history items found',
  CLEAR_ALL_HISTORY: 'Clear All History',
  MORE_DETAILS: 'More details',
};
