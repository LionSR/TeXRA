/**
 * What a {@link LocalSession} reads over its owner's handle, in the public
 * vocabulary: its view (levels, a fold reader's inputs, a cold fold, the
 * display rows), one run's committed records, the runs this process holds,
 * the user's run listing and its deletion, and the notices it presents. No
 * row type the run history keeps private, no store facet and no claim leaves
 * here.
 */
import {
  Context,
  Effect,
  type PlatformError,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExportNode } from '@agent/export/schemas';
import { Interactions } from '@agent/runtime/HostInteractions';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import { Runs } from '@agent/runtime/runRegistry';
import type { LiveRun } from '@agent/runtime/runs';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { deriveResumability, runRejection } from '@agent/storage/resumability';
import { listRuns } from '@agent/storage/runListing';
import { getRunRecords, type RunResult } from '@agent/storage/runRecords';
import {
  listRunWorkspaceFiles,
  type RunWorkspaceFile,
} from '@agent/storage/runWorkspaceFiles';
import { SessionRoots } from '@platform/rootedFs';
import {
  type ResumeRefusal,
  type RunEnd,
  type RunId,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import type { RequestError } from '@shared/session/runtimeRequest';
import { readCompletedRunConversation } from '@transcript/completedRunArchive';
import {
  assembleTrace,
  type AssembleTraceResult,
} from '@transcript/traceAssembler';

import type { LocalSession } from './sessions.js';

/**
 * One run's committed records ({@link LocalSession.records}), read from the
 * session's store as of each call. A run that never existed or was removed
 * reads as absent: no config, no end, nothing to resume.
 */
export interface RunRecords {
  /** Its `run.start` is still listed. */
  readonly exists: () => Effect.Effect<boolean, DatabaseReadFailed>;
  /** Its saved setup; null for a run that saved none (not an agent's). */
  readonly readConfig: () => Effect.Effect<
    AgentConfig | null,
    DatabaseReadFailed
  >;
  /** The report its agent wrote, or null. */
  readonly readReport: () => Effect.Effect<string | null, DatabaseReadFailed>;
  /** Its terminal fact (outcome, error, output, usage), or null while it
   *  has not ended. */
  readonly readRunEnd: () => Effect.Effect<RunEnd | null, DatabaseReadFailed>;
  /** Its result as delivered: the terminal fact with the output its
   *  delivery reported, or a background command's own record. */
  readonly readResult: () => Effect.Effect<
    RunResult | null,
    DatabaseReadFailed
  >;
  /** The workspace files its settled calls edited that are still there,
   *  under its working directory, by path. */
  readonly readWorkspaceFiles: () => Effect.Effect<
    RunWorkspaceFile[],
    DatabaseReadFailed | PlatformError.PlatformError
  >;
  /** The skills its latest step listed. */
  readonly readSkills: () => Effect.Effect<
    readonly string[],
    DatabaseReadFailed
  >;
  /** Its rows hold a point it continues from, ownership aside; rows that
   *  cannot be read (logged) hold none. */
  readonly readResumable: () => Effect.Effect<boolean>;
  /** Why a resume of it here is refused before its agent is checked
   *  (`finished`, `ownedElsewhere`, `earlierBuild` or `pluginUnavailable`),
   *  or null when it may go ahead; a fact that cannot be read fails. */
  readonly readRejection: () => Effect.Effect<ResumeRefusal | null, Error>;
  /** Its conversation as every conversation view renders it. */
  readonly readConversation: () => Effect.Effect<ExportNode[], Error>;
  /** Its exported trace: its display rows and its record. */
  readonly readTrace: () => Effect.Effect<AssembleTraceResult, Error>;
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

/** What {@link LocalSession.deleteRuns} did with the runs it was asked for. */
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

/** The reader ports handed out so far (`subscribe`). */
let readerPorts = 0;

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
 * Delete what `target` names among the runs the store lists, each through
 * the registry's inactive-run step and its claim, as of the commit that
 * listed it: a run that changed since is refused rather than deleted.
 */
const deleteRuns =
  (session: Context.Context<SessionServices>): LocalSession['deleteRuns'] =>
  (target) =>
    Effect.gen(function* () {
      // The listing as the cold view folds it: each run it still holds, at
      // the commit of its `run.start`.
      const { runs } = yield* Context.get(session, SessionViewAccess).read([]);
      const listed = [...runs.values()].flatMap((run) =>
        target === 'all' || run.id === target
          ? [{ runId: run.id, commit: run.createdAt }]
          : [],
      );
      const deleted: RunId[] = [];
      const active: RunId[] = [];
      const failed: { runId: RunId; error: RequestError }[] = [];
      for (const { runId, commit } of listed) {
        const removal = yield* Effect.result(
          Context.get(session, SessionRequests)
            .removeRun(runId, target === 'all' ? 'bulk' : 'single', commit)
            .pipe(Effect.provide(session)),
        );
        if (removal._tag === 'Success') deleted.push(runId);
        else if (removal.failure._tag === 'NotOwner') active.push(runId);
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
  /** One reader port per subscription, so no reader disturbs another's
   *  set; the port leaves with the caller's scope. */
  const subscribe = (set: readonly TranscriptSubscription[]) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        const port = `sdk/reader/${(readerPorts += 1)}`;
        return Effect.as(view.subscribe(port, set), port);
      }),
      (port) => view.subscribe(port, []),
    ).pipe(Effect.asVoid);
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
        exists: () => read(stored.exists()),
        readConfig: () => read(stored.readConfig()),
        readReport: () => read(stored.readReport()),
        readRunEnd: () => read(stored.readRunEnd()),
        readResult: () => read(stored.readResult()),
        readWorkspaceFiles: () =>
          Effect.all([stored.readConfig(), stored.readWorkspaceFiles()], {
            concurrency: 2,
          }).pipe(
            Effect.flatMap(([config, paths]) =>
              listRunWorkspaceFiles(config, paths),
            ),
            read,
          ),
        readSkills: () => read(stored.readSkills()),
        readResumable: () =>
          Effect.map(
            read(deriveResumability(runId)),
            (decision) => decision.kind === 'checkpoint',
          ),
        readRejection: () => read(runRejection(runId)),
        readConversation: () =>
          read(
            readCompletedRunConversation(
              runId,
              Context.get(session, SessionRoots).config,
            ),
          ),
        readTrace: () => read(assembleTrace(runId)),
      };
    },
    listRuns: () => read(listRuns()),
    held: heldRuns(Context.get(session, Runs)),
    deleteRuns: deleteRuns(session),
    // Bound: the session's presentation owner keeps its attachments.
    emit: interactions.emit.bind(interactions),
    settled: log.settled,
  };
}
