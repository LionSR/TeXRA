/**
 * What a {@link LocalSession} reads over its owner's handle, in the public
 * vocabulary: its view (levels, a fold reader's inputs, a cold fold, the
 * display rows), one run's committed records, the runs this process holds,
 * the user's run listing and its deletion, and the notices it presents. No
 * row type the run history keeps private, no store facet and no claim leaves
 * here.
 */
import { Effect, type PlatformError, Stream, SubscriptionRef } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExportNode } from '@agent/export/schemas';
import type { LiveRun } from '@agent/runtime/runs';
import {
  runRejection,
  type RunRejection,
} from '@agent/runtime/runClassification';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { deriveResumability } from '@agent/storage/resumability';
import { listRuns } from '@agent/storage/runListing';
import { getRunRecords, type RunResult } from '@agent/storage/runRecords';
import {
  listRunWorkspaceFiles,
  type RunWorkspaceFile,
} from '@agent/storage/runWorkspaceFiles';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateTarget,
  type RunEnd,
  type RunId,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { RequestError } from '@shared/session/runtimeRequest';
import { readCompletedRunConversation } from '@transcript/completedRunArchive';
import {
  assembleTrace,
  type AssembleTraceResult,
} from '@transcript/traceAssembler';

import type { LocalSession } from './sessions.js';

const CHANNEL = 'sessionReads';

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
  /** A model call's failure stopped its turn, and nothing retired it. */
  readonly readModelFailed: () => Effect.Effect<boolean, DatabaseReadFailed>;
  /** Its rows hold a point it continues from, ownership aside; rows that
   *  cannot be read (logged) hold none. */
  readonly readResumable: () => Effect.Effect<boolean>;
  /** Why a resume of it here is rejected, or null when it may go ahead. */
  readonly readRejection: () => Effect.Effect<RunRejection | null, Error>;
  /** Its conversation as every conversation view renders it. */
  readonly readConversation: () => Effect.Effect<ExportNode[], Error>;
  /** Its exported trace: its display rows and its record. */
  readonly readTrace: () => Effect.Effect<AssembleTraceResult, Error>;
}

/** What this process holds of one run ({@link LocalSession.held}). */
export interface HeldRun {
  readonly runId: RunId;
  /** A generation of it is live here: its fiber, a hold, or a launch. */
  readonly live: boolean;
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
  live: run.live,
  drained: run.drained,
  modelSwitchDisabledReason: (model) =>
    run.controls?.modelSwitchDisabledReason(model) ?? Effect.succeed(undefined),
});

/** The runs `handle` holds here: one, or all. */
function heldRuns(handle: SessionHandle): LocalSession['held'] {
  function held(runId: RunId): HeldRun | undefined;
  function held(): readonly HeldRun[];
  function held(runId?: RunId): HeldRun | undefined | readonly HeldRun[] {
    if (runId === undefined) return handle.runs.get().map(heldRun);
    const run = handle.runs.get(runId);
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
  (handle: SessionHandle): LocalSession['deleteRuns'] =>
  (target) =>
    Effect.gen(function* () {
      const rows = yield* Stream.runCollect(handle.log.listing());
      const removed = new Set(
        rows.flatMap((row) =>
          row.type === 'run.removed' ? [row.aggregateId] : [],
        ),
      );
      const starts = rows.filter(
        (row) => row.type === 'run.start' && !removed.has(row.aggregateId),
      );
      const listed = starts.flatMap((row) => {
        const run = aggregateTarget(row.aggregateId);
        return run.kind === 'run' && (target === 'all' || run.id === target)
          ? [{ runId: run.id, commit: row.commit }]
          : [];
      });
      // A `run.start` opens a run aggregate: one on any other is a damaged
      // listing, said rather than skipped.
      const strays = starts.filter(
        (row) => aggregateTarget(row.aggregateId).kind !== 'run',
      );
      if (strays.length > 0)
        yield* Effect.logWarning(
          `The run listing holds a run.start on a non-run aggregate: ${strays.map((row) => row.aggregateId).join(', ')}`,
        ).pipe(withLogChannel(CHANNEL));
      // One at a time, as before; each list keeps the listing's order.
      const [deleted, refused] = yield* Effect.partition(
        listed,
        ({ runId, commit }) =>
          handle.requests
            .removeRun(runId, target === 'all' ? 'bulk' : 'single', commit)
            .pipe(
              Effect.as(runId),
              Effect.mapError((error) => ({ runId, error })),
            ),
      );
      const active = refused
        .filter(({ error }) => error._tag === 'NotOwner')
        .map(({ runId }) => runId);
      const failed = refused.filter(({ error }) => error._tag !== 'NotOwner');
      return { listed: listed.length, deleted, active, failed };
    });

/** The members of the {@link LocalSession} over `handle` that read it. */
export function sessionReads(
  handle: SessionHandle,
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
  /** One reader port per subscription, so no reader disturbs another's
   *  set; the port leaves with the caller's scope. */
  const subscribe = (set: readonly TranscriptSubscription[]) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        const port = `sdk/reader/${(readerPorts += 1)}`;
        return Effect.as(handle.view.subscribe(port, set), port);
      }),
      (port) => handle.view.subscribe(port, []),
    ).pipe(Effect.asVoid);
  return {
    storeMovedAside: handle.log.movedAside,
    view: {
      current: () => SubscriptionRef.getUnsafe(handle.view.ref),
      changes: handle.view.changes,
      watch: (set, from) =>
        Stream.unwrap(
          Effect.as(
            subscribe(set),
            handle.view.inputs(set, from.cursor, from.debug),
          ),
        ),
      subscribe,
      read: handle.view.read,
      head: handle.log.now,
      events: handle.log.tail,
    },
    records: (runId) => {
      const stored = getRunRecords(handle, runId);
      return {
        exists: stored.exists,
        readConfig: stored.readConfig,
        readReport: stored.readReport,
        readRunEnd: stored.readRunEnd,
        readResult: stored.readResult,
        readWorkspaceFiles: () =>
          Effect.all([stored.readConfig(), stored.readWorkspaceFiles()]).pipe(
            Effect.flatMap(([config, paths]) =>
              listRunWorkspaceFiles(config, paths),
            ),
          ),
        readSkills: stored.readSkills,
        readModelFailed: stored.readModelFailed,
        readResumable: () =>
          Effect.map(
            deriveResumability(runId, handle),
            (decision) => decision.kind === 'checkpoint',
          ),
        readRejection: () => runRejection(runId, handle),
        readConversation: () => readCompletedRunConversation(runId, handle),
        readTrace: () => assembleTrace(runId, handle),
      };
    },
    listRuns: () => listRuns(handle),
    held: heldRuns(handle),
    deleteRuns: deleteRuns(handle),
    // Bound: the session's presentation owner keeps its attachments.
    emit: handle.interactions.emit.bind(handle.interactions),
    settled: handle.log.settled,
  };
}
