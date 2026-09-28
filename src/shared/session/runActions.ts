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

const INSPECT_ACTIONS: readonly RunAction[] = [
  'openRunStorage',
  'export',
  'copy',
];

/**
 * The one rule for which actions a run's state licenses, applied by the fold
 * into `RunView.actions`. A run another process holds (or one this process
 * cannot read) is inspect-only. A working run (running or waiting) can be
 * stopped, and a tool-use agent's takes grants and compaction; nothing that
 * rewrites or removes its files or history is offered until it has stopped.
 * Any other run can be deleted; a plain agent's can be resumed (an
 * interrupted one, or a workflow from its saved outputs), run again, or
 * restored into the launcher; a workflow agent's outputs can be diffed,
 * archived, or removed.
 */
export function runActions(
  run: Pick<
    RunView,
    'readOnly' | 'group' | 'status' | 'substate' | 'identity' | 'category'
  >,
): readonly RunAction[] {
  if (run.readOnly) return INSPECT_ACTIONS;
  if (run.group === 'running' || run.group === 'waiting') {
    const toolUseAgent =
      run.substate !== RUN_SUBSTATE.STARTING &&
      run.category === AgentCategory.ToolUse &&
      run.identity.kind === 'agent';
    return [
      'stop',
      ...(toolUseAgent ? (['grant', 'compact'] as const) : []),
      ...INSPECT_ACTIONS,
    ];
  }
  // Not working: ended, interrupted, paused, or a spawned run that has not
  // started (which can still be stopped). Whether nothing holds it any more
  // is the run registry's to say when a delete acts (`RunLive`).
  const actions: RunAction[] = isLiveRun(run) ? ['stop', 'delete'] : ['delete'];
  if (isPlainAgentIdentity(run.identity)) {
    if (
      run.group === 'interrupted' ||
      (run.category === AgentCategory.Workflow && !isLiveRun(run))
    )
      actions.push('resume');
    actions.push('runNew', 'restore');
  }
  if (run.identity.kind === 'agent' && run.category === AgentCategory.Workflow)
    actions.push('diff', 'pack', 'clean');
  return [...actions, ...INSPECT_ACTIONS];
}

/** Why a run no longer takes `action`: the refusal every handler words. */
export function runActionRefusal(
  run: Pick<RunView, 'readOnly' | 'group' | 'status' | 'substate' | 'label'>,
  action: RunAction,
): string {
  const what = ACTION_LABEL[action];
  if (run.readOnly)
    return `${what} is not available: “${run.label}” is held by another TeXRA process.`;
  if (run.group === 'running' || run.group === 'waiting')
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
  delete: 'Deleting the session',
  openRunStorage: 'Opening the run folder',
  export: 'Export',
  copy: 'Copy',
};
