/**
 * A child turn's result: its rows (report, result manifest, the prompts it
 * consumed, `child.turn settled`) and its delivery, the report queued on the
 * parent's input. Both commit in one SQLite transaction (`turnResultPart`),
 * so a crash never leaves a finished turn that its parent never reads; a
 * last turn's result commits with the child's `run.end`. If another process
 * has the parent open, the child is marked "result waiting"; the parent's
 * process delivers the result later (`deliverHeld`).
 */
import { Context, Effect, type Scope } from 'effect';

import type { InboxItem, Sent, SendOptions } from '@agent/followUp/Inbox';
import { Inbox, wakeIfOwed } from '@agent/followUp/ToolUseFollowUp';
import type { AgentTrace } from '@agent/trace/AgentTrace';
import { getRunRecords, persistedParentRunId } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import type { AttemptKey } from '@shared/session/runRowsShape';
import {
  qualifyAggregateId,
  type ResultMeta,
  type RunId,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import { consumedRow } from '@shared/session/runFacts';
import type { QueuedFollowUp } from '@shared/session/runRows';
import { SessionLog } from '@shared/session/runHistory';
import type { RunInputDraft } from '@shared/session/runState';

const CHANNEL = 'childTurnResult';

const LOG = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} as const;

/** A child diagnostic: on an agent-CLI child's own trace; every other child
 *  has no loop-owned stream, so on the process log under `channel`. */
export const traceLog = (
  trace: AgentTrace | undefined,
  channel: string,
  level: keyof typeof LOG,
  message: string,
  data?: unknown,
): Effect.Effect<void> => {
  if (trace)
    return Effect.sync(() =>
      trace[level](message, data === undefined ? undefined : { data }),
    );
  const entry = LOG[level](message).pipe(withLogChannel(channel));
  return data === undefined ? entry : Effect.annotateLogs(entry, { data });
};

/** A delivery's warning (every caller names its data). */
export const warn = (
  trace: AgentTrace | undefined,
  message: string,
  data: unknown,
): Effect.Effect<void> => traceLog(trace, CHANNEL, 'warn', message, data);

/** {@link warn}, from inside the job this runs in: the warning says what
 *  the job decided, which stands whether or not its rows commit. */
const warnOnCommit = (
  trace: AgentTrace | undefined,
  message: string,
  data: unknown,
): Effect.Effect<void> => warn(trace, message, data);

/** What a transaction part reads of its session. */
export type PartServices = SessionLog | Inbox;

/** The caller's {@link PartServices}, for the publisher job a part runs in:
 *  a job runs on the session's publisher, outside its caller's context. */
export const partServices = Effect.map(
  Effect.context<PartServices>(),
  Context.pick(SessionLog, Inbox),
);

/** The rows a turn result commits, all on the child's aggregate. */
export type TurnResultRow = Extract<
  RunInputDraft,
  { type: 'run.report' | 'run.result' | 'child.turn' | 'followup.consumed' }
>;

/** A result on its way to the parent's inbox, from its child's run under
 *  the id that makes a repeat a replay; `end`: the turn was the child's
 *  last, and ends it as this outcome. */
interface ChildDelivery {
  readonly to: RunId;
  readonly item: InboxItem & {
    readonly from: { readonly kind: 'run'; readonly runId: RunId };
    readonly deliveryId: string;
  };
  readonly end?: 'completed' | 'failed';
}

/** One finished turn: what its ending batch commits and what it delivers. */
export interface ChildTurnResult {
  readonly rows: readonly TurnResultRow[];
  /** The parent delivery, committed with the rows; none for a detached
   *  child, one nothing awaits, or a turn a stop ended. */
  readonly delivery: ChildDelivery | undefined;
}

/**
 * Rows decided inside a job and appended with the job's own. `note`: text
 * the end's error message adds (a loss notice the parent refused).
 */
export type TransactionPart = Effect.Effect<
  {
    readonly rows: readonly RunInputDraft[];
    readonly note?: string;
  },
  Error,
  Scope.Scope | PartServices
>;

/**
 * The result of one turn whose report is `message`, delivered to `to` under
 * the strategy's one `deliveryId` or the turn's own: its prompt's, so a
 * re-execution after a crash is recognized as a replay, else the
 * `child.turn` key (run, attempt, turn index), distinct across attempts.
 */
export function childTurnResult(params: {
  readonly runId: RunId;
  readonly turn: AttemptKey;
  readonly message: string;
  readonly resultMeta: ResultMeta | undefined;
  readonly consumed: readonly QueuedFollowUp[];
  readonly deliveryId: string | undefined;
  readonly to: RunId | null;
  /** The turn is the child's last, ending it so. */
  readonly end?: ChildDelivery['end'];
}): ChildTurnResult {
  const { runId, turn, to } = params;
  const target = qualifyAggregateId('run', runId);
  const prompt = params.consumed[0]?.followUpId;
  const deliveryId =
    params.deliveryId ??
    (prompt === undefined
      ? `${runId}:${turn.key}:${turn.index}:delivery`
      : `${runId}:${prompt}:delivery`);
  return {
    rows: [
      { type: 'run.report', aggregateId: target, report: params.message },
      ...(params.resultMeta === undefined
        ? []
        : [
            {
              type: 'run.result' as const,
              aggregateId: target,
              result: params.resultMeta,
            },
          ]),
      ...params.consumed.map((followUp) =>
        consumedRow(runId, followUp.followUpId, { kind: 'answered' }),
      ),
      {
        type: 'child.turn',
        aggregateId: target,
        attemptId: params.turn.key,
        turnIndex: params.turn.index,
        phase: 'settled',
      },
    ],
    delivery:
      to === null
        ? undefined
        : {
            to,
            item: {
              text: params.message,
              from: { kind: 'run', runId: params.runId },
              deliveryId,
            },
            ...(params.end !== undefined && { end: params.end }),
          },
  };
}

