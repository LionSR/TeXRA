/**
 * The one rule for which actions a run's state licenses (`RunView.actions`),
 * and the refusal every handler words when a run no longer takes one.
 */
import {
  AgentCategory,
  isPlainAgentIdentity,
  RUN_PHASE,
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
 * or spawned and not started yet) can be stopped; while it works, an
 * agent's run takes approval grants, and a tool-use agent's its compaction
 * and a reset or handoff. Nothing that rewrites or removes a run's files or
 * history is offered while it is live. Any run this process can act on can
 * be renamed, and a tool-use conversation whose first turn has ended
 * forked (at its latest settled point, before any turn it is in now). After, a
 * run can be deleted; a plain agent's can be resumed (an interrupted one,
 * or a workflow from its saved outputs) or run again; a background
 * script's can be resumed unless it completed; a workflow agent's outputs
 * can be diffed, archived, or removed.
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
    | 'forkPoint'
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
      // An agent's view is its parent's to edit, never the user's.
      ...(compact && run.parentId === null ? (['reset'] as const) : []),
      'rename',
      ...(forkable(run) ? (['fork'] as const) : []),
      ...inspectActions(),
    ];
  }
  const actions: RunAction[] = ['delete', 'rename'];
  if (isPlainAgentIdentity(run.identity)) {
    if (run.group === 'interrupted' || run.category === AgentCategory.Workflow)
      actions.push('resume');
    actions.push('runNew');
    if (forkable(run)) actions.push('fork');
  }
  // A background script takes no message: a resume is how it continues
  // after a crash or a stop, its finished calls handed back from its rows.
  if (run.identity.kind === 'script' && run.status !== RUN_PHASE.COMPLETED)
    actions.push('resume');
  if (run.identity.kind === 'agent' && run.category === AgentCategory.Workflow)
    actions.push('diff', 'pack', 'clean');
  return [...actions, ...inspectActions()];
}

/** A conversation with a settled point to cut at: a plain tool-use agent
 *  whose first turn has ended. */
const forkable = (
  run: Pick<RunView, 'identity' | 'category' | 'forkPoint'>,
): boolean =>
  isPlainAgentIdentity(run.identity) &&
  run.category === AgentCategory.ToolUse &&
  run.forkPoint !== null;

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
  fork: 'Forking',
  reset: 'Handing off',
  diff: 'Latexdiff of the outputs',
  pack: 'Archiving the outputs',
  clean: 'Deleting the output files',
  delete: 'Deleting the task',
  rename: 'Renaming',
  openRunStorage: 'Opening the run folder',
  export: 'Export',
  copy: 'Copy',
};
