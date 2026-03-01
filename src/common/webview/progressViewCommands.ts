/**
 * Command constants for the progress view.
 */
import { COMMON_COMMANDS } from './commonCommands';

// Progress view specific commands
export const PROGRESS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // Stream management
  SWITCH_STREAM: 'switchStream',
  DELETE_STREAM: 'deleteStream',
  CLEAN_STREAM: 'cleanStream',
  STOP_STREAM: 'stopStream',
  UPDATE_STREAMS: 'updateStreams',
  DELETE_ALL: 'deleteAll',

  // Logging
  LOG_DELTA: 'logDelta',

  // Instruction panel
  UPDATE_INSTRUCTION: 'updateInstruction',

  // Todo List
  UPDATE_TODOS: 'updateTodos',

  // Queued follow-ups
  UPDATE_QUEUED_FOLLOW_UPS: 'updateQueuedFollowUps',

  // Batched metadata sync on tab switch (non-log content only)
  SYNC_STREAM_CONTENT: 'syncStreamContent',

  // Status and files
  UPDATE_STREAM_STATUS: 'updateStreamStatus', // Update single stream's status in tabs
  SET_ACTIVE_STREAM: 'setActiveStream',
  UPDATE_CONVERSATION_PROGRESS: 'updateConversationProgress',
  UPDATE_STREAM_BADGES: 'updateStreamBadges',
  UPDATE_PARENT_STREAM: 'updateParentStream',
  UPDATE_FILES: 'updateFiles',
  UPDATE_MISSING_OUTPUTS: 'updateMissingOutputs',
  UPDATE_PERMISSION: 'updatePermission',
  UPDATE_BYPASS: 'updateBypass',

  // Usage
  UPDATE_RUN_USAGE: 'updateRunUsage', // Update single run's usage (incremental)

  // Actions
  RESUME: 'resume',
  RUN_NEW: 'runNew',
  COMPACT_RESPONSE: 'compactResponse',
  RETRY_STREAM_REQUEST: 'retryStreamRequest',
  CANCEL_RETRY_REQUEST: 'cancelRetryRequest',
  DIFF_STREAM: 'diffStream',
  PACK_STREAM: 'packStream',
  SORT_STREAMS: 'sortStreams',
  FILTER_STREAMS: 'filterStreams',
  RESTORE_STATE: 'restoreState',
  SEND_FOLLOW_UP: 'sendFollowUp',
  POLISH_FOLLOW_UP: 'polishFollowUp',
  UPDATE_FOLLOW_UP_TEXT: 'updateFollowUpText',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  UPDATE_RECORDING: 'updateRecording',
  SHOW_INFORMATION_MESSAGE: 'showInformationMessage',
  OPEN_TASK_STORAGE: 'openTaskStorage',
  TOOL_EDIT_APPROVAL_ACTION: 'toolEditApprovalAction',
  TOGGLE_TOOL_EDIT_APPROVAL_BYPASS: 'toggleToolEditApprovalBypass',
  AGENT_PROPOSAL_ACTION: 'agentProposalAction',
  BASH_APPROVAL_ACTION: 'bashApprovalAction',
  RESTORE_PROPOSAL_CONFIG: 'restoreProposalConfig',
  TOGGLE_SUPER_YOLO_BYPASS: 'toggleSuperYoloBypass',

  // Memory
  OPEN_MEMORY_VIEW: 'openMemoryView',

  // File operations
  OPEN_FILE: 'openFile',
  OPEN_FILE_COMPILE: 'openFileCompile',
  COMPARE_ORIGINAL: 'compareOriginal',
  COMPARE_PREVIOUS: 'comparePrevious',
  ACCEPT_FILE: 'acceptFile',
  MERGE_FILE: 'mergeFile',
  LATEXDIFF_FILE: 'latexdiffFile',
  OPEN_LABEL: 'openLabel',

  // Profile
  OPEN_PROFILE: 'openProfile',

  // Followup task (workflow continuation)
  SETUP_FOLLOWUP: 'setupFollowup',
  RUN_FOLLOWUP: 'runFollowup',
  GET_FOLLOWUP_OPTIONS: 'getFollowupOptions',
  SET_FOLLOWUP_OPTIONS: 'setFollowupOptions',
  POP_OUT: 'popOut',
  POP_BACK: 'popBack',
  SET_PLACEMENT: 'setPlacement',
} as const;
