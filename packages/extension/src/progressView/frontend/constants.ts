import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategoryFilter } from '@shared/schemas';

/**
 * DOM element IDs used across the progress view.
 */
export const ELEMENT_IDS = {
  LOG_CONTENT: 'logContent',
  GENERATED_FILES: 'generatedFiles',
  GENERATED_FILES_COLLAPSIBLE: 'generatedFilesCollapsible',
  STREAM_TABS: 'streamTabs',
  ACTIVE_STREAM_NAME: 'activeStreamName',
  STATUS_INDICATOR: 'statusIndicator',
  GOAL_CHIP: 'goalChip',
  PROGRESS_BADGE: 'progressBadge',
  RUN_SUMMARY: 'runSummary',
  CONTEXT_STATE: 'contextState',
  TODO_LIST_CONTAINER: 'todoListContainer',
  TODO_LIST: 'todoList',
  PLAN_VIEW_CONTAINER: 'planViewContainer',
  PLAN_VIEW: 'planView',
  TOOLBAR_CONTAINER: 'toolbarContainer',
  DELETE_ALL_BTN: 'deleteAllBtn',
  STOP_STREAM_BTN: 'stopStreamBtn',
  RUN_NEW_BTN: 'runNewBtn',
  RESUME_BTN: 'resumeBtn',
  RESTORE_STATE_BTN: 'restoreStateBtn',
  DIFF_STREAM_BTN: 'diffStreamBtn',
  CLEAN_STREAM_BTN: 'cleanStreamBtn',
  PACK_STREAM_BTN: 'packStreamBtn',
  OPEN_TASK_STORAGE_BTN: 'openTaskStorageBtn',
  FOLLOW_UP_CONTAINER: 'followUpContainer',
  FOLLOW_UP_INPUT: 'followUpInput',
  QUEUED_FOLLOW_UPS_COLLAPSIBLE: 'queuedFollowUpsCollapsible',
  QUEUED_FOLLOW_UPS_LIST: 'queuedFollowUpsList',
  RECORD_FOLLOW_UP_BTN: 'recordFollowUpBtn',
  COMPACT_RESPONSE_BTN: 'compactResponseBtn',
  YOLO_TOGGLE_BTN: 'yoloToggleBtn',
  SUPER_YOLO_TOGGLE_BTN: 'superYoloToggleBtn',
  POLISH_FOLLOW_UP_BTN: 'polishFollowUpBtn',
  CLEAR_FOLLOW_UP_BTN: 'clearFollowUpBtn',
  SEND_FOLLOW_UP_BTN: 'sendFollowUpBtn',
  AGENT_FILTER_CONTAINER: 'agentFilterButtons',
  FILTER_ALL_BTN: 'filterAllBtn',
  FILTER_WORKFLOW_BTN: 'filterWorkflowBtn',
  FILTER_TOOL_BTN: 'filterToolBtn',
};

export const GROUP_DOM_IDS = Object.freeze({
  DETAILS_PREFIX: 'group-',
  HEADER_PREFIX: 'group-header-',
  CONTENT_PREFIX: 'group-content-',
});

const STOP_STREAM_BUTTON = Object.freeze({
  id: ELEMENT_IDS.STOP_STREAM_BTN,
  icon: 'debug-stop',
  command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
  title:
    'Request task interruption (current API call will be aborted if supported)',
  className: 'stop-button',
  disabled: true,
});

const RESTORE_STATE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.RESTORE_STATE_BTN,
  icon: 'reply',
  command: PROGRESS_VIEW_COMMANDS.RESTORE_STATE,
  title: 'Setup this configuration in the main view',
  className: 'restore-button',
  disabled: true,
});

const OPEN_TASK_STORAGE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  icon: 'folder-opened',
  command: PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE,
  title: 'Open in task storage: reveal this run folder and generated files',
  className: 'storage-button',
  disabled: true,
});

const WORKFLOW_TOOLBAR = [
  STOP_STREAM_BUTTON,
  {
    id: ELEMENT_IDS.RUN_NEW_BTN,
    icon: 'debug-start',
    command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
    title: 'Start a fresh run (discards previous outputs)',
    className: 'run-button run-new-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.RESUME_BTN,
    icon: 'debug-continue',
    command: PROGRESS_VIEW_COMMANDS.RESUME,
    title: 'Resume from saved outputs (continues where it left off)',
    className: 'run-button resume-button',
    disabled: true,
  },
  RESTORE_STATE_BUTTON,
  OPEN_TASK_STORAGE_BUTTON,
  {
    id: ELEMENT_IDS.DIFF_STREAM_BTN,
    icon: 'diff-multiple',
    command: PROGRESS_VIEW_COMMANDS.DIFF_STREAM,
    title: 'Run latexdiff on existing tex files',
    className: 'diff-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.CLEAN_STREAM_BTN,
    icon: 'trash',
    command: PROGRESS_VIEW_COMMANDS.CLEAN_STREAM,
    title: 'Clean: Delete generated output files from this run',
    className: 'clean-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.PACK_STREAM_BTN,
    icon: 'archive',
    command: PROGRESS_VIEW_COMMANDS.PACK_STREAM,
    title: 'Pack: Archive output files into a timestamped History folder',
    className: 'pack-button',
    disabled: true,
  },
];

const YOLO_TOGGLE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.YOLO_TOGGLE_BTN,
  icon: 'shield',
  command: PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
  title: 'Skip edit approvals (auto-accept file changes)',
  titleActive: 'Edit auto-accept active — click to resume approval prompts',
  className: 'yolo-toggle-button',
  isToggle: true,
});

const DELEGATED_WORK_APPROVAL_TOGGLE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN,
  icon: 'rocket',
  command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
  title: 'Auto-approve tasks, file edits, and commands in this stream',
  titleActive:
    'Task, edit, and command auto-approval active — click to resume prompts',
  className: 'super-yolo-toggle-button',
  isToggle: true,
});

const COMPACT_RESPONSE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.COMPACT_RESPONSE_BTN,
  icon: 'compress',
  command: PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE,
  title:
    'Compact conversation context (summarize history to reduce token usage)',
  className: 'compact-button',
  disabled: true,
});

const TOOL_USE_TOOLBAR = [
  STOP_STREAM_BUTTON,
  YOLO_TOGGLE_BUTTON,
  DELEGATED_WORK_APPROVAL_TOGGLE_BUTTON,
  COMPACT_RESPONSE_BUTTON,
  RESTORE_STATE_BUTTON,
  OPEN_TASK_STORAGE_BUTTON,
];

export const TOOLBAR_BUTTONS = {
  workflow: WORKFLOW_TOOLBAR,
  toolUse: TOOL_USE_TOOLBAR,
};

interface FilterButton {
  readonly id: string;
  readonly label: string;
  readonly filter: AgentCategoryFilter;
}

export const FILTER_BUTTONS: readonly FilterButton[] = [
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
    label: 'Interactive',
    filter: 'toolUse',
  },
];
