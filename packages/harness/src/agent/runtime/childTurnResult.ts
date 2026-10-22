/**
 * A child turn's result: its rows (report, result manifest, the prompts it
 * consumed, `child.turn settled`) and its delivery, the report queued on the
 * parent's input. Both commit in one SQLite transaction (`turnResultPart`),
 * so a crash never leaves a finished turn that its parent never reads; a
 * last turn's result commits with the child's `run.end`. If another process
 * has the parent open, the child is marked "result waiting"; the parent's
 * process delivers the result later (`deliverHeld`).
 */
import { Effect, type Scope } from 'effect';

import type { InboxItem, Sent, SendOptions } from '@agent/followUp/Inbox';
import { startFollowUpWake } from '@agent/followUp/ToolUseFollowUp';
import type { AgentTrace } from '@agent/trace';
import {
  getRunRecords,
  lostResultId,
  persistedParentRunId,
  type AttemptKey,
} from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import {
  qualifyAggregateId,
  type ResultMeta,
  type RunId,
} from '@shared/schemas';
import { DatabaseNotOwner, DatabaseReadFailed } from '@shared/session/database';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunInputDraft } from '@shared/session/runStateFold';
import type { SessionHandle } from './SessionHandle';

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

/** {@link warn}, once the job this runs in commits; never if it rolls back. */
const warnOnCommit = (
  { log }: Pick<SessionHandle, 'log'>,
  trace: AgentTrace | undefined,
  message: string,
  data: unknown,
): Effect.Effect<void> => log.afterCommit(warn(trace, message, data));

/** The rows a turn result commits, all on the child's aggregate. */
export type TurnResultRow = Extract<
  RunInputDraft,
  { type: 'run.report' | 'run.result' | 'child.turn' | 'followup.consumed' }
>;

/** A result on its way to the parent's inbox, from its child's run under
 *  the id that makes a repeat a replay; `end`: the turn was the child's
 *  last, and ends it as this outcome. */
export interface ChildDelivery {
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
  /** The parent delivery, committed with the rows; none for a detached or
   *  persist-only child, or a turn a stop ended. */
  readonly delivery: ChildDelivery | undefined;
}

/**
 * Rows decided inside a job and appended with the job's own; what it holds
 * (a claim) lasts until the job ends. `held`: the parent is open in another
 * process, so the child now waits holding the result, and a last turn's end
 * is not written yet. `note`: text the end's error message adds (a loss
 * notice the parent refused).
 */
export type TransactionPart = Effect.Effect<
  {
    readonly rows: readonly RunInputDraft[];
    readonly held?: boolean;
    readonly note?: string;
  },
  Error,
  Scope.Scope
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
 *  child's rows. A closed, deleted or unreadable parent refuses it, with a
 *  warning once the job commits; the child's own rows still commit. */
export const parentAdmission = (
  session: Pick<SessionHandle, 'followUps' | 'log'>,
  to: RunId,
  item: InboxItem,
  options: SendOptions,
  trace: AgentTrace | undefined,
): Effect.Effect<
  { readonly rows: readonly RunInputDraft[]; readonly sent: Sent },
  Error,
  Scope.Scope
> =>
  session.followUps.admission(to, item, options).pipe(
    Effect.catchIf(
      (error) =>
        (error instanceof DatabaseNotOwner && error.closed) ||
        error instanceof DatabaseReadFailed,
      (error) =>
        Effect.as(
          warnOnCommit(
            session,
            trace,
            `Parent run ${to} is closed or cannot be read.`,
            { parentRunId: to, error },
          ),
          { rows: [], sent: { kind: 'refused' } satisfies Sent },
        ),
    ),
  );

/**
 * The parent's half of a turn result, appended with the child's rows; a
 * replay writes nothing. The child's parent edge is read from its records
 * in this job: if a detach committed first, the result stays in the child's
 * report. If another process has the parent open, the child is marked as
 * holding the result (`heldFor`, its end not yet written) for `deliverHeld`.
 * Any other refusal is a warning once the job commits.
 */
export const deliverIn = (
  session: SessionHandle,
  { to, item, end }: ChildDelivery,
  trace: AgentTrace | undefined,
): TransactionPart =>
  Effect.gen(function* () {
    const child = item.from.runId;
    if ((yield* persistedParentRunId(session, child)) !== to) {
      yield* warnOnCommit(
        session,
        trace,
        'Turn result not delivered: child was detached from its orchestrator. The result remains in the run report.',
        { runId: child },
      );
      return { rows: [] };
    }
    const { rows, sent } = yield* parentAdmission(session, to, item, {}, trace);
    if (sent.kind === 'refused' && sent.reason === 'owned_elsewhere') {
      yield* warnOnCommit(
        session,
        trace,
        'Result waiting: parent is open elsewhere.',
        { parentRunId: to },
      );
      return {
        rows: [
          {
            type: 'child.park' as const,
            aggregateId: qualifyAggregateId('run', child),
            phase: 'parked' as const,
            heldFor: item.deliveryId,
            ...(end !== undefined && { ends: end }),
          },
        ],
        held: true,
      };
    }
    if (sent.kind === 'refused')
      yield* warnOnCommit(
        session,
        trace,
        `Turn result not delivered: parent run is unavailable (${sent.reason ?? 'not_resumable'}). The result remains in the run report.`,
        { parentRunId: to, reason: sent.reason },
      );
    return { rows };
  });

