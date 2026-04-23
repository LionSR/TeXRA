/**
 * Typed custom events for ProgressView components.
 * Both dispatch and handler sides use these types.
 */

import type { StringValueDetail } from '@shared/schemas';
import { createEvent } from '@shared/utils/events';

import type { FollowupFormData } from './components/FollowupSection';
import type { PermissionState } from './components/PermissionCard';
import type { FollowupMode, StreamFilter } from './store';

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

/** Alias for semantic clarity - uses shared StringValueDetail */
export type FollowUpChangeDetail = StringValueDetail;

export interface FollowupModeDetail {
  mode: FollowupMode;
}

export type FollowupCommandDetail = FollowupFormData & { mode: string };

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

  followupSend: () => createEvent('followup-send', undefined),

  followupPolish: () => createEvent('followup-polish', undefined),

  followupClear: () => createEvent('followup-clear', undefined),

  followupRequestOptions: () =>
    createEvent('followup-request-options', undefined),

  followupModeChange: (detail: FollowupModeDetail) =>
    createEvent('followup-mode-change', detail),

  followupSetup: (detail: FollowupCommandDetail) =>
    createEvent('followup-setup', detail),

  followupRun: (detail: FollowupCommandDetail) =>
    createEvent('followup-run', detail),

  permissionAction: (detail: PermissionActionDetail) =>
    createEvent('permission-action', detail),

  groupToggle: (detail: { groupId: string; expanded: boolean }) =>
    createEvent('group-toggle', detail),

  fileClick: (detail: { file: string; line?: number }) =>
    createEvent('file-click', detail),

  focusComplete: () => createEvent('focus-complete', undefined),

  followupFocusComplete: () =>
    createEvent('followup-focus-complete', undefined),

  /** Request focus on the follow-up input (e.g. from the "Send Follow-up" button in log entries). */
  followupFocusRequest: () => createEvent('followup-focus-request', undefined),
} as const;
