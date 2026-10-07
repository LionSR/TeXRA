/**
 * A child turn's settlement: the rows on the child's own aggregate that the
 * batch ending the turn commits, and the relay that hands its result to the
 * parent's inbox once they are durable. The rows are the turn's report, its
 * result manifest, the prompt it consumed, and its `child.turn settled`,
 * which names the delivery (`delivery`: the parent and the follow-up id the
 * report is queued under).
 *
 * The child's rows are the one fact, and the parent's `followup.queued` row
 * is their relay: idempotent by its id, written just after the rows commit,
 * and written again by a resumed parent for every settled delivery it has
 * not read (`relayChildDeliveries`). A crash between the child's batch and
 * the parent's row therefore loses nothing. A final turn's rows commit with
 * the child's `run.end`, so the parent never reads a result from a child
 * that still reads as running (#8093), and needs no hold for it.
 */
import { Effect } from 'effect';

import type { InboxItem } from '@agent/followUp/Inbox';
import {
  startFollowUpWake,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import type { AgentTrace } from '@agent/trace';
import type { AttemptKey } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateId,
  storedResultMeta,
  type DeliveredResult,
  type RunId,
} from '@shared/schemas';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft } from '@shared/session/runStateFold';
import type { SessionHandle } from './SessionHandle';

const CHANNEL = 'childSettlement';

/** The rows a settlement commits, all on the child's aggregate. */
export type SettlementRow = Extract<
  RunHistoryDraft,
  { type: 'run.report' | 'run.result' | 'child.turn' | 'followup.consumed' }
>;

/** A result on its way to the parent's inbox. */
export interface ChildDelivery {
  readonly to: RunId;
  readonly item: InboxItem;
}

/** One settled turn: what its ending batch commits and what it delivers. */
export interface ChildSettlement {
  readonly rows: readonly SettlementRow[];
  /** The parent delivery the rows name; none for a detached or
   *  persist-only child, or a turn a stop ended. */
  readonly delivery: ChildDelivery | undefined;
}

/**
 * The settlement of one turn whose report is `message`: the report and
 * manifest, the follow-ups its prompt consumed, and the `child.turn settled`
 * row naming the delivery to `to` under `deliveryId`.
 */
export function settlementOf(params: {
  readonly runId: RunId;
  readonly turn: AttemptKey;
  readonly message: string;
  readonly resultMeta: DeliveredResult | undefined;
  readonly consumed: readonly QueuedFollowUp[];
  readonly deliveryId: string;
  readonly to: RunId | null;
}): ChildSettlement {
  const target = aggregateId('run', params.runId);
  const { to, deliveryId } = params;
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
      settledRow(params.runId, params.turn, to, deliveryId),
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
          },
  };
}

/** A turn's `child.turn settled` row, naming its delivery when it has one. */
export function settledRow(
  runId: RunId,
  turn: AttemptKey,
  to: RunId | null = null,
  followUpId?: string,
): Extract<SettlementRow, { type: 'child.turn' }> {
  return {
    type: 'child.turn',
    aggregateId: aggregateId('run', runId),
    attemptId: turn.key,
    turnIndex: turn.index,
    phase: 'settled',
    ...(to === null || followUpId === undefined
      ? {}
      : { delivery: { to, followUpId } }),
  };
}

/**
 * Hand a durable delivery to the parent's inbox, and wake the parent when no
 * generation of it runs here. Its id makes it a replay when a resumed
 * parent already relayed it.
 */
export const relayDelivery = Effect.fn('childSettlement.relay')(function* (
  session: SessionHandle,
  { to, item }: ChildDelivery,
  trace: AgentTrace | undefined,
): Effect.fn.Return<void, Error> {
  const warn = (message: string, data: unknown) =>
    trace
      ? Effect.sync(() => trace.warn(message, { data }))
      : Effect.logWarning(message).pipe(
          Effect.annotateLogs({ data }),
          withLogChannel(CHANNEL),
        );
  // Only a settlement that committed is relayed: a refused batch (its
  // `run.end`, say) leaves the parent nothing to read.
  if (item.from.kind !== 'run') return;
  const sender = item.from.runId;
  const settled = yield* session.log.rows(aggregateId('run', sender), [
    'child.turn',
  ]);
  if (
    !settled.some(
      (row) =>
        row.type === 'child.turn' &&
        row.delivery?.followUpId === item.deliveryId,
    )
  )
    return yield* warn(
      'Turn result not delivered: its settlement did not commit. The result remains in the run report.',
      { runId: sender, parentRunId: to },
    );
  const sent = yield* session.followUps.send(to, item, { wake: true });
  if (sent.kind === 'refused')
    return yield* warn(
      `Turn result not delivered: parent run is unavailable (${sent.reason ?? 'not_resumable'}). The result remains in the run report.`,
      { parentRunId: to, reason: sent.reason },
    );
  const unresumed =
    'Turn result queued for the parent, but the parent could not be resumed; an explicit Resume delivers it.';
  if (
    sent.kind === 'queued' &&
    sent.wake &&
    !(yield* startFollowUpWake(to, session))
  )
    yield* warn(unresumed, { parentRunId: to });
  // A replay of the row above: a parent live here reads it at its park.
  const delivery = yield* submitFollowUp(to, item, { session });
  if (delivery.status === 'failed')
    yield* warn(
      `Turn result not delivered: parent run is unavailable (${delivery.reason}). The result remains in the run report.`,
      { parentRunId: to, reason: delivery.reason },
    );
  else if (delivery.status === 'queued' && delivery.wake === 'failed')
    yield* warn(unresumed, { parentRunId: to });
});

/**
 * Relay every delivery the parent's children settled and the parent has
 * not read: the recovery of a crash between a child's settlement and its
 * relay. Each report is the `run.report` its settled row follows in their batch. Already-read
 * deliveries are replays and write nothing.
 */
export const relayChildDeliveries = Effect.fn(
  'childSettlement.relayChildDeliveries',
)(function* (
  session: SessionHandle,
  parentRunId: RunId,
): Effect.fn.Return<void, Error> {
  // The listing as the log holds it: a session just opened has not folded
  // its runs yet.
  const { runs } = yield* session.view.read([]);
  for (const [childId, child] of runs) {
    if (child.parentId !== parentRunId) continue;
    const rows = yield* session.log.rows(aggregateId('run', childId), [
      'child.turn',
      'run.report',
    ]);
    for (const row of rows) {
      if (row.type !== 'child.turn' || row.delivery?.to !== parentRunId)
        continue;
      // The settlement's report precedes its `child.turn` in their batch.
      const report = rows.findLast(
        (other) => other.type === 'run.report' && other.commit < row.commit,
      );
      if (report?.type !== 'run.report' || report.report === null) continue;
      yield* session.followUps.send(parentRunId, {
        text: report.report,
        from: { kind: 'run', runId: childId },
        deliveryId: row.delivery.followUpId,
      });
    }
  }
});
