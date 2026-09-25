import type { HostRequest } from '@shared/session/hostRequest';
import type { TeXRAIconName } from '@ui/wa/iconNames';

/** One run action in the run header's menu. Stop sits in the row itself. */
export interface RunMenuAction {
  id: string;
  icon: TeXRAIconName;
  label: string;
  /**
   * What choosing it sends: a host arm on the run, the runtime's
   * compaction, or a clipboard write the header makes itself (it has no
   * backend leg, so it invents no round trip).
   */
  arm:
    | Extract<
        HostRequest['kind'],
        | 'resume'
        | 'runNew'
        | 'restoreIntoLauncher'
        | 'openRunStorage'
        | 'exportTranscript'
        | 'latexdiff'
        | 'pack'
        | 'clean'
      >
    | 'run.compact'
    | 'copyRunContext';
}

/**
 * DOM element IDs used across the progress view.
 */
export const ELEMENT_IDS = {
  LOG_CONTENT: 'logContent',
  ACTIVE_RUN_NAME: 'activeRunName',
  STATUS_INDICATOR: 'statusIndicator',
  GOAL_CHIP: 'goalChip',
  BYPASS_CHIP: 'bypassChip',
  PROGRESS_BADGE: 'progressBadge',
  HEADER_MORE_BTN: 'headerMoreButton',
  STOP_STREAM_BTN: 'stopStreamBtn',
  RUN_NEW_BTN: 'runNewBtn',
  RESUME_BTN: 'resumeBtn',
  RESTORE_STATE_BTN: 'restoreStateBtn',
  EXPORT_TRANSCRIPT_BTN: 'exportTranscriptBtn',
  DIFF_STREAM_BTN: 'diffStreamBtn',
  CLEAN_STREAM_BTN: 'cleanStreamBtn',
  PACK_STREAM_BTN: 'packStreamBtn',
  OPEN_RUN_STORAGE_BTN: 'openRunStorageBtn',
  COPY_RUN_CONTEXT_BTN: 'copyRunContextBtn',
  COMPACT_RESPONSE_BTN: 'compactResponseBtn',
};

export const GROUP_DOM_IDS = Object.freeze({
  DETAILS_PREFIX: 'group-',
  HEADER_PREFIX: 'group-header-',
  CONTENT_PREFIX: 'group-content-',
});

const RESTORE_STATE_ACTION: RunMenuAction = {
  id: ELEMENT_IDS.RESTORE_STATE_BTN,
  arm: 'restoreIntoLauncher',
  icon: 'reply',
  label: 'Edit as new task',
};

const OPEN_RUN_STORAGE_ACTION: RunMenuAction = {
  id: ELEMENT_IDS.OPEN_RUN_STORAGE_BTN,
  arm: 'openRunStorage',
  icon: 'folder-open',
  label: 'Open run folder',
};

const EXPORT_TRANSCRIPT_ACTION: RunMenuAction = {
  id: ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  arm: 'exportTranscript',
  icon: 'file-export',
  label: 'Export conversation…',
};

const WORKFLOW_ACTIONS: readonly RunMenuAction[] = [
  {
    id: ELEMENT_IDS.RUN_NEW_BTN,
    arm: 'runNew',
    icon: 'play',
    label: 'Run again from scratch',
  },
  {
    id: ELEMENT_IDS.RESUME_BTN,
    arm: 'resume',
    icon: 'forward-step',
    label: 'Resume from saved outputs',
  },
  RESTORE_STATE_ACTION,
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
  {
    id: ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
    icon: 'copy',
    arm: 'copyRunContext',
    label: 'Copy run context',
  },
  {
    id: ELEMENT_IDS.DIFF_STREAM_BTN,
    arm: 'latexdiff',
    icon: 'code-compare',
    label: 'Run latexdiff on the outputs',
  },
  {
    id: ELEMENT_IDS.PACK_STREAM_BTN,
    arm: 'pack',
    icon: 'box-archive',
    label: 'Archive outputs to History',
  },
  {
    id: ELEMENT_IDS.CLEAN_STREAM_BTN,
    arm: 'clean',
    icon: 'trash',
    label: 'Delete output files',
  },
];

const TOOL_USE_ACTIONS: readonly RunMenuAction[] = [
  {
    id: ELEMENT_IDS.COMPACT_RESPONSE_BTN,
    arm: 'run.compact',
    icon: 'compress',
    label: 'Compact conversation',
  },
  RESTORE_STATE_ACTION,
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
];

export const RUN_MENU_ACTIONS = {
  workflow: WORKFLOW_ACTIONS,
  toolUse: TOOL_USE_ACTIONS,
};

/**
 * Actions for a run with no known agent category — identity still pending,
 * or a non-agent run (process, multi-agent workflow container). Only the
 * category-neutral actions; never a fabricated category's chrome.
 */
export const NEUTRAL_RUN_ACTIONS: readonly RunMenuAction[] = [
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
];
