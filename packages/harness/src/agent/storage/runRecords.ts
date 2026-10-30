/** A run's named records (`run.config`, `run.report`, `run.result`, ...),
 *  its terminal fact, its parent edge and the children its calls own, and
 *  the child loop's turn bookkeeping: database reads of committed rows. */

import { Effect, Result, Schema } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runHistoryRows } from '@agent/runtime/storedTurn';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { DatabaseReadFailed } from '@shared/session/database';
import { attemptOf } from '@shared/session/inFlight';
import { unloadable } from '@shared/session/runHistory';
import { applyRunRows, type RunState } from '@shared/session/runState';
import { RUN_ROW_READS, runRowsFrom } from '@shared/session/runRows';
import type { RunRows } from '@shared/session/runRowsShape';
import { lastLifecycleRow, runEndFromEvents } from '@shared/session/runFacts';
import {
  type CommitOrdinal,
  EMPTY_RUN_USAGE_TOTALS,
  qualifyAggregateId,
  emptyRunEndOutput,
  isTaskConfig,
  sumRunUsageTotals,
  RunWorkspaceFilesSchema,
  type ResultMeta,
  type RunEnd,
  type RunOutcome,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';
import { deriveRunId } from '@utils/core/idHash';

/** The run's child turns, folded from its `child.turn` rows. */
export const readChildTurnState = (
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<RunRows['childTurn'], DatabaseReadFailed> =>
  session.log
    .rows(qualifyAggregateId('run', runId), RUN_ROW_READS.turns)
    .pipe(Effect.map((rows) => runRowsFrom(rows).childTurn));

/**
 * A run's persisted parent (`run.start.parent`, less a `run.detach` or an
 * unlisted parent), read cold from the runs' records so a read racing the
 * live fold's first replay still sees it. Every resume takes its lineage
 * from here, never from its caller, who has no parent to name for a run that
 * already started once.
 */
export const persistedParentRunId = Effect.fn('persistedParentRunId')(
  function* (session: SessionHandle, runId: RunId) {
    const parent = (yield* parentEdge(session, runId))?.id;
    if (parent === undefined) return undefined;
    return (yield* getRunRecords(session, parent).exists())
      ? parent
      : undefined;
  },
);

const parentEdge = Effect.fn('parentEdge')(function* (
  session: SessionHandle,
  runId: RunId,
) {
  return (yield* session.log.facts(runId))?.parent ?? null;
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
export const owningCall = Effect.fn('owningCall')(function* (
  session: SessionHandle,
  runId: RunId,
) {
  const edge = yield* parentEdge(session, runId);
  if (edge?.call == null) return null;
  const { id } = edge;
  const { callId } = edge.call;
  const children = openCallChildren(id, yield* session.runHistory.load(id)).get(
    callId,
  );
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
  session: SessionHandle,
  runId: RunId,
) {
  const history = yield* session.runHistory
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
      ? [...(yield* session.view.read([])).runs.values()].flatMap((child) =>
          child.launchParentId === runId ? [[null, child.id] as const] : [],
        )
      : [...openCallChildren(runId, history)].flatMap(([callId, children]) =>
          children.map((child) => [callId, child] as const),
        );
  const open: { readonly runId: RunId; readonly callId: string }[] = [];
  for (const [callId, child] of named) {
    // Its edge and its end; a damaged child fails alone, loudly.
    const read = yield* Effect.result(session.log.facts(child));
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
 * The public value of one run's result endpoint (`readResult`): the run's
 * terminal result with the output as its delivery reported it, or a
 * background command's own record. The terminal fields are absent while the
 * run has not ended.
 */
export type RunResult =
  | Extract<ResultMeta, { producer: 'backgroundBash' }>
  | (Omit<RunEnd, 'outcome'> & { readonly outcome?: RunOutcome });

/**
 * The terminal result of the lifecycle `rows` end with: its `run.end`'s
 * outcome, error and output, and the usage its activation spent, from its
 * own `run.activate` on (a recipe's with its children's then); none with
 * no end. An unreadable fold is logged and reads as no usage.
 */
const runEndOf = (
  session: SessionHandle,
  runId: RunId,
  held: RunRows,
  rows: readonly SessionEvent[],
): Effect.Effect<RunEnd | null, DatabaseReadFailed> =>
  Effect.gen(function* () {
    const end = runEndFromEvents(rows, runId);
    if (!end) return null;
    // The activation's own rows begin at the lifecycle row before its end
    // (its `run.activate`), or with the run.
    const start = lastLifecycleRow(
      rows.filter((row) => row.seq < end.seq),
      runId,
    );
    const from = start?.seq ?? -1;
    // One read of the rows, so a resume never pairs the end with another
    // activation's totals: the state before the activation, its usage
    // zeroed, then the activation's rows.
    const folded = Result.flatMap(
      runHistoryRows(rows.filter((row) => row.seq <= end.seq)),
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
    const own = Result.isSuccess(folded) ? folded.success?.usage : undefined;
    // A document task's revisions are its children's runs, which hold
    // what it cost: those this activation started, each as it had ended
    // by this end, whatever a later resume of it spent.
    const children =
      held.config && isTaskConfig(held.config)
        ? yield* Effect.forEach(
            session.view.run(runId)?.childIds ?? [],
            (child) =>
              Effect.flatMap(session.log.facts(child), (facts) => {
                const born = facts?.start?.commit ?? -1;
                const late = born > end.commit;
                if (facts === null || born <= (start?.commit ?? -1) || late)
                  return Effect.succeed(null);
                return Effect.flatMap(
                  session.log.rows(qualifyAggregateId('run', child)),
                  (rows) =>
                    runEndOf(
                      session,
                      child,
                      facts,
                      rows.filter((row) => row.commit <= end.commit),
                    ),
                );
              }),
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
export function getRunRecords(session: SessionHandle, runId: RunId) {
  const id = qualifyAggregateId('run', runId);
  const facts = session.log.facts(runId);
  /** The run's facts and every row of it, in one read; none for a run the
   *  store does not hold open, which the record reads report as absent too. */
  const whole = Effect.flatMap(facts, (held) =>
    held === null
      ? Effect.succeed(null)
      : Effect.map(session.log.rows(id), (rows) => ({ held, rows })),
  );
  const read = <A>(
    select: (facts: RunRows | null) => A,
  ): Effect.Effect<A, DatabaseReadFailed> => Effect.map(facts, select);
  /** The run's folded state, or null with no run history. A run whose rows
   *  this build cannot fold is a failed read of that run, never a refusal
   *  of the caller's own writes. */
  const folded = session.runHistory.load(runId).pipe(
    Effect.catchTag('RunHistoryRefused', (refused) =>
      Effect.fail(
        new DatabaseReadFailed({
          path: session.roots.storage,
          cause: refused,
        }),
      ),
    ),
  );
  /** The latest `run.config` row; the database reads a closed run as absent. */
  const readRecord = (): Effect.Effect<RunRecord | null, DatabaseReadFailed> =>
    read((held) => held?.config ?? null);
  return {
    /** The run has a `run.start` the database still lists: absent, or
     *  closed by its tombstone, reads false. */
    exists: (): Effect.Effect<boolean, DatabaseReadFailed> =>
      read((held) => held !== null),
    readRunRecord: readRecord,
    readConfig: (): Effect.Effect<AgentConfig | null, DatabaseReadFailed> =>
      readRecord().pipe(
        Effect.map((record) =>
          record && isAgentRunRecord(record) ? record : null,
        ),
      ),
    readReport: (): Effect.Effect<string | null, DatabaseReadFailed> =>
      read((held) => held?.report ?? null),
    /** The workspace files the run edited, folded from its settled calls
     *  (`RunState.edited`). A run with no run history edited nothing here. */
    readWorkspaceFiles: (): Effect.Effect<
      readonly string[],
      DatabaseReadFailed
    > =>
      Effect.map(folded, (state) =>
        Schema.decodeUnknownSync(RunWorkspaceFilesSchema)(state?.edited ?? []),
      ),
    /** The skills the run's latest `tools.offered` row listed. */
    readSkills: (): Effect.Effect<readonly string[], DatabaseReadFailed> =>
      Effect.map(folded, (state) => state?.offeredWith.skills ?? []),
    /** A model failure stopped the run's turn (its folded `lastError`). */
    readModelFailed: (): Effect.Effect<boolean, DatabaseReadFailed> =>
      Effect.map(folded, (state) => state?.lastError != null),
    readResultMeta: (): Effect.Effect<ResultMeta | null, DatabaseReadFailed> =>
      read((held) => held?.result ?? null),
    /** The run's terminal result ({@link runEndOf}), or null while the
     *  lifecycle it is in has not ended; `after` an activation's commit, the
     *  end of that activation, whatever later ones wrote. */
    readRunEnd: (
      after?: CommitOrdinal,
    ): Effect.Effect<RunEnd | null, DatabaseReadFailed> =>
      Effect.flatMap(whole, (run) => {
        if (run === null) return Effect.succeed(null);
        if (after === undefined)
          return runEndOf(session, runId, run.held, run.rows);
        // Its end, or none if the next activation comes first.
        const end = run.rows.findIndex(
          (row) =>
            row.commit > after && lastLifecycleRow([row], runId) !== undefined,
        );
        return runEndOf(
          session,
          runId,
          run.held,
          end < 0 ? [] : run.rows.slice(0, end + 1),
        );
      }),
    /** The run's result: its producer record joined to its terminal result,
     *  the output as delivered (the subagent's reply, which only its record
     *  holds, over the run's own output). A background
     *  command's record is its own result, and an ended recipe's run (whose
     *  value is its result) needs none. Null otherwise with no record. */
    readResult: Effect.fn('runRecords.readResult')(
      function* (): Effect.fn.Return<RunResult | null, DatabaseReadFailed> {
        const run = yield* whole;
        const meta = run?.held.result ?? null;
        if (run === null || meta?.producer === 'backgroundBash') return meta;
        if (meta === null) {
          const { config } = run.held;
          return config && isTaskConfig(config)
            ? yield* runEndOf(session, runId, run.held, run.rows)
            : null;
        }
        const end = yield* runEndOf(session, runId, run.held, run.rows);
        return {
          ...(end ?? {}),
          output: { ...(end?.output ?? emptyRunEndOutput()), ...meta.output },
        };
      },
    ),
  };
}
