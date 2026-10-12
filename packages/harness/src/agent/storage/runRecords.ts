/** A run's named records (`run.config`, `run.report`, `run.result`, ...),
 *  its terminal fact, its parent edge and the children its calls own, and
 *  the child loop's turn bookkeeping: database reads of committed rows. */

import { Effect, Result, Stream } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runHistoryRows } from '@agent/runtime/storedTurn';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import {
  DatabaseReadFailed,
  type DatabaseNotOwner,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import { attemptOf } from '@shared/session/inFlight';
import { unloadable } from '@shared/session/runHistory';
import { foldRunState, type RunState } from '@shared/session/runStateFold';
import { parentEdgeOf } from '@shared/session/runRelation';
import {
  ResultMetaSchema,
  storedResultMeta,
  qualifyAggregateId,
  aggregateTarget,
  emptyRunEndOutput,
  isDocumentTaskConfig,
  sumRunUsageTotals,
  type RunUsageTotals,
  RunWorkspaceFilesSchema,
  type AggregateId,
  type DeliveredResult,
  type ResultMeta,
  type RunEnd,
  type SessionEvent,
  type RunId,
} from '@shared/schemas';
import { deriveRunId } from '@utils/core/idHash';

import { deliveredOutput, type RunResult } from './resultMeta';

/** One child turn's identity: `key` names the child-run attempt that
 *  accepted it and `index` its position in that attempt. */
export interface AttemptKey {
  readonly key: string;
  readonly index: number;
}

/** Turn attribution for a child run's report/result slots: the turn
 *  running (or cut short before its delivery ran) and the latest delivered
 *  one, both null before the loop accepted a turn. */
interface ChildTurnState {
  readonly active: AttemptKey | null;
  readonly lastCompleted: AttemptKey | null;
}

/** Fold the run's `child.turn` rows: `accepted` opens a turn, `settled`
 *  closes it as the last completed (maybe an earlier attempt's). */
export function readChildTurnState(
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<ChildTurnState, DatabaseReadFailed> {
  return session.log
    .rows(qualifyAggregateId('run', runId), ['child.turn'])
    .pipe(
      Effect.map((rows) => {
        let active: AttemptKey | null = null;
        let lastCompleted: AttemptKey | null = null;
        for (const row of rows) {
          if (row.type !== 'child.turn') continue;
          const turn = { key: row.attemptId, index: row.turnIndex };
          if (row.phase !== 'settled') active = turn;
          else if (active?.key === turn.key && active.index === turn.index)
            active = null;
          if (row.phase === 'settled') lastCompleted = turn;
        }
        return { active, lastCompleted };
      }),
    );
}

/** The run's terminal fact for its current lifecycle (a `run.activate`
 *  after the last `run.end` starts one, so a resumed run never carries the
 *  outcome of one it left), or null: the scope `finalizeRun`, the row's
 *  one writer, and every reader share. */
export function runEndFromEvents(
  rows: readonly SessionEvent[],
  runId: RunId,
): Extract<SessionEvent, { type: 'run.end' }> | null {
  const id = qualifyAggregateId('run', runId);
  const lifecycle = rows.findLast(
    (row): row is Extract<SessionEvent, { type: 'run.end' | 'run.activate' }> =>
      row.aggregateId === id &&
      (row.type === 'run.end' || row.type === 'run.activate'),
  );
  return lifecycle?.type === 'run.end' ? lifecycle : null;
}

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
  return parentEdgeOf(yield* session.log.records(runId));
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

/** The open call that owns `runId` (HQ6): the undetached parent call that
 *  launched it, unsettled in the parent's history; else null. */
export const owningCall = Effect.fn('owningCall')(function* (
  session: SessionHandle,
  runId: RunId,
) {
  const edge = yield* parentEdge(session, runId);
  if (edge?.callId == null) return null;
  const { id, callId } = edge;
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
 *  their own rows. Unloadable, it names no calls: every child whose own
 *  `run.start` (the listing's row) puts it under a call is owned, loudly. */
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
      ? (yield* Stream.runCollect(session.log.listing())).flatMap((row) => {
          const child = aggregateTarget(row.aggregateId);
          return row.type === 'run.start' &&
            row.parent?.id === runId &&
            child.kind === 'run'
            ? [[null, child.id] as const]
            : [];
        })
      : [...openCallChildren(runId, history)].flatMap(([callId, children]) =>
          children.map((child) => [callId, child] as const),
        );
  const open: { readonly runId: RunId; readonly callId: string }[] = [];
  for (const [callId, child] of named) {
    // Its edge and its end; a damaged child fails alone, loudly.
    const read = yield* Effect.result(session.log.records(child));
    if (read._tag === 'Failure') {
      yield* Effect.logWarning(
        `Child run ${child} cannot be read; its parent ${runId} treats it as failed.`,
      ).pipe(Effect.annotateLogs({ data: read.failure }));
      continue;
    }
    const edge = parentEdgeOf(read.success)?.callId ?? null;
    if (edge !== null && (callId ?? edge) === edge)
      if (runEndFromEvents(read.success, child) === null)
        open.push({ runId: child, callId: edge });
  }
  return open;
});

/** The run's latest row of one type, or null: the one latest-row reader
 *  (the read keeps the newest of each type, strictly decoded). */
function latestOfType<T extends SessionEvent['type']>(
  rows: readonly SessionEvent[],
  id: AggregateId,
  type: T,
): Extract<SessionEvent, { type: T }> | null {
  return (
    rows.findLast(
      (row): row is Extract<SessionEvent, { type: T }> =>
        row.aggregateId === id && row.type === type,
    ) ?? null
  );
}

/** `end` with its run's children's spend added to its own: a document
 *  task's revisions are its children's runs, which hold what it cost. */
export const withChildSpend = <
  T extends { readonly runId: RunId; readonly usage?: RunUsageTotals },
>(
  session: SessionHandle,
  end: T,
): Effect.Effect<T & { readonly usage: RunUsageTotals }, DatabaseReadFailed> =>
  Effect.forEach(session.view.run(end.runId)?.childIds ?? [], (child) =>
    getRunRecords(session, child).readRunEnd(),
  ).pipe(
    Effect.map((ends) => ({
      ...end,
      usage: sumRunUsageTotals(
        [end.usage, ...ends.map((child) => child?.usage)].filter(
          (u) => u !== undefined,
        ),
      ),
    })),
  );

/** Native access to named run metadata, with no file-backed read arm. */
export function getRunRecords(session: SessionHandle, runId: RunId) {
  const id = qualifyAggregateId('run', runId);
  /**
   * The run's terminal result: the `run.end` row's outcome, error and
   * output, and the usage its run history folds from its priced response
   * rows (a document task's: its revisions', {@link withChildSpend}); none
   * for a run without one; an unreadable one is logged and reads the same,
   * so it never also costs the run its terminal fact.
   */
  const runEndOf = (rows: readonly SessionEvent[]) =>
    Effect.gen(function* () {
      const end = runEndFromEvents(rows, runId);
      if (!end) return null;
      // The usage is folded from these same rows: one read, so a resume
      // can never pair the end and the totals across two.
      const folded = Result.flatMap(runHistoryRows(rows), (live) =>
        foldRunState(null, live),
      );
      if (Result.isFailure(folded)) {
        yield* Effect.logWarning(
          'Failed to fold the run usage from its run history rows',
        ).pipe(Effect.annotateLogs({ runId, error: folded.failure.message }));
      }
      const own = Result.isSuccess(folded) ? folded.success?.usage : undefined;
      const config = latestOfType(rows, id, 'run.config')?.config;
      const usage =
        config && isDocumentTaskConfig(config)
          ? (yield* withChildSpend(session, { runId, usage: own })).usage
          : own;
      const { outcome, error, output } = end;
      return {
        outcome,
        ...(error !== undefined ? { error } : {}),
        ...(usage !== undefined ? { usage } : {}),
        output,
      } satisfies RunEnd;
    });
  /** Every row of the run, in one read; none for a closed (tombstoned) run,
   *  which the record reads report as absent too. */
  const runRows = session.log
    .rows(id)
    .pipe(
      Effect.map((rows) => (rows.at(-1)?.type === 'run.removed' ? [] : rows)),
    );
  const read = <A>(
    select: (rows: readonly SessionEvent[]) => A,
  ): Effect.Effect<A, DatabaseReadFailed> =>
    session.log.records(runId).pipe(Effect.map(select));
  /** The latest `run.config` row; the database reads a closed run as absent. */
  const readRecord = (): Effect.Effect<RunRecord | null, DatabaseReadFailed> =>
    read((rows) => latestOfType(rows, id, 'run.config')?.config ?? null);
  return {
    /** The run has a `run.start` the database still lists: absent, or
     *  closed by its tombstone, reads false. */
    exists: (): Effect.Effect<boolean, DatabaseReadFailed> =>
      read((rows) =>
        rows.some((row) => row.aggregateId === id && row.type === 'run.start'),
      ),
    readRunRecord: readRecord,
    readConfig: (): Effect.Effect<AgentConfig | null, DatabaseReadFailed> =>
      readRecord().pipe(
        Effect.map((record) =>
          record && isAgentRunRecord(record) ? record : null,
        ),
      ),
    readReport: (): Effect.Effect<string | null, DatabaseReadFailed> =>
      read((rows) => latestOfType(rows, id, 'run.report')?.report ?? null),
    /**
     * The workspace files the run edited, folded from its settled calls
     * (`RunState.edited`). A run with no run history edited nothing here.
     * A run whose rows this build cannot fold is a failed read of that run,
     * never a refusal of the caller's own writes.
     */
    readWorkspaceFiles: (): Effect.Effect<string[], DatabaseReadFailed> =>
      session.runHistory.load(runId).pipe(
        Effect.map((state) =>
          RunWorkspaceFilesSchema.parse(state?.edited ?? []),
        ),
        Effect.catchTag('RunHistoryRefused', (refused) =>
          Effect.fail(
            new DatabaseReadFailed({
              path: session.roots.storage ?? '',
              cause: refused,
            }),
          ),
        ),
      ),
    readResultMeta: (): Effect.Effect<ResultMeta | null, DatabaseReadFailed> =>
      read((rows) => latestOfType(rows, id, 'run.result')?.result ?? null),
    /** The run's terminal result ({@link runEndOf}), or null while the
     *  lifecycle it is in has not ended. */
    readRunEnd: (): Effect.Effect<RunEnd | null, DatabaseReadFailed> =>
      runRows.pipe(Effect.flatMap(runEndOf)),
    /** The run's result: its producer record joined to its terminal result,
     *  the output as delivered ({@link deliveredOutput}). Null with no
     *  producer record; a background command's record is its own result. */
    readResult: (): Effect.Effect<RunResult | null, DatabaseReadFailed> =>
      Effect.gen(function* () {
        const rows = yield* runRows;
        const meta = latestOfType(rows, id, 'run.result')?.result ?? null;
        if (meta === null || meta.producer === 'backgroundBash') return meta;
        const end = yield* runEndOf(rows);
        return {
          ...(end ?? {}),
          output: deliveredOutput(meta, end?.output ?? emptyRunEndOutput()),
        };
      }),
    writeResultMeta: (
      result: DeliveredResult,
    ): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> =>
      Effect.suspend(() =>
        session.log.transact([
          {
            type: 'run.result',
            aggregateId: id,
            result: ResultMetaSchema.parse(storedResultMeta(result)),
          },
        ]),
      ).pipe(Effect.asVoid),
  };
}
