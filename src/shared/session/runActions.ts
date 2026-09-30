/**
 * The one rule for which actions a run's state licenses (`RunView.actions`),
 * and the refusal every handler words when a run no longer takes one.
 */
import {
  AgentCategory,
  isPlainAgentIdentity,
  RUN_SUBSTATE,
  type RunAction,
} from '@shared/schemas';

import { isLiveRun, type RunView } from './sessionView';

/** Opening the run's folder, exporting or copying its conversation: what
 *  any run offers, a fresh list per run so no two views share one array. */
const inspectActions = (): RunAction[] => ['openRunStorage', 'export', 'copy'];

/**
 * The one rule for which actions a run's state licenses, applied by the fold
 * into `RunView.actions`. A run another process holds (or one this process
 * cannot read) is inspect-only. A live run (`isLiveRun`: working, waiting,
 * or spawned and not started yet) can only be stopped; while it works, an
 * agent's run takes approval grants and a tool-use agent's compaction.
 * Nothing that rewrites or removes a run's files or history is offered while
 * it is live. After, a top-level run can be moved to the Trash (a subagent,
 * which lives in its parent's conversation, deleted outright); a trashed run
 * can only be restored or deleted for good. A plain agent's can be resumed
 * (an interrupted one, or a workflow from its saved outputs), run again, or
 * restored into the launcher; a workflow agent's outputs can be diffed,
 * archived, or removed.
 */
export function runActions(
  run: Pick<
    RunView,
    | 'readOnly'
    | 'group'
    | 'status'
    | 'substate'
    | 'identity'
    | 'category'
    | 'parentId'
    | 'trashedAt'
  >,
): RunAction[] {
  if (run.readOnly) return inspectActions();
  if (isLiveRun(run)) {
    const working = run.group === 'running' || run.group === 'waiting';
    const agent = working && run.identity.kind === 'agent';
    const compact =
      agent &&
      run.category === AgentCategory.ToolUse &&
      run.substate !== RUN_SUBSTATE.STARTING;
    return [
      'stop',
      ...(agent ? (['grant'] as const) : []),
      ...(compact ? (['compact'] as const) : []),
      ...inspectActions(),
    ];
  }
  if (run.trashedAt !== null) return ['untrash', 'delete', ...inspectActions()];
  const actions: RunAction[] = [run.parentId === null ? 'trash' : 'delete'];
  if (isPlainAgentIdentity(run.identity)) {
    if (run.group === 'interrupted' || run.category === AgentCategory.Workflow)
      actions.push('resume');
    actions.push('runNew', 'restore');
  }
  if (run.identity.kind === 'agent' && run.category === AgentCategory.Workflow)
    actions.push('diff', 'pack', 'clean');
  return [...actions, ...inspectActions()];
}

/** Why a run no longer takes `action`: the refusal every handler words. */
export function runActionRefusal(
  run: Pick<RunView, 'readOnly' | 'group' | 'status' | 'substate' | 'label'>,
  action: RunAction,
): string {
  const what = ACTION_LABEL[action];
  if (run.readOnly)
    return `${what} is not available: this TeXRA process cannot act on “${run.label}”.`;
  if (isLiveRun(run))
    return `${what} is not available while “${run.label}” is running; stop it first.`;
  return `${what} is not available for “${run.label}” in its current state.`;
}

const ACTION_LABEL: Record<RunAction, string> = {
  stop: 'Stop',
  grant: 'An approval grant',
  compact: 'Compaction',
  resume: 'Resume',
  runNew: 'Run again',
  restore: 'Edit as new task',
  diff: 'Latexdiff of the outputs',
  pack: 'Archiving the outputs',
  clean: 'Deleting the output files',
  trash: 'Moving to the Trash',
  untrash: 'Restoring from the Trash',
  delete: 'Deleting the session',
  openRunStorage: 'Opening the run folder',
  export: 'Export',
  copy: 'Copy',
};
