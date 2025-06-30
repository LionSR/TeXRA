// Status constants
export const STATUS = {
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  READY: 'ready',
};

// Default sizes for split view
export const SPLIT_SIZES = {
  CONTENT: 80,
  TABS: 20,
};

// Constants for layout configuration
export const MAX_HEIGHT = 400;

// Import standardized commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands.ts';

// Use standardized commands
export const COMMANDS = PROGRESS_VIEW_COMMANDS;

export const TOOLBAR_BUTTONS = [
  {
    id: 'stopStreamBtn',
    icon: 'debug-stop',
    command: COMMANDS.STOP_STREAM,
    title:
      'Request task interruption (current API call will be aborted if supported)',
    className: 'vscode-button stop-button',
    disabled: true,
  },
  {
    id: 'runAgainBtn',
    icon: 'debug-rerun',
    command: COMMANDS.RUN_AGAIN,
    title: 'Run this task again',
    className: 'vscode-button run-button',
    disabled: true,
  },
  {
    id: 'restoreStateBtn',
    icon: 'reply',
    command: COMMANDS.RESTORE_STATE,
    title: 'Restore this configuration to the main view',
    className: 'vscode-button restore-button',
    disabled: true,
  },
  {
    id: 'diffStreamBtn',
    icon: 'diff-multiple',
    command: COMMANDS.DIFF_STREAM,
    title: 'Run latexdiff on existing tex files',
    className: 'vscode-button diff-button',
    disabled: true,
  },
  {
    id: 'packStreamBtn',
    icon: 'archive',
    command: COMMANDS.PACK_STREAM,
    title: 'Pack the output for this agent into the History folder',
    className: 'vscode-button pack-button',
    disabled: true,
  },
  {
    id: 'cleanStreamBtn',
    icon: 'trash',
    command: COMMANDS.CLEAN_STREAM,
    title: 'Clean the output for this agent',
    className: 'vscode-button clean-button',
    disabled: true,
  },
  {
    id: 'eraseStreamBtn',
    icon: 'clear-all',
    command: COMMANDS.ERASE_STREAM,
    title: 'Erase the stream output for this agent',
    className: 'vscode-button clear-button',
    disabled: false,
  },
];
