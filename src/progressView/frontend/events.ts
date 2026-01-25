/**
 * Typed custom events for ProgressView components.
 * Both dispatch and handler sides use these types.
 */

import type { PromptState } from './components/PromptOverlay';
import type { FollowupFormData } from './components/FollowupSection';
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

export interface FollowUpChangeDetail {
  value: string;
}

export interface FollowupModeDetail {
  mode: FollowupMode;
}

export type FollowupCommandDetail = FollowupFormData & { mode: string };

export interface PromptActionDetail {
  prompt: PromptState;
  action: string;
  feedback?: string;
}

// =============================================================================
// Event Creators - use these to dispatch typed events
// =============================================================================

/** Create a bubbling composed custom event with typed detail. */
function createEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const ProgressEvents = {
  streamSwitch: (detail: StreamEventDetail) =>
    createEvent('stream-switch', detail),

  streamDelete: (detail: StreamEventDetail) =>
    createEvent('stream-delete', detail),

  filterChange: (detail: FilterEventDetail) =>
    createEvent('filter-change', detail),

  sortChange: (detail: SortEventDetail) => createEvent('sort-change', detail),

  deleteAll: () => createEvent('delete-all', {}),

  toolbarCommand: (detail: ToolbarCommandDetail) =>
    createEvent('toolbar-command', detail),

  runSelected: (detail: RunSelectedDetail) =>
    createEvent('run-selected', detail),

  fileAction: (detail: Record<string, string>) =>
    createEvent('file-action', detail),

  followupChange: (detail: FollowUpChangeDetail) =>
    createEvent('followup-change', detail),

  followupSend: () => createEvent('followup-send', {}),

  followupPolish: () => createEvent('followup-polish', {}),

  followupClear: () => createEvent('followup-clear', {}),

  followupToggleBypass: () => createEvent('followup-toggle-bypass', {}),

  followupRequestOptions: () => createEvent('followup-request-options', {}),

  followupModeChange: (detail: FollowupModeDetail) =>
    createEvent('followup-mode-change', detail),

  followupSetup: (detail: FollowupCommandDetail) =>
    createEvent('followup-setup', detail),

  followupRun: (detail: FollowupCommandDetail) =>
    createEvent('followup-run', detail),

  promptAction: (detail: PromptActionDetail) =>
    createEvent('prompt-action', detail),
} as const;
