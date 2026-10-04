/**
 * The one rule for which actions a run's state licenses (`RunView.actions`),
 * and the refusal every handler words when a run no longer takes one.
 */
import {
  AgentCategory,
  isLoopDriven,
  isPlainAgentIdentity,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunAction,
} from '@shared/schemas';

import { isLiveRun, type RunView } from './sessionView';

/** Opening the run's folder, exporting its conversation, copying its
 *  diagnostics: what any run offers, a fresh list per run so no two views
 *  share one array. */
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
 * run can be deleted; a plain agent's run again; a workflow agent's outputs
 * diffed, archived, or removed. Resume is offered where it is the way to
 * continue: on any loop-driven run that was interrupted, and on a settled one
 * that takes no message (a workflow, from its saved outputs; a background
 * script that did not complete). A settled conversation continues through its
 * composer. Whether a resume can proceed is `deriveResumability`'s.
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
  if (
    isLoopDriven(run.identity) &&
    (run.group === 'interrupted' ||
      run.category === AgentCategory.Workflow ||
      (run.identity.kind === 'script' && run.status !== RUN_PHASE.COMPLETED))
  )
    actions.push('resume');
  if (isPlainAgentIdentity(run.identity)) {
    actions.push('runNew');
    if (forkable(run)) actions.push('fork');
  }
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
