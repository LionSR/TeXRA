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
  OPEN_FILE: 'openFile',
  COMPARE_ORIGINAL: 'compareOriginal',
  COMPARE_PREVIOUS: 'comparePrevious',
  ACCEPT_FILE: 'acceptFile',
  MERGE_FILE: 'mergeFile',
  LATEXDIFF_FILE: 'latexdiffFile',
};
