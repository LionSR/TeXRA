/**
 * `tasks.list`: the top-level tasks of every project under the process's
 * storage root (`Sessions.projects`: an open project's live view, any other
 * read cold from its store).
 */
import { Array as Arr, Effect } from 'effect';

import { Sessions } from '@texra-ai/worldline';
import { type SessionView } from '@texra-ai/worldline/schemas';

import { runStatusKey } from '@texra/shared/session/runStatusKey';

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
      label: run.title,
      statusKey: runStatusKey(run),
      launchedAt: run.launchedAt,
      live: run.holder === 'here',
    }));
}

/**
 * Every project's top-level tasks, newest first. `all` returns every task;
 * otherwise all live tasks plus the newest non-live tasks up to the limit.
 */
export const listTasks = Effect.fn('taskList.listTasks')(function* (
  all: boolean,
) {
  const projects = yield* (yield* Sessions).projects;
  const newest = projects
    .flatMap(({ view, workspace }) => summaries(view, workspace))
    .toSorted((a, b) => b.launchedAt - a.launchedAt);
  if (all) return newest;
  let remaining = TASK_LIST_LIMIT - Arr.countBy(newest, (task) => task.live);
  return newest.filter((task) => {
    if (task.live) return true;
    if (remaining <= 0) return false;
    remaining -= 1;
    return true;
  });
});
