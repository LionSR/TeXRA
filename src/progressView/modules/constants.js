// Status constants
export const STATUS = {
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  READY: 'ready',
  WAITING: 'waiting',
  RESUMING: 'resuming',
};

/**
 * @typedef {Object} ToolbarButtonDefinition
 * @property {string} id - DOM element identifier for the button.
 * @property {string} icon - Codicon identifier rendered inside the button.
 * @property {string} command - Webview command dispatched when clicked.
 * @property {string} title - Accessible label describing the action.
 * @property {string} className - Space-delimited class names applied to the button.
 * @property {boolean} disabled - Whether the button is initially disabled.
 * @property {Record<string, string>} [dataset] - Additional data attributes for the button element.
 */

// DOM element IDs used across the progress view
export const ELEMENT_IDS = {
  LOG_CONTENT: 'logContent',
  LOG_PLACEHOLDER: 'logPlaceholder',
  GENERATED_FILES: 'generatedFiles',
  STREAM_TABS: 'streamTabs',
  ACTIVE_STREAM_NAME: 'activeStreamName',
  STATUS_INDICATOR: 'statusIndicator',
  RUN_SUMMARY: 'runSummary',
  INSTRUCTION_CONTAINER: 'instructionContainer',
  INSTRUCTION_TEXT: 'instructionText',
  INSTRUCTION_TOGGLE_BTN: 'instructionToggleBtn',
  INSTRUCTION_COPY_BTN: 'instructionCopyBtn',
  TOOLBAR_CONTAINER: 'toolbarContainer',
  FILE_ITEM_TEMPLATE: 'fileItemTemplate',
  DELETE_ALL_BTN: 'deleteAllBtn',
  SORT_TIME_BTN: 'sortTimeBtn',
  SORT_FILE_BTN: 'sortFileBtn',
  SORT_AGENT_BTN: 'sortAgentBtn',
  STOP_STREAM_BTN: 'stopStreamBtn',
  RUN_AGAIN_BTN: 'runAgainBtn',
  RESTORE_STATE_BTN: 'restoreStateBtn',
  DIFF_STREAM_BTN: 'diffStreamBtn',
  PACK_STREAM_BTN: 'packStreamBtn',
  CLEAN_STREAM_BTN: 'cleanStreamBtn',
  OPEN_TASK_STORAGE_BTN: 'openTaskStorageBtn',
  ERASE_STREAM_BTN: 'eraseStreamBtn',
  FOLLOW_UP_CONTAINER: 'followUpContainer',
  FOLLOW_UP_INPUT: 'followUpInput',
  RECORD_FOLLOW_UP_BTN: 'recordFollowUpBtn',
  POLISH_FOLLOW_UP_BTN: 'polishFollowUpBtn',
  CLEAR_FOLLOW_UP_BTN: 'clearFollowUpBtn',
  SEND_FOLLOW_UP_BTN: 'sendFollowUpBtn',
  AGENT_FILTER_CONTAINER: 'agentFilterButtons',
  FILTER_ALL_BTN: 'filterAllBtn',
  FILTER_WORKFLOW_BTN: 'filterWorkflowBtn',
  FILTER_TOOL_BTN: 'filterToolBtn',
};

// Default sizes for split view
export const SPLIT_SIZES = {
  CONTENT: 80,
  TABS: 20,
};

// Constants for layout configuration
export const MAX_HEIGHT = 400;

// Import standardized commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands.js';

// Use standardized commands directly (OPEN_LABEL is already included)
export const COMMANDS = PROGRESS_VIEW_COMMANDS;

// Shared definition for the storage toolbar button across layouts
const OPEN_TASK_STORAGE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  icon: 'folder-opened',
  command: COMMANDS.OPEN_TASK_STORAGE,
  title: 'Open the workspace storage folder for this run',
  className: 'storage-button toolbar-button--hidden',
  disabled: true,
});

