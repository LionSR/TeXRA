/**
 * A child turn's settlement: its rows (report, result manifest, the prompt it
 * consumed, `child.turn settled`) and its delivery, the report queued on the
 * parent's input. Both commit in one append, one SQLite transaction
 * (`settleChildTurn`), so no crash leaves a settled turn its parent never
 * reads; a last turn's commit with the child's `run.end` (#8093). A parent
 * another process holds refuses: the child parks holding the result, and
 * whoever next admits the parent delivers it with the child's end, read
 * from rows: the owner's tail seeing the park, or the parent's resume.
 */
import { Effect, type Scope } from 'effect';

import type {
  Inbox,
  InboxItem,
  Sent,
  SendOptions,
} from '@agent/followUp/Inbox';
import { startFollowUpWake } from '@agent/followUp/ToolUseFollowUp';
import type { AgentTrace } from '@agent/trace';
import type { AttemptKey } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import {
  qualifyAggregateId,
  storedResultMeta,
  type DeliveredResult,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseRowCorrupt,
} from '@shared/session/database';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft } from '@shared/session/runStateFold';
import type { CoWrite } from '@shared/session/sessionEvents';
import type { SessionHandle, SessionLog } from './SessionHandle';

const CHANNEL = 'childSettlement';
const REFUSED: Sent = { kind: 'refused' };

/** A delivery's warning: on an agent-CLI child's trace, else the log. */
export const warn = (
  trace: AgentTrace | undefined,
  message: string,
  data: unknown,
): Effect.Effect<void> =>
  trace
    ? Effect.sync(() => trace.warn(message, { data }))
    : Effect.logWarning(message).pipe(
        Effect.annotateLogs({ data }),
        withLogChannel(CHANNEL),
      );

/** The rows a settlement commits, all on the child's aggregate. */
export type SettlementRow = Extract<
  RunHistoryDraft,
  { type: 'run.report' | 'run.result' | 'child.turn' | 'followup.consumed' }
>;

/** A result on its way to the parent's inbox; `end`: the turn was the
 *  child's last, and ends it as this outcome. */
export interface ChildDelivery {
  readonly to: RunId;
  readonly item: InboxItem;
  readonly end?: 'completed' | 'failed';
}

/** One settled turn: what its ending batch commits and what it delivers. */
export interface ChildSettlement {
  readonly rows: readonly SettlementRow[];
  /** The parent delivery, committed with the rows; none for a detached or
   *  persist-only child, or a turn a stop ended. */
  readonly delivery: ChildDelivery | undefined;
}

/**
 * Rows decided inside a job, under holds its scope keeps until the job's one
 * append writes them with its own (`CoWrite`). `held`: the child parked
 * holding its last result, so its end is not written now.
 */
export type TransactionPart = Effect.Effect<
  CoWrite & { readonly held?: boolean },
  Error,
  Scope.Scope
>;

/**
 * The settlement of one turn whose report is `message`, delivered to `to`
 * under the strategy's one `deliveryId` or the turn's own (#9531): its
 * prompt's, so a re-execution after a crash is judged a replay, else the
 * `child.turn` key (run, attempt, turn index), distinct across attempts.
 */
export function settlementOf(params: {
  readonly runId: RunId;
  readonly turn: AttemptKey;
  readonly message: string;
  readonly resultMeta: DeliveredResult | undefined;
  readonly consumed: readonly QueuedFollowUp[];
  readonly deliveryId: string | undefined;
  readonly to: RunId | null;
  /** The turn is the child's last, ending it so. */
  readonly end?: ChildDelivery['end'];
}): ChildSettlement {
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
              result: storedResultMeta(params.resultMeta),
            },
          ]),
      ...params.consumed.map((followUp) => ({
        type: 'followup.consumed' as const,
        aggregateId: target,
        followUpId: followUp.followUpId,
      })),
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
 *  child's rows: a closed, tombstoned or unreadable parent refuses, loudly
 *  once the rows commit, and the child's own rows still commit. */
