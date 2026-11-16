import { isDocumentTaskRun } from '@texra/shared/plugins/documents';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { IconName } from '@ui/wa/iconNames';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { formatTaskDiagnostics } from '@ui/copy/taskDiagnostics';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import type { RunView, RunAction } from '@texra-ai/harness/schemas';

/** What a run action reaches when it is chosen: the header's events, and
 *  its clipboard. */
export interface RunMenuTarget {
  dispatchEvent(event: Event): boolean;
  copy(text: string): void;
}

/** One run action in the run header's menu. Stop sits in the row itself. */
export interface RunMenuAction {
  /** The run action it performs: shown only while `RunView.actions` holds it. */
  action: RunAction;
  icon: IconName;
  label: string;
  /** Send what choosing it does for `run`. */
  activate(run: RunView, target: RunMenuTarget): void;
}

/**
 * DOM element IDs used across the progress view.
 */
export const ELEMENT_IDS = {
  LOG_CONTENT: 'logContent',
  ACTIVE_RUN_NAME: 'activeRunName',
  STATUS_INDICATOR: 'statusIndicator',
  PROGRESS_BADGE: 'progressBadge',
  HEADER_MORE_BTN: 'headerMoreButton',
  STOP_STREAM_BTN: 'stopStreamBtn',
};

/** An action that sends the host command `kind` on the run. */
const hostAction =
  (
    kind: Extract<
      HostCommand['kind'],
      | 'runAgain'
      | 'openRunStorage'
      | 'exportTranscript'
      | 'latexdiff'
      | 'pack'
      | 'clean'
    >,
  ) =>
  (run: RunView, target: RunMenuTarget) =>
    target.dispatchEvent(SessionUiEvents.host({ kind, runId: run.id }));

const OPEN_RUN_STORAGE_ACTION: RunMenuAction = {
  action: 'openRunStorage',
  icon: 'folder-open',
  label: TASK_ACTIONS.openFolder,
  activate: hostAction('openRunStorage'),
};

const EXPORT_TRANSCRIPT_ACTION: RunMenuAction = {
  action: 'export',
  icon: 'file-export',
  label: 'Export conversation…',
  activate: hostAction('exportTranscript'),
};

/** A task's facts for a bug report: the one place its raw ids are shown.
 *  A clipboard write the header makes itself, with no round trip. */
const COPY_DIAGNOSTICS_ACTION: RunMenuAction = {
  action: 'copy',
  icon: 'copy',
  label: TASK_ACTIONS.copyDiagnostics,
  activate: (run, target) => target.copy(formatTaskDiagnostics(run)),
};

const TASK_RUN_ACTIONS: readonly RunMenuAction[] = [
  {
    action: 'runAgain',
    icon: 'play',
    label: 'Run again…',
    activate: hostAction('runAgain'),
  },
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
  COPY_DIAGNOSTICS_ACTION,
  {
    action: 'files',
    icon: 'code-compare',
    label: 'Run latexdiff on the outputs',
    activate: hostAction('latexdiff'),
  },
  {
    action: 'files',
    icon: 'box-archive',
    label: 'Archive outputs to History',
    activate: hostAction('pack'),
  },
  {
    action: 'files',
    icon: 'trash',
    label: 'Delete output files',
    activate: hostAction('clean'),
  },
];

const CONVERSATION_RUN_ACTIONS: readonly RunMenuAction[] = [
  {
    action: 'compact',
    icon: 'compress',
    label: 'Compact conversation',
    activate: (run, target) =>
      target.dispatchEvent(
        SessionUiEvents.runtime({ kind: 'run.compact', runId: run.id }),
      ),
  },
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
  COPY_DIAGNOSTICS_ACTION,
];

/** An agent run's menu: a task's, or a conversation's. The output-file
 *  entries are the documents plugin's, for its own tasks only. */
export function runMenuActions(
  run: Pick<RunView, 'recipe'>,
): readonly RunMenuAction[] {
  if (!run.recipe) return CONVERSATION_RUN_ACTIONS;
  return isDocumentTaskRun(run)
    ? TASK_RUN_ACTIONS
    : TASK_RUN_ACTIONS.filter((entry) => entry.action !== 'files');
}

/**
 * Actions for a run that is not an agent's — identity still pending, or a
 * process or multi-agent workflow container. Only the neutral actions.
 */
export const NEUTRAL_RUN_ACTIONS: readonly RunMenuAction[] = [
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
  COPY_DIAGNOSTICS_ACTION,
];
