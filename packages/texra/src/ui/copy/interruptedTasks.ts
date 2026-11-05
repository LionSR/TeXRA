/**
 * The interrupted tasks a chat's `/resume all` continues: the root tasks in
 * the view's `interrupted` group that this window can resume. The view lists
 * them under their group; each has its own Resume.
 */
import { formatResultCount } from '@texra-ai/harness/transcript';
import type { RunView, SessionView, RunId } from '@texra-ai/harness/schemas';

/** One interrupted task, as `/resume all` names it. */
export interface InterruptedTask {
  readonly runId: RunId;
  readonly title: string;
  /** When it last did anything: the host words it ("3 h ago"). */
  readonly stoppedAt: number | null;
  /** "2 of 4 agents done", or null for a task that started none. */
  readonly agents: string | null;
}

/** The root tasks this window can resume that no process holds and that
 *  did not end, newest first. */
export function interruptedTasks(
  view: Pick<SessionView, 'runs'>,
): InterruptedTask[] {
  return [...view.runs.values()]
    .filter(
      (run) =>
        run.parentId === null &&
        run.group === 'interrupted' &&
        run.actions.includes('resume'),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((run) => ({
      runId: run.id,
      title: run.title,
      stoppedAt: run.lastTimestamp,
      agents: agentProgress(run),
    }));
}

function agentProgress(run: Pick<RunView, 'rollup'>): string | null {
  const { total, finished } = run.rollup;
  if (total === 0) return null;
  return `${finished} of ${formatResultCount(total, 'agent')} done`;
}
