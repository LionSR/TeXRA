/**
 * The one rule for which actions a run's state licenses (`RunView.actions`),
 * and the refusal every handler words when a run no longer takes one.
 */
import {
  isLoopDriven,
  isPlainAgentIdentity,
  type RunAction,
} from '@shared/schemas';

import { isInterrupted, type RunView } from './sessionView';
import type { RunView as ReadonlyRunView } from './readonlyViews';

/** Opening the run's folder, exporting its conversation, copying its
 *  diagnostics: what any run offers, a fresh list per run so no two views
 *  share one array. */
const inspectActions = (): RunAction[] => ['openRunStorage', 'export', 'copy'];

/**
 * The one rule for which actions a run's state licenses, applied by the fold
 * into `RunView.actions`. One whose rows this build cannot read (`stranded`:
 * damaged, or an earlier build's) never becomes readable,
 * so it offers delete beside inspection, the one way to clear it. A run
 * this process holds (working, waiting, or spawned and not started yet) can
 * be stopped; an agent's run takes approval grants, and a conversation (not
 * a task's recipe) its compaction, unless it is still starting (no loop
 * step and no settled point yet). Nothing that rewrites or
 * removes a run's files or history is offered while it is live. Any run this
 * process can act on can be renamed, and a conversation whose first turn has
 * ended forked (at its latest settled point, before any turn it is in now). After, a
 * run can be deleted and its files worked on (`run.files`); a plain
 * agent's run again. Resume is offered where it is the way to
 * continue: on any loop-driven run that was interrupted, and on a background
 * script that did not complete. A settled task runs again; a
 * settled conversation continues through its composer. Whether a resume can
 * proceed is `deriveResumability`'s.
 */
export function runActions(
  run: Pick<
    RunView,
    'holder' | 'outcome' | 'turn' | 'identity' | 'recipe' | 'forkPoint'
  >,
  stranded: boolean,
): RunAction[] {
  if (stranded) return ['delete', ...inspectActions()];
  if (run.holder === 'here') {
    const agent = run.identity.kind === 'agent';
    // Nothing to compact while its first activation has taken no loop step.
    const starting = run.turn === null && run.forkPoint === null;
    const compact = agent && !run.recipe && !starting;
    return [
      'stop',
      ...(agent ? (['grant'] as const) : []),
      ...(compact ? (['compact'] as const) : []),
      'rename',
      ...(forkable(run) ? (['fork'] as const) : []),
      ...inspectActions(),
    ];
  }
  const actions: RunAction[] = ['delete', 'rename', 'files'];
  const ended = run.outcome !== null;
  if (
    continuesFromRows({ ...run, ended }) &&
    (isInterrupted(run) ||
      (run.identity.kind === 'script' && run.outcome !== 'completed'))
  )
    actions.push('resume');
  if (isPlainAgentIdentity(run.identity)) {
    actions.push('runAgain');
    if (forkable(run)) actions.push('fork');
  }
  return [...actions, ...inspectActions()];
}

/**
 * Whether a run continues from its own rows: a loop-driven run (born with
 * its opening) does, whatever its outcome, unless it is a task that
 * ended (its recipe's result is settled, so it runs again). The one standing
 * `deriveResumability` reads from a run's records and `runActions` from its
 * view, so the two never decide apart.
 */
export const continuesFromRows = (
  run: Pick<RunView, 'identity' | 'recipe'> & { readonly ended: boolean },
): boolean => isLoopDriven(run.identity) && !(run.ended && run.recipe);

/** A conversation with a settled point to cut at: a plain agent's run, not
 *  a task's recipe, whose first turn has ended. */
const forkable = (
  run: Pick<RunView, 'identity' | 'recipe' | 'forkPoint'>,
): boolean =>
  isPlainAgentIdentity(run.identity) && !run.recipe && run.forkPoint !== null;

/** Why a run no longer takes `action`: the refusal every handler words. */
export function runActionRefusal(
  run: Pick<ReadonlyRunView, 'holder' | 'label'>,
  action: RunAction,
): string {
  const what = ACTION_LABEL[action];
  if (run.holder === 'here')
    return `${what} is not available while “${run.label}” is running; stop it first.`;
  return `${what} is not available for “${run.label}” in its current state.`;
}

const ACTION_LABEL: Record<RunAction, string> = {
  stop: 'Stop',
  grant: 'An approval grant',
  compact: 'Compaction',
  resume: 'Resume',
  runAgain: 'Run again',
  fork: 'Forking',
  files: "Working with the run's files",
  delete: 'Deleting',
  rename: 'Renaming',
  openRunStorage: 'Opening the run folder',
  export: 'Export',
  copy: 'Copy',
};
