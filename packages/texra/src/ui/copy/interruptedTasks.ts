/**
 * The interrupted tasks a chat's `/resume all` continues: the root tasks in
 * the view's `interrupted` group that this window can resume. The view lists
 * them under their group; each has its own Resume.
 */
import {
  isInterrupted,
  type RunView,
  type SessionView,
  type RunId,
} from '@texra-ai/harness/schemas';

import { nestedCountsLabel } from './nestedRuns';

/** One interrupted task, as `/resume all` names it. */
interface InterruptedTask {
  readonly runId: RunId;
  readonly title: string;
  /** When it last did anything: the host words it ("3 h ago"). */
  readonly stoppedAt: number | null;
  /** "3 agents, 1 command, 2 done", or null for a task that started none. */
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
        isInterrupted(run) &&
        run.actions.includes('resume'),
    )
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .map((run) => ({
      runId: run.id,
      title: run.title,
      stoppedAt: run.lastTimestamp,
      agents: agentProgress(run),
    }));
}

function agentProgress(run: Pick<RunView, 'rollup'>): string | null {
  const { total, finished, kinds } = run.rollup;
  if (total === 0) return null;
  return `${nestedCountsLabel(kinds)}, ${finished} done`;
}
