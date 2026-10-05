/**
 * `tasks.list`: the top-level tasks of every project under the storage
 * root. The projects are the `workspace-store` records each host writes when
 * it opens a project (the storage design's §7), so the scan adds no table. A
 * project the service has open answers from its live view; any other is
 * read cold: its listing replayed through the session's own input reader
 * and folded once, with the owners its unfinished runs name probed for
 * liveness the way an open session's prober does.
 */
import * as path from 'node:path';

import {
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  RcMap,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import {
  LocalRuntimeSource,
  TextChunkSource,
} from '@controllers/session/sessionSources';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import { resolveWorkspaceStoragePath } from '@platform/defaults/workspaceStorage';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import {
  ownerIdentity,
  type LocalRuntimeState,
  type OwnerId,
} from '@shared/schemas';
import {
  Database,
  type DatabaseReadFailed,
  GlobalDatabase,
  ProjectDatabases,
} from '@shared/session/database';
import { WORKSPACE_STORES } from '@shared/session/valueFamily';
import { fold } from '@shared/session/sessionFold';
import { SessionInputs } from '@shared/session/sessionInputs';
import {
  emptySessionView,
  isLiveRun,
  type SessionView,
} from '@shared/session/sessionView';

import type { TaskSummary } from './protocol';

/** The newest tasks `tasks.list` returns, live ones always included. */
const TASK_LIST_LIMIT = 200;

/** A `workspace-store` record: the folder a storage directory serves. */
const WorkspaceStoreSchema = z.object({ root: z.string().min(1) });

/** The top-level tasks one view holds, as the list states them. */
function summaries(view: SessionView, workspace: string): TaskSummary[] {
  return [...view.runs.values()]
    .filter((run) => run.parentId === null)
    .map((run) => ({
      workspace,
      runId: run.id,
      label: run.label,
      description: run.description,
      statusLabel: run.statusLabel,
      launchedAt: run.launchedAt,
      live: run.ownedHere && isLiveRun(run),
    }));
}

/** The owners of the unfinished runs a cold view names: the ones a probe
 *  must decide between running elsewhere and interrupted. */
function unfinishedOwners(view: SessionView): OwnerId[] {
  const owners = [...view.runs.values()].flatMap((run) =>
    run.ownerId !== null && !isTerminalOutcomePhase(run.status)
      ? [run.ownerId]
      : [],
  );
  return [...new Set(owners)].sort();
}

/** One project's view from its store alone: the listing replay, folded,
 *  then the probed owners' deaths folded beside it. */
const coldView = Effect.fn('taskList.coldView')(function* (
  database: Database['Service'],
  storage: string,
) {
  const local = yield* SubscriptionRef.make<LocalRuntimeState>({
    self: [],
    dead: [],
    unreadable: [],
    resumeBlocked: [],
  });
  const inputs = yield* SessionInputs.pipe(
    Effect.provide(
      sessionInputsLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Database)(database),
            Layer.succeed(LocalRuntimeSource)({ ref: local }),
            TextChunkSource.layer,
            Layer.succeed(WorkspaceRoots)({ storage }),
          ),
        ),
      ),
    ),
  );
  const replay = yield* Stream.runHead(inputs.read([], 0, false));
  const view = fold(
    emptySessionView(storage),
    Option.getOrElse(replay, () => []),
  );
  const dead: OwnerId[] = [];
  for (const owner of unfinishedOwners(view)) {
    if ((yield* proveOwnerLiveness(ownerIdentity(owner))) === 'dead')
      dead.push(owner);
  }
  return fold(view, {
    _tag: 'local',
    local: { self: [], dead, unreadable: [], resumeBlocked: [] },
  });
});

/**
 * Every project's top-level tasks, newest first. `open` holds the sessions
 * the service has open, by storage root; a project whose store cannot be
 * read is reported and left out, so one damaged store never hides the rest.
 * `all` returns every task; otherwise the newest 200, live ones always kept.
 */
export const listTasks = Effect.fn('taskList.listTasks')(function* (
  storageRoot: string,
  open: ReadonlyMap<string, SessionHandle>,
  all: boolean,
): Effect.fn.Return<
  TaskSummary[],
  DatabaseReadFailed | PlatformError.PlatformError,
  ProcessProbe | GlobalDatabase | ProjectDatabases
> {
  const fs = yield* FileSystem.FileSystem;
  const databases = yield* ProjectDatabases;
  const records = yield* (yield* GlobalDatabase).values.list(WORKSPACE_STORES);
  // A record is keyed by its storage directory's name, beside the store of
  // no workspace.
  const stores = path.dirname(
    resolveWorkspaceStoragePath(storageRoot, undefined),
  );
  const tasks: TaskSummary[] = [];
  for (const record of records) {
    const parsed = WorkspaceStoreSchema.safeParse(record.value);
    if (!parsed.success) {
      yield* Effect.logWarning(
        `Skipping the workspace-store record ${record.key}: it names no folder`,
      );
      continue;
    }
    const workspace = parsed.data.root;
    const storage = path.join(stores, record.key);
    const session = open.get(storage);
    if (session !== undefined) {
      tasks.push(
        ...summaries(yield* SubscriptionRef.get(session.view), workspace),
      );
      continue;
    }
    // One project's read, isolated whole: a store that cannot be opened or
    // replayed (a defect included) is reported and left out.
    const view = yield* fs.exists(path.join(storage, 'texra.db')).pipe(
      Effect.flatMap((exists) =>
        exists
          ? Effect.scoped(
              RcMap.get(databases, storage).pipe(
                Effect.flatMap((database) => coldView(database, storage)),
              ),
            )
          : Effect.succeed(null),
      ),
      Effect.map((value): SessionView | null => value),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Leaving ${workspace} out of the task list: its store could not be read`,
          cause,
        ).pipe(Effect.as(null)),
      ),
    );
    if (view !== null) tasks.push(...summaries(view, workspace));
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
