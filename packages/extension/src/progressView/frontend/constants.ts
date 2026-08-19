import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';
import type { TeXRAIconName } from '@shared/wa/iconNames';

export interface ProgressToolbarButton {
  id: string;
  icon: TeXRAIconName;
  /** Backend command. Omitted exactly when `localAction` is set. */
  command?: string;
  /**
   * Frontend-only action the header carries out itself instead of posting to
   * the backend. A clipboard write has no backend leg, so such a button
   * declares `localAction` rather than inventing a round trip.
   */
  localAction?: 'copyRunContext';
  title: string;
  titleActive?: string;
  /**
   * Constant short accessible name for icon-only toggles, whose state is
   * carried by `aria-pressed` — the name must not swap with state. Falls
   * back to `title` when omitted.
   */
  label?: string;
  className?: string;
  disabled?: boolean;
  isToggle?: boolean;
}

/**
 * DOM element IDs used across the progress view.
 */
export const ELEMENT_IDS = {
  LOG_CONTENT: 'logContent',
  GENERATED_FILES: 'generatedFiles',
  GENERATED_FILES_COLLAPSIBLE: 'generatedFilesCollapsible',
  STREAM_TABS: 'streamTabs',
  ACTIVE_STREAM_NAME: 'activeStreamName',
  PARENT_LINK: 'parentLink',
  STATUS_INDICATOR: 'statusIndicator',
  GOAL_CHIP: 'goalChip',
  PROGRESS_BADGE: 'progressBadge',
  RUN_ELAPSED: 'runElapsed',
  RUN_SUMMARY: 'runSummary',
  CONTEXT_STATE: 'contextState',
  TODO_LIST_CONTAINER: 'todoListContainer',
  TODO_LIST: 'todoList',
  PLAN_VIEW_CONTAINER: 'planViewContainer',
  PLAN_VIEW: 'planView',
  TOOLBAR_CONTAINER: 'toolbarContainer',
  STOP_STREAM_BTN: 'stopStreamBtn',
  RUN_NEW_BTN: 'runNewBtn',
  RESUME_BTN: 'resumeBtn',
  RESTORE_STATE_BTN: 'restoreStateBtn',
  EXPORT_TRANSCRIPT_BTN: 'exportTranscriptBtn',
  DIFF_STREAM_BTN: 'diffStreamBtn',
  CLEAN_STREAM_BTN: 'cleanStreamBtn',
  PACK_STREAM_BTN: 'packStreamBtn',
  OPEN_TASK_STORAGE_BTN: 'openTaskStorageBtn',
  COPY_RUN_CONTEXT_BTN: 'copyRunContextBtn',
  FOLLOW_UP_CONTAINER: 'followUpContainer',
  FOLLOW_UP_INPUT: 'followUpInput',
  QUEUED_FOLLOW_UPS_COLLAPSIBLE: 'queuedFollowUpsCollapsible',
  QUEUED_FOLLOW_UPS_LIST: 'queuedFollowUpsList',
  RECORD_FOLLOW_UP_BTN: 'recordFollowUpBtn',
  COMPACT_RESPONSE_BTN: 'compactResponseBtn',
  YOLO_TOGGLE_BTN: 'yoloToggleBtn',
  SUPER_YOLO_TOGGLE_BTN: 'superYoloToggleBtn',
  POLISH_FOLLOW_UP_BTN: 'polishFollowUpBtn',
  SEND_FOLLOW_UP_BTN: 'sendFollowUpBtn',
};

export const GROUP_DOM_IDS = Object.freeze({
  DETAILS_PREFIX: 'group-',
  HEADER_PREFIX: 'group-header-',
  CONTENT_PREFIX: 'group-content-',
});

const STOP_STREAM_BUTTON = Object.freeze({
  id: ELEMENT_IDS.STOP_STREAM_BTN,
  icon: 'circle-stop',
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
  icon: 'folder-open',
  command: PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE,
  title: 'Open in task storage: reveal this run folder and generated files',
  className: 'storage-button',
  disabled: true,
});

const EXPORT_TRANSCRIPT_BUTTON = Object.freeze({
  id: ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  icon: 'file-export',
  command: PROGRESS_VIEW_COMMANDS.EXPORT_TRANSCRIPT,
  title: 'Export this conversation as Markdown, HTML, or PDF',
  className: 'export-button',
  disabled: true,
});

const COPY_RUN_CONTEXT_BUTTON = Object.freeze({
  id: ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
  icon: 'copy',
  localAction: 'copyRunContext',
  title:
    'Copy run context: this run and its output paths, as text to paste into a new chat',
  className: 'copy-run-context-button',
  disabled: true,
} satisfies ProgressToolbarButton);

const WORKFLOW_TOOLBAR: readonly ProgressToolbarButton[] = [
  STOP_STREAM_BUTTON,
  {
    id: ELEMENT_IDS.RUN_NEW_BTN,
    icon: 'play',
    command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
    title: 'Start a fresh run (discards previous outputs)',
    className: 'run-button run-new-button',
    disabled: true,
  },
  {
    id: ELEMENT_IDS.RESUME_BTN,
    icon: 'forward-step',
    command: PROGRESS_VIEW_COMMANDS.RESUME,
    title: 'Resume from saved outputs (continues where it left off)',
    className: 'run-button resume-button',
    disabled: true,
  },
  RESTORE_STATE_BUTTON,
  OPEN_TASK_STORAGE_BUTTON,
  EXPORT_TRANSCRIPT_BUTTON,
  COPY_RUN_CONTEXT_BUTTON,
  {
    id: ELEMENT_IDS.DIFF_STREAM_BTN,
    icon: 'code-compare',
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
    icon: 'box-archive',
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
  label: 'Auto-approve edits and commands',
  title: 'Auto-approve both file edits and shell commands in this run',
  titleActive:
    'File edits and shell commands are being auto-approved. Click to resume approval prompts for both.',
  className: 'yolo-toggle-button',
  isToggle: true,
});

const DELEGATED_WORK_APPROVAL_TOGGLE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN,
  icon: 'rocket',
  command: PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS,
  label: 'Auto-approve agent work',
  title: DELEGATION_APPROVAL_COPY.progressViewToggle,
  titleActive:
    'Agent tasks, file edits, and shell commands are being auto-approved — click to resume prompts',
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

const TOOL_USE_TOOLBAR: readonly ProgressToolbarButton[] = [
  STOP_STREAM_BUTTON,
  YOLO_TOGGLE_BUTTON,
  DELEGATED_WORK_APPROVAL_TOGGLE_BUTTON,
  COMPACT_RESPONSE_BUTTON,
  RESTORE_STATE_BUTTON,
  OPEN_TASK_STORAGE_BUTTON,
  EXPORT_TRANSCRIPT_BUTTON,
];

export const TOOLBAR_BUTTONS = {
  workflow: WORKFLOW_TOOLBAR,
  toolUse: TOOL_USE_TOOLBAR,
};

/**
 * Toolbar for a stream with no known agent category — identity still pending,
 * or a non-agent run (process, multi-agent workflow container). Only the
 * category-neutral actions; never a fabricated category's chrome.
 */
export const NEUTRAL_TOOLBAR: readonly ProgressToolbarButton[] = [
  STOP_STREAM_BUTTON,
  OPEN_TASK_STORAGE_BUTTON,
  EXPORT_TRANSCRIPT_BUTTON,
];