/**
 * One turn result, whole, as the rows of the append that ends its turn: the
 * child's rows, its parent's `followup.queued`, and `waiting`, the row that
 * marks the child as waiting for input, unless a held result's row took its
 * place.
 */
export const turnResultPart = (
  session: SessionHandle,
  { rows, delivery }: ChildTurnResult,
  trace: AgentTrace | undefined,
  waiting?: RunInputDraft,
): TransactionPart => {
  const own = waiting === undefined ? [] : [waiting];
  return delivery === undefined
    ? Effect.succeed({ rows: [...rows, ...own] })
    : Effect.map(deliverIn(session, delivery, trace), (parent) => ({
        ...parent,
        rows: [...rows, ...parent.rows, ...(parent.held === true ? [] : own)],
      }));
};

/** A child's parent as a job reads it: from the child's rows once its run
 *  exists, else from this process's registry entry for its launch (minus a
 *  detach), which only this process can hold for a run not yet created. */
export const parentEdgeIn = (
  session: SessionHandle,
  child: RunId,
): Effect.Effect<RunId | null, Error> =>
  Effect.gen(function* () {
    if (!(yield* getRunRecords(session, child).exists()))
      return session.runs.get(child)?.parent ?? null;
    return (yield* persistedParentRunId(session, child)) ?? null;
  });

/**
 * Queue a child's message (`item.from`) for its parent, read in the same
 * job ({@link parentEdgeIn}); a detach that committed first sends it
 * nowhere. Returns the parent it reached, or null when there is none or it
 * refused.
 */
export const sendToParent = (
  session: SessionHandle,
  item: InboxItem & { readonly from: { readonly kind: 'run' } },
  options: SendOptions,
  trace: AgentTrace | undefined,
): Effect.Effect<RunId | null, Error> =>
  Effect.suspend(() => {
    let reached: RunId | null = null;
    const part = Effect.gen(function* () {
      const to = yield* parentEdgeIn(session, item.from.runId);
      if (to === null) return { rows: [] };
      const admitted = yield* parentAdmission(
        session,
        to,
        item,
        options,
        trace,
      );
      reached = admitted.sent.kind === 'refused' ? null : to;
      return admitted;
    });
    return Effect.map(commitPart(session, part), () => reached);
  });

/**
 * A child launch that failed before its run was created: the child has no
 * row to record a result on, so its parent hears the failure as input
 * alone, and is woken for it.
 */
export const deliverLaunchFailure = (
  session: SessionHandle,
  child: RunId,
  text: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (yield* getRunRecords(session, child).exists()) return;
    const from = { kind: 'run', runId: child } as const;
    const item = { text, from, deliveryId: `${child}:launch` };
    const to = yield* sendToParent(session, item, {}, undefined);
    if (to !== null) yield* wakeParent(session, { to, item }, undefined);
  }).pipe(
    // The launch's own failure stands; this one is logged beside it.
    Effect.catch((e) => warn(undefined, `${child}: not delivered`, e)),
  );

/** Commit a part in one transaction of its own. */
export const commitPart = (
  { log }: Pick<SessionHandle, 'log'>,
  part: TransactionPart,
): Effect.Effect<void, Error> =>
  log.transact((tx) =>
    Effect.gen(function* () {
      const { rows } = yield* part;
      yield* tx.append(rows);
    }).pipe(Effect.scoped),
  );

/** After the transaction that queued `delivery` commits: if the parent has
 *  not read the delivery yet (or the notice the child's end queued in its
 *  place, `lostResultId`), resume it unless its loop already runs here. A
 *  refused or already-read delivery needs no resume. */
export const wakeParent = (
  session: SessionHandle,
  delivery: ChildDelivery | undefined,
  trace: AgentTrace | undefined,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (delivery === undefined) return;
    const { deliveryId, from } = delivery.item;
    const lost = lostResultId(from.runId);
    const { followUps } = yield* session.followUps.read(delivery.to);
    const waits = ({ followUpId }: { readonly followUpId: string }) =>
      followUpId === deliveryId || followUpId.startsWith(lost);
    if (!followUps.some(waits)) return;
    if (!(yield* startFollowUpWake(delivery.to, session)))
      yield* warn(
        trace,
        'Turn result queued for the parent, but the parent could not be resumed; an explicit Resume delivers it.',
        { parentRunId: delivery.to },
      );
  });
