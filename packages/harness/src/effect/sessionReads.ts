/**
 * What a {@link LocalSession} reads over its owner's handle, in the public
 * vocabulary: its view (levels, a fold reader's inputs, a cold fold, the
 * display rows), one run's committed records, the runs this process holds,
 * the user's run listing and its deletion, and the notices it presents. No
 * row type the run history keeps private and no store facet leaves here.
 */
import { Context, Effect, Stream, SubscriptionRef } from 'effect';

import type { ExportNode } from '@agent/export/schemas';
import { Interactions } from '@agent/runtime/HostInteractions';
import { SessionRequests } from '@agent/runtime/requests';
import { Runs } from '@agent/runtime/runRegistry';
import type { LiveRun } from '@agent/runtime/runs';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import {
  checkpointRefusal,
  deriveResumability,
} from '@agent/storage/resumability';
import { listRuns } from '@agent/storage/runListing';
import { getRunRecords } from '@agent/storage/runOwnership';
import { listRunWorkspaceFiles } from '@agent/storage/runWorkspaceFiles';
import { SessionRoots } from '@platform/rootedFs';
import {
  type ResumeRefusal,
  type RunEnd,
  type RunId,
  type RunResult,
  type RunWorkspaceFile,
  type TranscriptSubscription,
  type AgentConfig,
} from '@shared/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import type { RequestError } from '@shared/session/runtimeRequest';
import { readCompletedRunConversation } from '@transcript/completedRunArchive';
import {
  assembleTrace,
  type AssembleTraceResult,
} from '@transcript/traceAssembler';

import type { LocalSession } from './sessions.js';

/**
 * One run's committed records (`Session.records`), read from the session's
 * store as of each call. A run that never existed or was removed reads as
 * absent: no config, no end, nothing to resume. A read fails with the
 * store's error, or, on a session another process holds, with why that
 * process did not answer.
 */
export interface RunRecords {
  /** Its `run.start` is still listed. */
  readonly exists: Effect.Effect<boolean, Error>;
  /** Its saved setup; null for a run that saved none (not an agent's). */
  readonly readConfig: Effect.Effect<AgentConfig | null, Error>;
  /** The report its agent wrote, or null. */
  readonly readReport: Effect.Effect<string | null, Error>;
  /** Its terminal fact (outcome, error, output, usage), or null while it
   *  has not ended. */
  readonly readRunEnd: Effect.Effect<RunEnd | null, Error>;
  /** Its result as delivered: the terminal fact with the output its
   *  delivery reported, or a background command's own record. */
  readonly readResult: Effect.Effect<RunResult | null, Error>;
  /** The workspace files its settled calls edited that are still there,
   *  under its working directory, by path. */
  readonly readWorkspaceFiles: Effect.Effect<
    readonly RunWorkspaceFile[],
    Error
  >;
  /** The skills its latest step listed. */
  readonly readSkills: Effect.Effect<readonly string[], Error>;
  /** Its rows hold a point it continues from, ownership aside; rows that
   *  cannot be read (logged) hold none. */
  readonly readResumable: Effect.Effect<boolean, Error>;
  /** Why a resume of it here is refused before its agent is checked
   *  (`finished`, `earlierBuild`, `unusableCheckpoint` or
   *  `pluginUnavailable`), or null when it may go ahead; a fact that could
   *  not be read right now fails. */
  readonly readRejection: Effect.Effect<ResumeRefusal | null, Error>;
  /** Its conversation as every conversation view renders it. */
  readonly readConversation: Effect.Effect<readonly ExportNode[], Error>;
  /** Its exported trace: its display rows and its record. */
  readonly readTrace: Effect.Effect<AssembleTraceResult, Error>;
}

/** What this process holds of one run ({@link LocalSession.held}): a launch
 *  of it in flight here; a run with none has no record. */
export interface HeldRun {
  readonly runId: RunId;
  /** Resolves once every owner of it here has left. */
  readonly drained: Effect.Effect<void>;
  /** Why its running loop would refuse to switch to `model`; undefined
   *  when it would not, or when no loop of it runs here. */
  readonly modelSwitchDisabledReason: (
    model: string,
  ) => Effect.Effect<string | undefined, Error>;
}

/** What `Session.deleteRuns` did with the runs it was asked for. */
export interface RunDeletion {
  /** How many listed runs the target named. */
  readonly listed: number;
  readonly deleted: readonly RunId[];
  /** Held by a live owner: left as is. */
  readonly active: readonly RunId[];
  readonly failed: readonly {
    readonly runId: RunId;
    readonly error: RequestError;
  }[];
}