/** A child's message to its parent, decided in the job committing the
 *  child's rows. A closed, deleted or unreadable parent refuses it, with a
 *  warning once the job commits; the child's own rows still commit. */
export const parentAdmission = (
  to: RunId,
  item: InboxItem,
  options: SendOptions,
  trace: AgentTrace | undefined,
): Effect.Effect<
  { readonly rows: readonly RunInputDraft[]; readonly sent: Sent },
  never,
  Scope.Scope | PartServices
> => {
  const refused = (error: DatabaseReadFailed) =>
    Effect.as(
      warnOnCommit(trace, `Parent run ${to} is closed or cannot be read.`, {
        parentRunId: to,
        error,
      }),
      {
        rows: [],
        sent: { kind: 'refused', reason: 'notResumable' } satisfies Sent,
      },
    );
  return Inbox.use((inbox) => inbox.admission(to, item, options)).pipe(
    Effect.catchTags({
      DatabaseReadFailed: refused,
      // A delivery names no caller id, so nothing conflicts with it.
      Conflict: Effect.die,
    }),
  );
};

/**
 * The parent's half of a turn result, appended with the child's rows; a
 * replay writes nothing. The child's parent edge is read from its records
 * in this job: if a detach committed first, the result stays in the child's
 * report. A refusal is a warning.
 */
export const deliverIn: (
  { to, item }: ChildDelivery,
  trace: AgentTrace | undefined,
) => TransactionPart = Effect.fn('deliverIn')(function* (
  { to, item }: ChildDelivery,
  trace: AgentTrace | undefined,
) {
  const child = item.from.runId;
  if ((yield* persistedParentRunId(child)) !== to) {
    yield* warnOnCommit(
      trace,
      'Turn result not delivered: child was detached from its orchestrator. The result remains in the run report.',
      { runId: child },
    );
    return { rows: [] };
  }
  const { rows, sent } = yield* parentAdmission(to, item, {}, trace);
  if (sent.kind === 'refused')
    yield* warnOnCommit(
      trace,
      `Turn result not delivered: parent run is unavailable (${sent.reason}). The result remains in the run report.`,
      { parentRunId: to, reason: sent.reason },
    );
  return { rows };
});

/**
 * One turn result, whole, as the rows of the append that ends its turn: the
 * child's rows, its parent's `followup.queued`, and `waiting`, the row that
 * marks the child as waiting for input.
 */
export const turnResultPart = (
  { rows, delivery }: ChildTurnResult,
  trace: AgentTrace | undefined,
  waiting?: RunInputDraft,
): TransactionPart => {
  const own = waiting === undefined ? [] : [waiting];
  return delivery === undefined
    ? Effect.succeed({ rows: [...rows, ...own] })
    : Effect.map(deliverIn(delivery, trace), (parent) => ({
        ...parent,
        rows: [...rows, ...parent.rows, ...own],
      }));
};

/** A child's attached parent as a job reads it: from the child's rows once
 *  its run exists (minus a committed detach), else its launch's, which only
 *  this process holds for a run not yet created. */
const parentEdgeIn = Effect.fn('childTurnResult.parentEdgeIn')(function* (
  child: RunId,
  launchParent: RunId,
): Effect.fn.Return<RunId | null, Error, SessionLog> {
  if (!(yield* getRunRecords(child).exists())) return launchParent;
  return (yield* persistedParentRunId(child)) ?? null;
});

/**
 * Queue a child's message (`item.from`) for its parent, read in the same
 * job ({@link parentEdgeIn}); a detach that committed first sends it
 * nowhere. Returns the parent it reached, or null when there is none or it
 * refused.
 */
export const sendToParent = (
  item: InboxItem & { readonly from: { readonly kind: 'run' } },
  launchParent: RunId,
  options: SendOptions,
  trace: AgentTrace | undefined,
): Effect.Effect<RunId | null, Error, PartServices> =>
  Effect.suspend(() => {
    let reached: RunId | null = null;
    const part = Effect.gen(function* () {
      const to = yield* parentEdgeIn(item.from.runId, launchParent);
      if (to === null) return { rows: [] };
      const admitted = yield* parentAdmission(to, item, options, trace);
      reached = admitted.sent.kind === 'refused' ? null : to;
      return admitted;
    });
    return Effect.map(commitPart(part), () => reached);
  });

/** Commit a part in one transaction of its own. */
export const commitPart = Effect.fn('commitPart')(function* (
  part: TransactionPart,
): Effect.fn.Return<void, Error, PartServices> {
  const services = yield* partServices;
  yield* Context.get(services, SessionLog).transact((tx) =>
    Effect.gen(function* () {
      const { rows } = yield* part;
      yield* tx.append(rows);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

/** After the transaction that queued `delivery` commits: resume the parent
 *  if the delivery obliges one and no generation here reads it
 *  (`wakeIfOwed`). A refused resume is told to the user by the resume; a
 *  wake that could not read the parent is a warning, and an explicit Resume
 *  delivers the result. */
export const wakeParent = Effect.fn('childTurnResult.wakeParent')(function* (
  delivery: ChildDelivery | undefined,
  trace: AgentTrace | undefined,
) {
  if (delivery === undefined) return;
  const woken = yield* wakeIfOwed(delivery.to);
  // The child's boundary waits for its parent's resumed turn.
  if (woken !== false) return yield* woken;
  yield* warn(
    trace,
    'Turn result queued for the parent, but the parent could not be read to resume it; an explicit Resume delivers it.',
    { parentRunId: delivery.to },
  );
});