export const parentAdmission = (
  followUps: Inbox,
  to: RunId,
  item: InboxItem,
  options: SendOptions,
  trace: AgentTrace | undefined,
): Effect.Effect<CoWrite & { readonly sent: Sent }, Error, Scope.Scope> =>
  followUps.admission(to, item, options).pipe(
    Effect.map((admitted) => ({ ...admitted, committed: Effect.void })),
    Effect.catchIf(
      (error) =>
        (error instanceof DatabaseNotOwner && error.closed) ||
        error instanceof DatabaseReadFailed ||
        error instanceof DatabaseRowCorrupt,
      (error) =>
        Effect.succeed({
          rows: [],
          sent: REFUSED,
          committed: warn(
            trace,
            `Parent run ${to} is closed or cannot be read.`,
            {
              parentRunId: to,
              error,
            },
          ),
        }),
    ),
  );

/**
 * The parent's half of a settlement, appended with the child's rows; a
 * replay writes nothing. A parent another process holds leaves the result
 * parked on the child (`heldFor`, its end unwritten) for `deliverHeld`;
 * any other refusal is said once the rows commit.
 */
export const deliverIn = (
  followUps: Inbox,
  { to, item, end }: ChildDelivery,
  trace: AgentTrace | undefined,
): TransactionPart =>
  Effect.map(
    parentAdmission(followUps, to, item, {}, trace),
    ({ rows, sent, committed }) => {
      if (
        sent.kind === 'refused' &&
        sent.reason === 'owned_elsewhere' &&
        item.from.kind === 'run' &&
        item.deliveryId !== undefined
      )
        return {
          rows: [
            {
              type: 'child.park' as const,
              aggregateId: qualifyAggregateId('run', item.from.runId),
              phase: 'parked' as const,
              heldFor: item.deliveryId,
              ...(end !== undefined && { ends: end }),
            },
          ],
          held: end !== undefined,
          committed: warn(trace, 'Result waiting: parent is open elsewhere.', {
            parentRunId: to,
          }),
        };
      return {
        rows,
        committed:
          sent.kind === 'refused'
            ? Effect.andThen(
                committed,
                warn(
                  trace,
                  `Turn result not delivered: parent run is unavailable (${sent.reason ?? 'not_resumable'}). The result remains in the run report.`,
                  { parentRunId: to, reason: sent.reason },
                ),
              )
            : committed,
      };
    },
  );

/**
 * One settlement, whole, as the rows of the append that ends its turn: the
 * child's rows, its parent's `followup.queued`, and `park`, the turn's own
 * park, unless a held result's park took its place.
 */
export const settleChildTurn = (
  followUps: Inbox,
  { rows, delivery }: ChildSettlement,
  trace: AgentTrace | undefined,
  park?: SessionEventDraft,
): TransactionPart => {
  const own = park === undefined ? [] : [park];
  return delivery === undefined
    ? Effect.succeed({ rows: [...rows, ...own], committed: Effect.void })
    : Effect.map(deliverIn(followUps, delivery, trace), (parent) => ({
        ...parent,
        rows: [
          ...rows,
          ...parent.rows,
          ...(parent.rows.some((row) => row.type === 'child.park') ? [] : own),
        ],
      }));
};

/** Commit a part in one transaction, then run what it left for after. */
export const commitPart = (
  log: Pick<SessionLog, 'transact'>,
  part: TransactionPart,
): Effect.Effect<void, Error> =>
  Effect.flatten(
    log.transact((tx) =>
      Effect.gen(function* () {
        const co = yield* part;
        yield* tx.append(co.rows);
        return co.committed;
      }).pipe(Effect.scoped),
    ),
  );

/** After the transaction that queued `delivery` committed: wake the parent
 *  when no generation of it here reads it. A refused or already-read
 *  delivery owes no wake. */
export const wakeParent = (
  session: SessionHandle,
  delivery: ChildDelivery | undefined,
  trace: AgentTrace | undefined,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const id = delivery?.item.deliveryId;
    if (delivery === undefined || id === undefined) return;
    const { followUps } = yield* session.followUps.read(delivery.to);
    if (!followUps.some((f) => f.followUpId === id)) return;
    if (!(yield* startFollowUpWake(delivery.to, session)))
      yield* warn(
        trace,
        'Turn result queued for the parent, but the parent could not be resumed; an explicit Resume delivers it.',
        { parentRunId: delivery.to },
      );
  });
