/** A run's named records (`run.config`, `run.report`, `run.result`, ...),
 *  its terminal fact, its parent edge and the children its calls own, and
 *  the child loop's turn bookkeeping: database reads of committed rows. */

import { Effect, Result, Schema } from 'effect';

import { runHistoryRows } from '@agent/runtime/storedTurn';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { SessionRoots } from '@platform/rootedFs';
import { DatabaseReadFailed } from '@shared/session/database';
import { attemptOf } from '@shared/session/inFlight';
import {
  RunHistory,
  SessionLog,
  unloadable,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { applyRunRows, type RunState } from '@shared/session/runState';
import type { RunRows } from '@shared/session/runRowsShape';
import { lastLifecycleRow, runEndFromEvents } from '@shared/session/runFacts';
import {
  addTurnUsage,
  type CommitOrdinal,
  EMPTY_RUN_USAGE_TOTALS,
  qualifyAggregateId,
  emptyRunEndOutput,
  isTaskConfig,
  sumRunUsageTotals,
  RunWorkspaceFilesSchema,
  type ResultMeta,
  type RunEnd,
  type RunResult,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';
import { deriveRunId } from '@utils/core/idHash';

/** What a read of a run's records takes from its session. */
type RecordServices =
  | SessionLog
  | SessionViewAccess
  | RunHistory
  | SessionRoots;

/** A read of a run's records, over the session services `R`. */
type RecordRead<A, R = SessionLog> = Effect.Effect<A, DatabaseReadFailed, R>;

/** The run's child turns, folded from its `child.turn` rows. */
export const readChildTurnState = (
  runId: RunId,
): RecordRead<RunRows['childTurn']> =>
  Effect.flatMap(SessionLog, (log) =>
    log.runRows(qualifyAggregateId('run', runId), 'turns'),
  ).pipe(Effect.map((rows) => rows.childTurn));

/** A run's lifecycle rows and its history, one read each. */
const rowsOf = (runId: RunId) => {
  const id = qualifyAggregateId('run', runId);
  return Effect.flatMap(SessionLog, (log) =>
    Effect.map(
      Effect.all([log.runRows(id, 'lifecycle'), log.history(id)]),
      ([rows, history]) => ({ lifecycles: rows.lifecycles, history }),
    ),
  );
};

/**
 * A run's persisted parent (`run.start.parent`, less a `run.detach` or an
 * unlisted parent), read cold from the runs' records so a read racing the
 * live fold's first replay still sees it. Every resume takes its lineage
 * from here, never from its caller, who has no parent to name for a run that
 * already started once.
 */
export const persistedParentRunId = Effect.fn('persistedParentRunId')(
  function* (runId: RunId) {
    const parent = (yield* parentEdge(runId))?.id;
    if (parent === undefined) return undefined;
    return (yield* getRunRecords(parent).exists()) ? parent : undefined;
  },
);

const parentEdge = Effect.fn('parentEdge')(function* (runId: RunId) {
  return (yield* (yield* SessionLog).facts(runId))?.parent ?? null;
});

/** The run one attempt of a parent's call launches (an `agent` child, a
 *  background script), named by its response too: call ids repeat. */
export const callChildRunId = (call: {
  readonly parentRunId: RunId;
  readonly responseId: string;
  readonly callId: string;
  readonly attempt: number;
}): RunId => deriveRunId(call);

/** The runs the attempts so far of `runId`'s open calls launched under
 *  their derived ids (they may not exist), by call: a call no attempt of
 *  which started owns none. */
const openCallChildren = (
  runId: RunId,
  state: RunState | null,
): ReadonlyMap<string, readonly RunId[]> => {
  const pending = state?.pendingResponse ?? null;
  const open = new Map<string, readonly RunId[]>();
  for (const [callId, { status }] of Object.entries(pending?.records ?? {}))
    if (pending !== null && status.kind !== 'settled')
      open.set(
        callId,
        Array.from({ length: attemptOf(status) }, (_, index) =>
          callChildRunId({
            parentRunId: runId,
            responseId: pending.responseId,
            callId,
            attempt: index + 1,
          }),
        ),
      );
  return open;
};

/** The open call that owns `runId`: the undetached parent call that
 *  launched it, unsettled in the parent's history; else null. */
export const owningCall = Effect.fn('owningCall')(function* (runId: RunId) {
  const edge = yield* parentEdge(runId);
  if (edge?.call == null) return null;
  const { id } = edge;
  const { callId } = edge.call;
  const history = yield* (yield* RunHistory).load(id);
  const children = openCallChildren(id, history).get(callId);
  // A later response may reuse the call id: the pending call owns the run
  // only when the run is named by it.
  return children?.includes(runId) === true
    ? { parentRunId: id, callId }
    : null;
});

/** The parent notice a run's end queues when its result was lost, one per
 *  lifecycle (`since`: its `run.activate`'s commit); without `since`, the
 *  prefix every lifecycle's notice shares. */
export const lostResultId = (runId: RunId, since?: number): string =>
  `${runId}:result-lost:${since ?? ''}`;

/** The unended children `runId`'s open calls own, from its history and
 *  their own rows. Unloadable, it names no calls: every child it launched
 *  (the listing's `launchParentId`) is owned, loudly. */
export const openOwnedChildren = Effect.fn('openOwnedChildren')(function* (
  runId: RunId,
) {
  const log = yield* SessionLog;
  const history = yield* (yield* RunHistory)
    .load(runId)
    .pipe(
      Effect.catchIf(unloadable, (refused) =>
        Effect.as(
          Effect.logWarning(`Run ${runId}: ${refused.message}`),
          false as const,
        ),
      ),
    );
  const named =
    history === false
      ? [...(yield* (yield* SessionViewAccess).read([])).runs.values()].flatMap(
          (child) =>
            child.launchParentId === runId ? [[null, child.id] as const] : [],
        )
      : [...openCallChildren(runId, history)].flatMap(([callId, children]) =>
          children.map((child) => [callId, child] as const),
        );
  const open: { readonly runId: RunId; readonly callId: string }[] = [];
  for (const [callId, child] of named) {
    // Its edge and its end; a damaged child fails alone, loudly.
    const read = yield* Effect.result(log.facts(child));
    if (read._tag === 'Failure') {
      yield* Effect.logWarning(
        `Child run ${child} cannot be read; its parent ${runId} treats it as failed.`,
      ).pipe(Effect.annotateLogs({ data: read.failure }));
      continue;
    }
    const edge = read.success?.parent?.call?.callId ?? null;
    if (edge !== null && (callId ?? edge) === edge)
      if (read.success?.end === null) open.push({ runId: child, callId: edge });
  }
  return open;
});

/**
 * The terminal result of the lifecycle the `lifecycles` rows end with: its
 * `run.end`'s outcome, error and output, and the usage its activation
 * spent: its `history` rows from its own `run.activate` on and its label's
 * request (a recipe's with its children's then); none with no end. An
 * unreadable fold is logged and reads as no usage.
 */
const runEndOf = Effect.fn('runEndOf')(function* (
  runId: RunId,
  held: RunRows,
  lifecycles: readonly SessionEvent[],
  history: readonly SessionEvent[],
): Effect.fn.Return<
  RunEnd | null,
  DatabaseReadFailed,
  SessionLog | SessionViewAccess
> {
  const end = runEndFromEvents(lifecycles, runId);
  if (!end) return null;
  // The activation's own rows begin at the lifecycle row before its end
  // (its `run.activate`), or with the run.
  const start = lastLifecycleRow(
    lifecycles.filter((row) => row.seq < end.seq),
    runId,
  );
  const from = start?.seq ?? -1;
  const during = (commit: CommitOrdinal) =>
    commit > (start?.commit ?? -1) && commit <= end.commit;
  // One read of the rows, so a resume never pairs the end with another
  // activation's totals: the state before the activation, its usage
  // zeroed, then the activation's rows.
  const folded = Result.flatMap(
    runHistoryRows(history.filter((row) => row.seq <= end.seq)),
    (live) =>
      Result.flatMap(
        applyRunRows(
          null,
          live.filter((row) => row.seq < from),
        ),
        (prior) =>
          applyRunRows(
            prior && { ...prior, usage: EMPTY_RUN_USAGE_TOTALS },
            live.filter((row) => row.seq >= from),
          ),
      ),
  );
  if (Result.isFailure(folded)) {
    yield* Effect.logWarning(
      'Failed to fold the run usage from its run history rows',
    ).pipe(Effect.annotateLogs({ runId, error: folded.failure.message }));
  }
  const turns = Result.isSuccess(folded) ? folded.success?.usage : undefined;
  const withLabel = ({ label }: RunRows) =>
    Result.isSuccess(folded) && during(label?.commit ?? -1) && label?.usage
      ? addTurnUsage(turns ?? EMPTY_RUN_USAGE_TOTALS, label.usage)
      : turns;
  const own = withLabel(held);
  // A document task's revisions are its children's runs, which hold
  // what it cost: those this activation started, each as it had ended
  // by this end, whatever a later resume of it spent.
  const children =
    held.config && isTaskConfig(held.config)
      ? yield* Effect.forEach(
          (yield* SessionViewAccess).run(runId)?.childIds ?? [],
          (child) =>
            Effect.flatMap(
              SessionLog.use((log) => log.facts(child)),
              (facts) => {
                if (facts === null || !during(facts.start?.commit ?? -1))
                  return Effect.succeed(null);
                const asOf = (row: SessionEvent) => row.commit <= end.commit;
                return Effect.flatMap(rowsOf(child), (rows) =>
                  runEndOf(
                    child,
                    facts,
                    rows.lifecycles.filter(asOf),
                    rows.history.filter(asOf),
                  ),
                );
              },
            ),
        )
      : null;
  const usage =
    children === null
      ? own
      : sumRunUsageTotals(
          [own, ...children.map((child) => child?.usage)].filter(
            (u) => u !== undefined,
          ),
        );
  const { outcome, error, output } = end;
  return {
    outcome,
    ...(error !== undefined ? { error } : {}),
    ...(usage !== undefined ? { usage } : {}),
    output,
  } satisfies RunEnd;
});

/** Reads of a run's named records from the session database. */
export function getRunRecords(runId: RunId) {
  const facts = SessionLog.use((log) => log.facts(runId));
  /** The run's facts, its lifecycle rows and its history; none for a run
   *  the store does not hold open, which the record reads report as absent
   *  too. */
  const whole = Effect.flatMap(facts, (held) =>
    held === null
      ? Effect.succeed(null)
      : Effect.map(rowsOf(runId), (rows) => ({ held, ...rows })),
  );
  const read = <A>(select: (facts: RunRows | null) => A): RecordRead<A> =>
    Effect.map(facts, select);
  /** The run's folded state, or null with no run history. A run whose rows
   *  this build cannot fold is a failed read of that run, never a refusal
   *  of the caller's own writes. */
  const folded = RunHistory.use((history) => history.load(runId)).pipe(
    Effect.catchTag('RunHistoryRefused', (refused) =>
      Effect.flatMap(SessionRoots, (roots) =>
        Effect.fail(
          new DatabaseReadFailed({ path: roots.storage, cause: refused }),
        ),
      ),
    ),
  );
  /** The latest `run.config` row; the database reads a closed run as absent. */
  const readRecord = (): RecordRead<RunRecord | null> =>
    read((held) => held?.config ?? null);
  return {
    /** The run has a `run.start` the database still lists: absent, or
     *  closed by its tombstone, reads false. */
    exists: (): RecordRead<boolean> => read((held) => held !== null),
    readRunRecord: readRecord,
    readConfig: (): RecordRead<AgentConfig | null> =>
      readRecord().pipe(
        Effect.map((record) =>
          record && isAgentRunRecord(record) ? record : null,
        ),
      ),
    readReport: (): RecordRead<string | null> =>
      read((held) => held?.report ?? null),
    /** The workspace files the run edited, folded from its settled calls
     *  (`RunState.edited`). A run with no run history edited nothing here. */
    readWorkspaceFiles: (): RecordRead<readonly string[], RecordServices> =>
      Effect.map(folded, (state) =>
        Schema.decodeUnknownSync(RunWorkspaceFilesSchema)(state?.edited ?? []),
      ),
    /** The skills the run's latest `tools.offered` row listed. */
    readSkills: (): RecordRead<readonly string[], RecordServices> =>
      Effect.map(folded, (state) => state?.offeredWith.skills ?? []),
    readResultMeta: (): RecordRead<ResultMeta | null> =>
      read((held) => held?.result ?? null),
    /** The run's terminal result ({@link runEndOf}), or null while the
     *  lifecycle it is in has not ended; `after` an activation's commit, the
     *  end of that activation, whatever later ones wrote. */
    readRunEnd: (
      after?: CommitOrdinal,
    ): RecordRead<RunEnd | null, RecordServices> =>
      Effect.flatMap(whole, (run) => {
        if (run === null) return Effect.succeed(null);
        const { held, lifecycles, history } = run;
        if (after === undefined)
          return runEndOf(runId, held, lifecycles, history);
        // Its end, or none if the next activation comes first.
        const end = lifecycles.findIndex((row) => row.commit > after);
        return runEndOf(
          runId,
          held,
          end < 0 ? [] : lifecycles.slice(0, end + 1),
          history,
        );
      }),
    /** The run's result: its producer record joined to its terminal result,
     *  the output as delivered (the subagent's reply, which only its record
     *  holds, over the run's own output). A background
     *  command's record is its own result, and an ended recipe's run (whose
     *  value is its result) needs none. Null otherwise with no record. */
    readResult: Effect.fn('runRecords.readResult')(
      function* (): Effect.fn.Return<
        RunResult | null,
        DatabaseReadFailed,
        RecordServices
      > {
        const run = yield* whole;
        const meta = run?.held.result ?? null;
        if (run === null || meta?.producer === 'backgroundBash') return meta;
        const { held, lifecycles, history } = run;
        if (meta === null) {
          const { config } = held;
          return config && isTaskConfig(config)
            ? yield* runEndOf(runId, held, lifecycles, history)
            : null;
        }
        const end = yield* runEndOf(runId, held, lifecycles, history);
        return {
          ...end,
          output: { ...(end?.output ?? emptyRunEndOutput()), ...meta.output },
        };
      },
    ),
  };
}
