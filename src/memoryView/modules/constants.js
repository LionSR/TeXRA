// Local imports - memory view
// Constants for Memory View

// Import standardized commands
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands.js';

// Export command map for convenience
export const COMMANDS = MEMORY_VIEW_COMMANDS;

// DOM element IDs
export const ELEMENT_IDS = {
  MEMORY_LIST: 'memoryList',
  REFRESH_MEMORY_BTN: 'refreshMemoryBtn',
  OPEN_MEMORY_FOLDER_BTN: 'openMemoryFolderBtn',
};

// Text labels and messages
export const LABELS = {
  EMPTY_STATE:
    'No saved memories yet. The assistant will create notes here when it needs to remember something.',
  PREVIEW_HEADING: 'Contents',
  EMPTY_PREVIEW: 'This note is empty.',
};
