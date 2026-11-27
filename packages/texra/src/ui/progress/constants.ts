import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { IconName } from '@ui/wa/iconNames';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { formatTaskDiagnostics } from '@ui/copy/taskDiagnostics';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import type { RunView, RunAction } from '@texra-ai/worldline/schemas';

/** What a run action reaches when it is chosen: the header's events, and
 *  its clipboard. */
export interface RunMenuTarget {
  dispatchEvent(event: Event): boolean;
  copy(text: string): void;
}

/** One run action in the run header's menu. Stop sits in the row itself. */
interface RunMenuAction {
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
export const ELEMENT_IDS = Object.freeze({
  LOG_CONTENT: 'logContent',
  ACTIVE_RUN_NAME: 'activeRunName',
  STATUS_INDICATOR: 'statusIndicator',
  HEADER_MORE_BTN: 'headerMoreButton',
  STOP_STREAM_BTN: 'stopStreamBtn',
});

/** An action that sends the host command `kind` on the run. */
const hostAction =
  (
    kind: Extract<
      HostCommand['kind'],
      'runAgain' | 'openRunStorage' | 'exportTranscript'
    >,
  ) =>
  (run: RunView, target: RunMenuTarget) =>
    target.dispatchEvent(SessionUiEvents.host({ kind, runId: run.id }));

const OPEN_RUN_STORAGE_ACTION: RunMenuAction = Object.freeze({
  action: 'openRunStorage',
  icon: 'folder-open',
  label: TASK_ACTIONS.openFolder,
  activate: hostAction('openRunStorage'),
});

const EXPORT_TRANSCRIPT_ACTION: RunMenuAction = Object.freeze({
  action: 'export',
  icon: 'file-export',
  label: 'Export conversation…',
  activate: hostAction('exportTranscript'),
});

/** A task's facts for a bug report: the one place its raw ids are shown.
 *  A clipboard write the header makes itself, with no round trip. */
const COPY_DIAGNOSTICS_ACTION: RunMenuAction = Object.freeze<RunMenuAction>({
  action: 'copy',
  icon: 'copy',
  label: TASK_ACTIONS.copyDiagnostics,
  activate: (run, target) => target.copy(formatTaskDiagnostics(run)),
});

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
  {
    action: 'runAgain',
    icon: 'play',
    label: 'Run again…',
    activate: hostAction('runAgain'),
  },
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
  COPY_DIAGNOSTICS_ACTION,
];

/** An agent run's menu: a program's, or a conversation's. */
export function runMenuActions(
  run: Pick<RunView, 'program'>,
): readonly RunMenuAction[] {
  return run.program ? NEUTRAL_RUN_ACTIONS : CONVERSATION_RUN_ACTIONS;
}

/**
 * Actions for a run that is not an agent's — identity still pending, or a
 * process or multi-agent workflow container. Only the neutral actions.
 */
export const NEUTRAL_RUN_ACTIONS: readonly RunMenuAction[] = Object.freeze([
  OPEN_RUN_STORAGE_ACTION,
  EXPORT_TRANSCRIPT_ACTION,
  COPY_DIAGNOSTICS_ACTION,
]);