const heldRun = (run: LiveRun): HeldRun => ({
  runId: run.runId,
  drained: run.drained,
  modelSwitchDisabledReason: (model) =>
    run.controls?.modelSwitchDisabledReason(model) ?? Effect.succeed(undefined),
});

/** The runs `runs` holds here: one, or all. */
function heldRuns(runs: Runs['Service']): LocalSession['held'] {
  function held(runId: RunId): HeldRun | undefined;
  function held(): readonly HeldRun[];
  function held(runId?: RunId): HeldRun | undefined | readonly HeldRun[] {
    if (runId === undefined) return runs.get().map(heldRun);
    const run = runs.get(runId);
    return run && heldRun(run);
  }
  return held;
}

/**
 * Delete what `target` names among the runs the store lists, each by its
 * `run.delete` request: a run held here is left as is, and the removal's
 * transaction refuses one whose start changed since its admission.
 */
const deleteRuns =
  (session: Context.Context<SessionServices>): LocalSession['deleteRuns'] =>
  (target) =>
    Effect.gen(function* () {
      // The listing as the cold view folds it: each run it still holds.
      const { runs } = yield* Context.get(session, SessionViewAccess).read([]);
      const listed = [...runs.keys()].filter(
        (runId) => target === 'all' || runId === target,
      );
      const deleted: RunId[] = [];
      const active: RunId[] = [];
      const failed: { runId: RunId; error: RequestError }[] = [];
      for (const runId of listed) {
        const removal = yield* Effect.result(
          Context.get(session, SessionRequests)
            .request({ kind: 'run.delete', runId })
            .pipe(Effect.provide(session)),
        );
        if (removal._tag === 'Success') deleted.push(runId);
        // Held here: the registry refuses it, or, while it is live, its
        // actions offer no delete.
        else if (
          removal.failure._tag === 'RunActive' ||
          removal.failure._tag === 'Rejected'
        )
          active.push(runId);
        else failed.push({ runId, error: removal.failure });
      }
      return { listed: listed.length, deleted, active, failed };
    });

/** The members of the {@link LocalSession} over `session` (its owners'
 *  services) that read it. */
export function sessionReads(
  session: Context.Context<SessionServices>,
): Pick<
  LocalSession,
  | 'storeMovedAside'
  | 'view'
  | 'records'
  | 'listRuns'
  | 'held'
  | 'deleteRuns'
  | 'emit'
  | 'settled'
> {
  const view = Context.get(session, SessionViewAccess);
  const log = Context.get(session, SessionLog);
  const interactions = Context.get(session, Interactions);
  /** Reads over this session's services. */
  const read = <A, E>(effect: Effect.Effect<A, E, SessionServices>) =>
    Effect.provide(effect, session);
  /** One subscription per reader, so no reader disturbs another's set; it
   *  leaves with the caller's scope. */
  const subscribe = (set: readonly TranscriptSubscription[]) =>
    Effect.asVoid(view.subscribe(set));
  return {
    storeMovedAside: log.movedAside,
    view: {
      current: () => SubscriptionRef.getUnsafe(view.ref),
      changes: view.changes,
      watch: (set, from) =>
        Stream.unwrap(
          Effect.as(subscribe(set), view.inputs(set, from.cursor, from.debug)),
        ),
      subscribe,
      read: view.read,
      head: log.now,
      events: log.tail,
    },
    records: (runId) => {
      const stored = getRunRecords(runId);
      return {
        exists: read(stored.exists()),
        readConfig: read(stored.readConfig()),
        readReport: read(stored.readReport()),
        readRunEnd: read(stored.readRunEnd()),
        readResult: read(stored.readResult()),
        readWorkspaceFiles: Effect.all(
          [stored.readConfig(), stored.readWorkspaceFiles()],
          {
            concurrency: 2,
          },
        ).pipe(
          Effect.flatMap(([config, paths]) =>
            listRunWorkspaceFiles(config, paths),
          ),
          read,
        ),
        readSkills: read(stored.readSkills()),
        readResumable: Effect.map(
          read(deriveResumability(runId)),
          (decision) => decision.kind === 'checkpoint',
        ),
        readRejection: read(checkpointRefusal(runId)),
        readConversation: read(
          readCompletedRunConversation(
            runId,
            Context.get(session, SessionRoots).config,
          ),
        ),
        readTrace: read(assembleTrace(runId)),
      };
    },
    listRuns: read(listRuns()),
    held: heldRuns(Context.get(session, Runs)),
    deleteRuns: deleteRuns(session),
    emit: interactions.emit,
    settled: log.settled,
  };
}
