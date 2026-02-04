/**
 * Typed custom events for ProgressView components.
 * Both dispatch and handler sides use these types.
 */

import { createEvent } from '@shared/utils/events';

import type { StringValueDetail } from '@shared/schemas';
import type { FollowupFormData } from './components/FollowupSection';
import type { PermissionState } from './components/PermissionCard';
import type { FollowupMode, StreamFilter, StreamSort } from './store';

// =============================================================================
// Event Detail Types
// =============================================================================

export interface StreamEventDetail {
  streamId: string;
}

export interface FilterEventDetail {
  filter: StreamFilter;
}

export interface SortEventDetail {
  sort: StreamSort;
}

export interface ToolbarCommandDetail {
  command: string;
}

export interface RunSelectedDetail {
  runId: string | null;
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
}

export interface GroupToggleDetail {
  groupId: string;
  expanded: boolean;
}

export interface FileClickDetail {
  file: string;
  line?: number;
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

  sortChange: (detail: SortEventDetail) => createEvent('sort-change', detail),

  deleteAll: () => createEvent('delete-all', undefined),

  toolbarCommand: (detail: ToolbarCommandDetail) =>
    createEvent('toolbar-command', detail),

  runSelected: (detail: RunSelectedDetail) =>
    createEvent('run-selected', detail),

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

  groupToggle: (detail: GroupToggleDetail) =>
    createEvent('group-toggle', detail),

  fileClick: (detail: FileClickDetail) => createEvent('file-click', detail),

  focusComplete: () => createEvent('focus-complete', undefined),

  followupFocusComplete: () =>
    createEvent('followup-focus-complete', undefined),

  compactNow: () => createEvent('compact-now', undefined),
} as const;
