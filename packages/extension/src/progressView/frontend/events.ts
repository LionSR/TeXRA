/**
 * Typed custom events for ProgressView components.
 * Both dispatch and handler sides use these types.
 */

import type {
  GettingStartedActionDetail,
  UserQuestionAnswers,
} from '@shared/schemas';
import { createEvent } from '@shared/utils/events';
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';

import type { PermissionState } from './permissionState';
import type { StreamFilter } from './store';

// =============================================================================
// Event Detail Types
// =============================================================================

export interface StreamEventDetail {
  streamId: string;
}

export interface FilterEventDetail {
  filter: StreamFilter;
}

export interface ToolbarCommandDetail {
  command: string;
}

export interface FollowUpChangeDetail {
  readonly streamId: string;
  readonly value: string;
  /** Append is used when an async paste finishes after its stream is hidden. */
  readonly mode?: 'replace' | 'append';
}

/** Images pasted into the follow-up box, carried with the send event. */
export interface FollowUpSendDetail {
  readonly streamId: string;
  readonly images: readonly ExtractedClipboardImage[];
}

export interface FollowUpClearDetail {
  readonly streamId: string;
}

export interface FollowupCommandDetail {
  agent: string;
  model: string;
  initialQuestion: string;
}

/**
 * Frontend-only panel action emitted by the inline "Yolo (this session)"
 * button / `a` shortcut on the edit and bash approval prompts.
 * `handlePermissionAction` decomposes it into a normal approve plus a
 * session-bypass enable, so — unlike `approve` / `reject` / `openDiff` — it
 * never reaches the backend approval protocol (`BASH_APPROVAL_ACTIONS` /
 * `TOOL_EDIT_APPROVAL_ACTIONS` in `@shared/schemas`). Single source of truth
 * shared by the panel that emits it and the handler that consumes it.
 */
export const APPROVE_SESSION_ACTION = 'approveSession';

/**
 * Frontend-only panel action emitted by the "Super Yolo (this session)" item on
 * the agent-proposal Approve caret. Like {@link APPROVE_SESSION_ACTION},
 * `handlePermissionAction` decomposes it — into a normal proposal approve plus a
 * per-stream super-yolo bypass enable (`TOGGLE_SUPER_YOLO_BYPASS`) — so it never
 * reaches the backend proposal protocol (whose action enum stays
 * `approve | reject | setup`). Single source of truth shared by the panel that
 * emits it and the handler that consumes it.
 */
export const APPROVE_SUPER_YOLO_ACTION = 'approveSuperYolo';

export interface PermissionActionDetail {
  permission: PermissionState;
  action: string;
  feedback?: string;
  modelOverride?: string;
  agentOverride?: string;
  /** Answer text from external inquiry panel (submit action only). */
  answer?: string;
  /** External chat/thread links captured from the user (submit action only). */
  sessionLinks?: string[];
  /** Structured answers from the user-question panel (submit action only). */
  answers?: UserQuestionAnswers;
}

/**
 * Detail for file-related actions in ProgressView.
 * Named to distinguish from mainView's FileActionDetail which has different fields.
 */
export interface ProgressFileActionDetail {
  command: string;
  file: string;
  base?: string;
  prev?: string;
}

// =============================================================================
// Event Creators - use these to dispatch typed events
// =============================================================================

export const ProgressEvents = {
  streamSwitch: (detail: StreamEventDetail) =>
    createEvent('stream-switch', detail),

  streamDelete: (detail: StreamEventDetail) =>
    createEvent('stream-delete', detail),

  filterChange: (detail: FilterEventDetail) =>
    createEvent('filter-change', detail),

  deleteAll: () => createEvent('delete-all', undefined),

  toolbarCommand: (detail: ToolbarCommandDetail) =>
    createEvent('toolbar-command', detail),

  fileAction: (detail: ProgressFileActionDetail) =>
    createEvent('file-action', detail),

  followupChange: (detail: FollowUpChangeDetail) =>
    createEvent('followup-change', detail),

  followupSend: (detail: FollowUpSendDetail) =>
    createEvent('followup-send', detail),

  followupPolish: () => createEvent('followup-polish', undefined),

  followupClear: (detail: FollowUpClearDetail) =>
    createEvent('followup-clear', detail),

  followupRequestOptions: () =>
    createEvent('followup-request-options', undefined),

  followupSetup: (detail: FollowupCommandDetail) =>
    createEvent('followup-setup', detail),

  followupRun: (detail: FollowupCommandDetail) =>
    createEvent('followup-run', detail),

  compileFixerRun: () => createEvent('compile-fixer-run', undefined),

  permissionAction: (detail: PermissionActionDetail) =>
    createEvent('permission-action', detail),

  groupToggle: (detail: { groupId: string; expanded: boolean }) =>
    createEvent('group-toggle', detail),

  fileClick: (detail: { file: string; line?: number }) =>
    createEvent('file-click', detail),

  focusComplete: () => createEvent('focus-complete', undefined),

  followupFocusComplete: () =>
    createEvent('followup-focus-complete', undefined),

  gettingStartedAction: (detail: GettingStartedActionDetail) =>
    createEvent('getting-started-action', detail),
} as const;
