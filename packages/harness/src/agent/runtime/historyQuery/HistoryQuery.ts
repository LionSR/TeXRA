/**
 * A session's history query store: the model's SQL runs against a separate
 * in-memory database that holds the session's runs, as the view has them,
 * and their call facts (each model request and each tool call), all as of
 * the first view that applied the commit the query was asked at. The tables
 * are `views.ts`'s, each cell filled from a decoded value, so nothing a
 * statement names reaches the session database or a stored row's encoding.
 *
 * The store is a child process (`childSource.ts`), started on the first
 * query and closed with the session's scope. Each query first feeds it the
 * rows each run committed since the last one. Queries run one at a time; a
 * query past its deadline, or one whose caller is interrupted, kills the
 * process, and the next query rebuilds the store from the start.
 */
import {
  Array as Arr,
  type Context,
  Effect,
  Exit,
  Option,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { withLogChannel } from '@logger/effectLog';
import {
  qualifyAggregateId,
  type CommitOrdinal,
  type DispatchFacts,
  type InvocationRef,
  type NormalizedUsage,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import {
  HistoryPageSchema,
  HistoryQueryFailed,
  HistoryQueryRefused,
  SessionLog,
  type HistoryCell,
  type HistoryPage,
  type HistoryQuery,
  SessionViewAccess,
  runReadRefusal,
} from '@shared/session/runHistory';
import { type SessionView } from '@shared/session/sessionView';

import {
  type CallPositions,
  failedStep,
  failedWith,
  openStore,
  request,
  type Store,
} from './childSource';
import {
  cutJson,
  cutText,
  replaceRuns,
  statementRefusal,
  type HistoryWrite,
} from './views';

const CHANNEL = 'HistoryQuery';
const QUERY_DEADLINE = '5 seconds';
/** Rows one query returns; the page says when more exist. */
const HISTORY_QUERY_ROW_CAP = 200;
/** Serialized page ceiling before a result leaves the query process. */
const HISTORY_QUERY_PAGE_LIMIT_BYTES = 4 * 1024 * 1024;
/** Capped writes per append keep requests bounded for any history length. */
const APPEND_OPS = 500;

/** The session a store reads: its run history rows, current commit and view. */
interface HistorySession {
  readonly log: SessionLog['Service'];
  readonly view: SessionViewAccess['Service'];
}

type ModelMessage = Extract<SessionEvent, { type: 'model.message' }>;

/** The write that ends request `invocation` of `runId`. */
const modelEnd = (
  runId: RunId,
  at: string,
  { invocationId, attempt }: InvocationRef,
  status: 'completed' | 'failed' | 'cancelled',
  end: { output?: string; error?: string; usage?: NormalizedUsage | null },
): HistoryWrite => ({
  statement: 'modelEnd',
  params: {
    status,
    output: end.output ?? null,
    error: end.error ?? null,
    input_tokens: end.usage?.inputTokens ?? null,
    output_tokens: end.usage?.outputTokens ?? null,
    cost: end.usage?.cost ?? null,
    ended_at: at,
    run_id: runId,
    invocation_id: invocationId,
    attempt,
  },
});

/** The writes one `model.message` row makes: a request sent or ended, and
 *  the tool calls a response or a hand-down issues. */
function modelWrites(
  calls: CallPositions,
  runId: RunId,
  { payload: p }: ModelMessage,
  at: string,
): HistoryWrite[] {
  const issue = ({ logId, callId, toolName }: DispatchFacts, input: string) =>
    toolCall(calls, logId, {
      run_id: runId,
      call_id: callId,
      script_call_id: null,
      tool: toolName,
      input: cutText(input),
      issued_at: at,
    });
  switch (p.kind) {
    case 'attempt': {
      const { invocationId, attempt } = p.invocation;
      const model = p.origin.requestedModel;
      return [
        {
          statement: 'modelAttempt',
          params: {
            run_id: runId,
            invocation_id: invocationId,
            attempt,
            model,
            started_at: at,
          },
        },
      ];
    }
    case 'failed': {
      const { message } = p.error;
      return [modelEnd(runId, at, p.invocation, 'failed', { error: message })];
    }
    case 'cancelled':
      return [modelEnd(runId, at, p.invocation, 'cancelled', {})];
    case 'response': {
      const parts = p.turn.content;
      const text = parts
        .flatMap((part) => (part.kind === 'message' ? part.content : []))
        .map((part) => part.text)
        .join('');
      const args = parts.flatMap((part) =>
        part.kind === 'local-call' ? [part.argumentsText] : [],
      );
      return [
        modelEnd(runId, at, p.invocation, 'completed', {
          output: cutText(text),
          usage: p.usage,
        }),
        // A response's dispatch facts follow its local calls in order.
        ...p.calls.map((call, index) => issue(call, args[index] ?? '')),
      ];
    }
    case 'handed-down':
      return [issue(p.call, p.argumentsText)];
    // Provider identity, an accepted remote operation and the messages a
    // run appends end no request and issue no call.
    case 'identified':
    case 'accepted':
    case 'append':
      return [];
  }
}

/** The write that issues a call at the next position, under its card. */
function toolCall(
  calls: CallPositions,
  card: string,
  call: Omit<
    Extract<HistoryWrite, { statement: 'toolCall' }>['params'],
    'position'
  >,
): HistoryWrite {
  calls.last += 1;
  calls.byCard.set(card, calls.last);
  return { statement: 'toolCall', params: { position: calls.last, ...call } };
}

/** The writes one of `runId`'s history rows makes, from its decoded
 *  payload; `calls` places each issued call. */
function callWrites(
  calls: CallPositions,
  runId: RunId,
  row: SessionEvent,
): HistoryWrite[] {
  const at = new Date(row.at).toISOString();
  if (row.type === 'model.message') return modelWrites(calls, runId, row, at);
  if (row.type === 'script.call') {
    const { callId, scriptCallId, toolName, input, logId } = row.payload;
    return [
      toolCall(calls, logId, {
        run_id: runId,
        call_id: callId,
        script_call_id: scriptCallId,
        tool: toolName,
        input: cutJson(input),
        issued_at: at,
      }),
    ];
  }
  if (row.type === 'tool.intent') {
    return [
      {
        statement: 'toolStart',
        params: {
          attempt: row.payload.attempt,
          started_at: at,
          run_id: runId,
          call_id: row.payload.callId,
        },
      },
    ];
  }
  if (row.type === 'tool.result') {
    const { attempt, disposition, result, callId } = row.payload;
    const done = result.status === 'executed';
    return [
      {
        statement: 'toolEnd',
        params: {
          attempt,
          status: disposition,
          output: done ? cutText(result.output ?? null) : null,
          value: done ? cutJson(result.value) : null,
          error: done ? null : cutText(result.error),
          ended_at: at,
          run_id: runId,
          call_id: callId,
        },
      },
    ];
  }
  // A run's other history rows (positions, requests, offered tools, blobs,
  // hook outcomes, a compaction's edit, a fork's seed) record no call fact.
  return [];
}

/** Send `ops` to the store, a bounded request at a time. */
const append = (store: Store, ops: readonly HistoryWrite[]) =>
  Effect.forEach(
    Arr.chunksOf(ops, APPEND_OPS),
    (chunk) =>
      request(store, { kind: 'append', ops: chunk }).pipe(
        Effect.flatMap(failedStep('rows')),
      ),
    { discard: true },
  );

/** The session's {@link HistoryQuery}, over its log and view. */
export class HistoryQueryStore implements Context.Service.Shape<
  typeof HistoryQuery
> {
  /** Built in the session's scope: the store's process closes with it. */
  static readonly make: Effect.Effect<
    HistoryQueryStore,
    never,
    Scope.Scope | ChildProcessSpawner | SessionLog | SessionViewAccess
  > = Effect.gen(function* () {
    return new HistoryQueryStore(
      { log: yield* SessionLog, view: yield* SessionViewAccess },
      yield* Effect.scope,
      yield* ChildProcessSpawner,
    );
  });

  private readonly lane = Semaphore.makeUnsafe(1);
  private store: Store | undefined;

  private readonly session: HistorySession;
  private readonly scope: Scope.Scope;
  private readonly spawner: ChildProcessSpawner['Service'];
  private constructor(
    session: HistorySession,
    scope: Scope.Scope,
    spawner: ChildProcessSpawner['Service'],
  ) {
    this.session = session;
    this.scope = scope;
    this.spawner = spawner;
  }

  /** Run one read over the session's history as of this call. */
  query(
    sql: string,
    params: readonly HistoryCell[],
  ): Effect.Effect<
    HistoryPage,
    HistoryQueryRefused | HistoryQueryFailed | DatabaseReadFailed
  > {
    const refusal = statementRefusal(sql);
    if (refusal !== null) {
      return Effect.fail(
        new HistoryQueryRefused({ reason: 'not-a-read', message: refusal }),
      );
    }
    return this.lane.withPermit(
      this.run(sql, params).pipe(
        Effect.onInterrupt(() => this.discard('its caller was interrupted')),
        // A failed feed may have appended part of its rows: the next query
        // rebuilds the store rather than append them twice.
        Effect.tapError((error) =>
          error._tag === 'HistoryQueryRefused'
            ? Effect.void
            : this.discard(error.message),
        ),
      ),
    );
  }

  private readonly run = Effect.fn('HistoryQueryStore.run')(
    { self: this },
    function* (sql: string, params: readonly HistoryCell[]) {
      const { log, view } = this.session;
      const now = log.now();
      // One watermark for every table: the first view that applied every
      // row committed by this call, and call facts through its cursor.
      const { cursor: target, runs } = yield* view.changes.pipe(
        Stream.filter(({ cursor }) => cursor >= now),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
        failedWith('The session view stopped before this query could read it.'),
      );
      // A cleared database restarts its commits below what the store holds.
      if (this.store && target < this.store.cursor) {
        yield* this.discard('the session database was cleared');
      }
      const store = this.store ?? (yield* openStore(this.scope, this.spawner));
      this.store = store;
      // View snapshots are immutable: the same `runs` at the same cursor is
      // already in the store.
      if (target > store.cursor || runs !== store.runs) {
        yield* this.feed(store, runs, target);
        store.cursor = target;
        yield* append(store, replaceRuns(runs, store));
        store.runs = runs;
      }
      const reply = yield* request(store, {
        kind: 'query',
        sql,
        params,
        cap: HISTORY_QUERY_ROW_CAP,
        maxBytes: HISTORY_QUERY_PAGE_LIMIT_BYTES,
      }).pipe(Effect.timeoutOption(QUERY_DEADLINE));
      if (Option.isNone(reply)) {
        yield* this.discard('a query ran past its deadline');
        return yield* new HistoryQueryRefused({
          reason: 'timeout',
          message: `The query did not finish within ${QUERY_DEADLINE} and was stopped. Narrow it (filter by run_id, add LIMIT) and retry.`,
        });
      }
      if (reply.value instanceof HistoryQueryRefused) return yield* reply.value;
      return yield* Schema.decodeUnknownEffect(HistoryPageSchema)(
        reply.value.value,
      ).pipe(failedWith('The history query process sent an unreadable page.'));
    },
  );

  /** Feed `store` the call facts each of `runs` committed through `target`
   *  since the last feed, and drop the runs the view no longer holds. */
  private feed(store: Store, runs: SessionView['runs'], target: CommitOrdinal) {
    return Effect.gen({ self: this }, function* () {
      for (const id of store.fed.keys()) {
        if (runs.has(id)) continue;
        store.fed.delete(id);
        store.unreadable.delete(id);
        yield* append(store, [
          { statement: 'removeTools', params: { run_id: id } },
          { statement: 'removeModels', params: { run_id: id } },
        ]);
      }
      for (const run of runs.values()) {
        const fed = store.fed.get(run.id);
        // An ended run takes no row before its next activation, which
        // replaces its view.
        if (fed?.view === run && run.outcome !== null) continue;
        const after = fed?.seq ?? 0;
        const rows = yield* this.session.log
          .history(qualifyAggregateId('run', run.id), after + 1)
          .pipe(
            Effect.catchIf(
              (error) => runReadRefusal(error) !== undefined,
              (error) =>
                Effect.logWarning(
                  `History query leaves out the calls of run ${run.id}: ${error.message}`,
                ).pipe(withLogChannel(CHANNEL), Effect.as(error.message)),
            ),
          );
        // A run whose rows do not decode in this build never will: its row
        // in runs says why its calls are missing, and it is not read again.
        if (typeof rows === 'string') {
          store.unreadable.set(run.id, rows);
          store.fed.set(run.id, { view: run, seq: Number.MAX_SAFE_INTEGER });
          continue;
        }
        const kept = rows.filter((row) => row.commit <= target);
        yield* append(
          store,
          kept.flatMap((row) => callWrites(store.calls, run.id, row)),
        );
        store.fed.set(run.id, { view: run, seq: kept.at(-1)?.seq ?? after });
      }
    });
  }

  private discard(why: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const store = this.store;
      if (store === undefined) return Effect.void;
      this.store = undefined;
      return Effect.logWarning(
        `History query store closed: ${why}; the next query rebuilds it.`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(Scope.close(store.scope, Exit.void)),
      );
    });
  }
}
