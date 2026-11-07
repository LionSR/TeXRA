/**
 * `tasks.list`: the top-level tasks of every project under the process's
 * storage root (`Sessions.projects`: an open project's live view, any other
 * read cold from its store).
 */
import { Effect } from 'effect';

import { Sessions } from '@texra-ai/harness';
import { type SessionView } from '@texra-ai/harness/schemas';

import { runStatus } from '@ui/copy/runStatus';

import type { TaskSummary } from './protocol';

/** The newest tasks `tasks.list` returns, live ones always included. */
const TASK_LIST_LIMIT = 200;

/** The top-level tasks one view holds, as the list states them. */
function summaries(view: SessionView, workspace: string): TaskSummary[] {
  return [...view.runs.values()]
    .filter((run) => run.parentId === null)
    .map((run) => ({
      workspace,
      runId: run.id,
      label: run.label,
      description: run.description,
      statusKey: runStatus(run).key,
      launchedAt: run.launchedAt,
      live: run.holder === 'here',
    }));
}

/**
 * Every project's top-level tasks, newest first. `all` returns every task;
 * otherwise the newest 200, live ones always kept.
 */
export const listTasks = Effect.fn('taskList.listTasks')(function* (
  all: boolean,
) {
  const projects = yield* (yield* Sessions).projects;
  const newest = projects
    .flatMap(({ view, workspace }) => summaries(view, workspace))
    .toSorted((a, b) => b.launchedAt - a.launchedAt);
  if (all) return newest;
  const live = newest.filter((task) => task.live);
  // Every live task is kept past the limit; the list stays newest first.
  const kept = new Set([
    ...live,
    ...newest.slice(0, Math.max(0, TASK_LIST_LIMIT - live.length)),
  ]);
  return newest.filter((task) => kept.has(task));
});
