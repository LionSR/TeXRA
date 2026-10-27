/**
 * `tasks.list`: the top-level tasks of every project under the storage
 * root. The projects are the `workspace-store` records each host writes when
 * it opens a project, so the scan adds no table. A
 * project the service has open answers from its live view; any other is
 * read cold from its store (`readSessionView`).
 */
import * as path from 'node:path';

import { Effect, Option, Result, Schema } from 'effect';

import { type Session } from '@texra-ai/harness';
import { GlobalValues, readSessionView } from '@texra-ai/harness/host';
import { type SessionView, isLiveRun } from '@texra-ai/harness/schemas';
import {
  resolveWorkspaceStoragePath,
  WORKSPACE_STORES,
} from '@texra-ai/harness/node';

import type { TaskSummary } from './protocol';

/** The newest tasks `tasks.list` returns, live ones always included. */
const TASK_LIST_LIMIT = 200;

/** A `workspace-store` record: the folder a storage directory serves. */
const WorkspaceStoreSchema = Schema.Struct({
  root: Schema.String.check(Schema.isMinLength(1)),
});

/** The top-level tasks one view holds, as the list states them. */
function summaries(view: SessionView, workspace: string): TaskSummary[] {
  return [...view.runs.values()]
    .filter((run) => run.parentId === null)
    .map((run) => ({
      workspace,
      runId: run.id,
      label: run.label,
      description: run.description,
      statusKey: run.statusKey,
      launchedAt: run.launchedAt,
      live: run.ownedHere && isLiveRun(run),
    }));
}

/**
 * Every project's top-level tasks, newest first. `open` holds the sessions
 * the service has open, by storage root; a project whose store cannot be
 * read is reported and left out, so one damaged store never hides the rest.
 * `all` returns every task; otherwise the newest 200, live ones always kept.
 */
export const listTasks = Effect.fn('taskList.listTasks')(function* (
  storageRoot: string,
  open: ReadonlyMap<string, Session>,
  all: boolean,
) {
  const records = yield* (yield* GlobalValues).list(WORKSPACE_STORES);
  // A record is keyed by its storage directory's name, beside the store of
  // no workspace.
  const stores = path.dirname(
    resolveWorkspaceStoragePath(storageRoot, undefined),
  );
  const tasks: TaskSummary[] = [];
  for (const record of records) {
    const parsed = Schema.decodeUnknownResult(WorkspaceStoreSchema)(
      record.value,
    );
    if (!Result.isSuccess(parsed)) {
      yield* Effect.logWarning(
        `Skipping the workspace-store record ${record.key}: it names no folder`,
      );
      continue;
    }
    const workspace = parsed.success.root;
    const storage = path.join(stores, record.key);
    const session = open.get(storage);
    if (session !== undefined) {
      tasks.push(...summaries(session.view.current(), workspace));
      continue;
    }
    // One project's read, isolated whole: a store that cannot be opened or
    // replayed (a defect included) is reported and left out.
    const view = yield* readSessionView(storage).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Leaving ${workspace} out of the task list: its store could not be read`,
          cause,
        ).pipe(Effect.as(Option.none<SessionView>())),
      ),
    );
    if (Option.isSome(view)) tasks.push(...summaries(view.value, workspace));
  }
  const newest = tasks.toSorted((a, b) => b.launchedAt - a.launchedAt);
  if (all) return newest;
  const live = newest.filter((task) => task.live);
  // Every live task is kept past the limit; the list stays newest first.
  const kept = new Set([
    ...live,
    ...newest.slice(0, Math.max(0, TASK_LIST_LIMIT - live.length)),
  ]);
  return newest.filter((task) => kept.has(task));
});