/** @type {ToolbarButtonDefinition[]} */
const WORKFLOW_TOOLBAR = [
  {
    id: ELEMENT_IDS.STOP_STREAM_BTN,
    icon: 'debug-stop',
    command: COMMANDS.STOP_STREAM,
    title:
      'Request task interruption (current API call will be aborted if supported)',
    className: 'stop-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.RUN_AGAIN_BTN,
    icon: 'debug-rerun',
    command: COMMANDS.RUN_AGAIN,
    title: 'Run this task again',
    className: 'run-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.RESTORE_STATE_BTN,
    icon: 'reply',
    command: COMMANDS.RESTORE_STATE,
    title: 'Restore this configuration to the main view',
    className: 'restore-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.DIFF_STREAM_BTN,
    icon: 'diff-multiple',
    command: COMMANDS.DIFF_STREAM,
    title: 'Run latexdiff on existing tex files',
    className: 'diff-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.PACK_STREAM_BTN,
    icon: 'archive',
    command: COMMANDS.PACK_STREAM,
    title: 'Pack the output for this agent into the History folder',
    className: 'pack-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.CLEAN_STREAM_BTN,
    icon: 'trash',
    command: COMMANDS.CLEAN_STREAM,
    title: 'Clean the output for this agent',
    className: 'clean-button',
    disabled: true,
  },
  { ...OPEN_TASK_STORAGE_BUTTON },
  {
    id: ELEMENT_IDS.ERASE_STREAM_BTN,
    icon: 'clear-all',
    command: COMMANDS.ERASE_STREAM,
    title: 'Erase the stream output for this agent',
    className: 'clear-button',
    disabled: false,
  },
];

/** @type {ToolbarButtonDefinition[]} */
const TOOL_USE_TOOLBAR = [
  {
    id: ELEMENT_IDS.STOP_STREAM_BTN,
    icon: 'debug-stop',
    command: COMMANDS.STOP_STREAM,
    title:
      'Request task interruption (current API call will be aborted if supported)',
    className: 'stop-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.RESTORE_STATE_BTN,
    icon: 'reply',
    command: COMMANDS.RESTORE_STATE,
    title: 'Restore this configuration to the main view',
    className: 'restore-button',
    disabled: true,
  },
  { ...OPEN_TASK_STORAGE_BUTTON },
  {
    id: ELEMENT_IDS.ERASE_STREAM_BTN,
    icon: 'clear-all',
    command: COMMANDS.ERASE_STREAM,
    title: 'Erase the stream output for this agent',
    className: 'clear-button',
    disabled: false,
  },
];

/** @type {Record<'workflow' | 'toolUse', ToolbarButtonDefinition[]>} */
export const TOOLBAR_BUTTONS = {
  workflow: WORKFLOW_TOOLBAR,
  toolUse: TOOL_USE_TOOLBAR,
};

export const ALL_TOOLBAR_BUTTON_IDS = Array.from(
  new Set([
    ...WORKFLOW_TOOLBAR.map((btn) => btn.id),
    ...TOOL_USE_TOOLBAR.map((btn) => btn.id),
  ]),
);

export const SORT_BUTTONS = [
  {
    id: ELEMENT_IDS.SORT_TIME_BTN,
    icon: 'clock',
    sort: 'time',
    title: 'Sort by time',
  },
  {
    id: ELEMENT_IDS.SORT_FILE_BTN,
    icon: 'file',
    sort: 'inputFile',
    title: 'Sort by file',
  },
  {
    id: ELEMENT_IDS.SORT_AGENT_BTN,
    icon: 'account',
    sort: 'agent',
    title: 'Sort by agent',
  },
];

export const FILTER_BUTTONS = [
  {
    id: ELEMENT_IDS.FILTER_ALL_BTN,
    label: 'All',
    filter: 'all',
  },
  {
    id: ELEMENT_IDS.FILTER_WORKFLOW_BTN,
    label: 'Workflow',
    filter: 'workflow',
  },
  {
    id: ELEMENT_IDS.FILTER_TOOL_BTN,
    label: 'Tool Use',
    filter: 'toolUse',
  },
];
