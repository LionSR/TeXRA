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

// Commands for stream management
export const COMMANDS = {
  SWITCH_STREAM: 'switchStream',
  DELETE_STREAM: 'deleteStream',
  STOP_STREAM: 'stopStream',
  RUN_AGAIN: 'runAgain',
  RESTORE_STATE: 'restoreState',
  DIFF_STREAM: 'diffStream',
  PACK_STREAM: 'packStream',
  CLEAN_STREAM: 'cleanStream',
  ERASE_STREAM: 'eraseStream',
  DELETE_ALL: 'deleteAll',
  UPDATE_STREAMS: 'updateStreams',
  UPDATE_LOGS: 'updateLogs',
  CLEAR_LOGS: 'clearLogs',
  APPEND_LOG: 'appendLog',
  ADD_LOG_GROUP: 'addLogGroup',
  UPDATE_LOG_GROUP: 'updateLogGroup',
  UPDATE_STATUS: 'updateStatus',
  UPDATE_FILES: 'updateFiles',
  UPDATE_USAGE: 'updateUsage',
  UPDATE_GROUP_USAGE: 'updateGroupUsage',
  OPEN_FILE: 'openFile',
  COMPARE_ORIGINAL: 'compareOriginal',
  COMPARE_PREVIOUS: 'comparePrevious',
  ACCEPT_FILE: 'acceptFile',
  MERGE_FILE: 'mergeFile',
  LATEXDIFF_FILE: 'latexdiffFile',
  // Real-time streaming commands
  STREAM_TEXT: 'streamText',
  STREAM_THINKING: 'streamThinking',
  STREAM_START: 'streamStart',
  STREAM_END: 'streamEnd',
};

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
