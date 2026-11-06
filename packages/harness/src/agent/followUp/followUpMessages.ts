import { randomUUID } from 'node:crypto';

import { Effect, Option, Schema, Stream } from 'effect';

import {
  parseScriptDeliverySummary,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';
import {
  FollowUpRequestSchema,
  qualifyAggregateId,
  type FollowUpContent,
  type FollowUpReceipt,
  type FollowUpSender,
  type RunId,
  type RunRelation,
  type ScriptDeliverySummary,
} from '@shared/schemas';
import { type DatabaseReadFailed } from '@shared/session/database';
import {
  followUpReceipt,
  RECEIPT_ROW_TYPES,
  type FollowUpRecord,
} from '@shared/session/runRowReads';
import { SessionLog } from '@shared/session/runHistory';
import {
  Conflict,
  Rejected,
  Unavailable,
} from '@shared/session/runtimeRequest';
import { isInstruction } from '@shared/session/runFacts';
import type { WithBlobs } from '@shared/session/historyTurns';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { InboxItem } from './Inbox';

interface FollowUpDisplay {
  readonly text: string;
  /** Typed workflow delivery facts logged beside the collapsed row text. */
  readonly scriptSummary?: ScriptDeliverySummary;
}

/** A follow-up as its transcript row shows it: its `displayText`, else its
 *  text; a child's workflow delivery also carries its summary typed, so
 *  renderers never re-extract it from the text. */
export function followUpDisplay(followUp: FollowUpContent): FollowUpDisplay {
  const text = followUp.displayText ?? followUp.text;
  const { from } = followUp;
  const scriptSummary =
    from.kind === 'run' && from.relation === 'child'
      ? parseScriptDeliverySummary(followUp.text)
      : undefined;
  return scriptSummary ? { text, scriptSummary } : { text };
}

/** What the run was asked to do, joined from its instructing input. */
export function userFollowUpInstruction(
  followUps: readonly FollowUpContent[],
): string | undefined {
  const instruction = followUps
    .filter(isInstruction)
    .map((followUp) => followUp.text)
    .join('\n\n')
    .trim();
  return instruction || undefined;
}

/** The `followup.queued` row one send writes, with the blobs its media
 *  brings: its id is the delivery id when the producer gave one, a run
 *  sender gets its relation to the recipient, a delivery or notice its
 *  `displayText`, and a host's notification waits for the turn's end. */
export function queuedRow(
  item: InboxItem,
  hold: QueuedFollowUp['holdUntil'],
  relationOf: (sender: RunId) => RunRelation,
): WithBlobs<Omit<QueuedFollowUp, 'commit'>> {
  const { from: input, deliveryId, media, blobs, control, text } = item;
  const from: FollowUpSender =
    input.kind === 'run'
      ? { kind: 'run', runId: input.runId, relation: relationOf(input.runId) }
      : input;
  // A delivery or notice shows its envelope's summary, decided once here; a
  // person's own message is shown as typed.
  const summary = from.kind === 'user' ? text : summarizeSubagentFollowup(text);
  const displayText =
    item.displayText ?? (summary === text ? undefined : summary);
  const holdUntil = hold ?? (from.kind === 'notification' ? 'turn' : undefined);
  return {
    followUpId: deliveryId ?? randomUUID(),
    ...(holdUntil ? { holdUntil } : {}),
    ...(control ? { control } : {}),
    ...(blobs !== undefined && { blobs }),
    content: {
      text,
      ...(displayText !== undefined && { displayText }),
      ...(media !== undefined && { media: [...media] }),
      from,
    },
  };
}

/**
 * Who a producer says a follow-up is from. Runs talk as a graph: any run may
 * message any run in the project, whatever their places in the supervision
 * tree. A run names only itself; the recipient's admission
 * (`Inbox.send`) stamps how it relates to the recipient.
 */
export type FollowUpSenderInput =
  | Exclude<FollowUpSender, { readonly kind: 'run' }>
  | { readonly kind: 'run'; readonly runId: RunId };

/** The sender a tool call speaks as: its run, or the user when no run
 *  calls it. */
export function senderOf(caller: RunId | undefined): FollowUpSenderInput {
  return caller === undefined
    ? { kind: 'user' }
    : { kind: 'run', runId: caller };
}

/** A receipt nothing will change: answered, or unanswered. */
const finished = ({ state }: FollowUpReceipt): boolean =>
  state === 'answered' || state === 'unanswered';

/**
 * Input `followUpId` of run `runId` as its committed rows say it; with
 * `wait`, once its receipt is finished or the run is deleted: the tail
 * opens before the first read, so a row committed between the two is seen.
 * A wait the session's close ends is interrupted: nothing answered it.
 */
const readFollowUp = Effect.fn('readFollowUp')(function* (
  log: Pick<SessionLog['Service'], 'history' | 'now' | 'tail'>,
  runId: RunId,
  followUpId: string,
  wait = false,
): Effect.fn.Return<
  FollowUpRecord | 'unknown' | 'deleted',
  DatabaseReadFailed
> {
  const run = qualifyAggregateId('run', runId);
  const read = Effect.map(log.history(run, 1, RECEIPT_ROW_TYPES), (rows) =>
    followUpReceipt(rows, followUpId),
  );
  const done = (found: Effect.Success<typeof read>) =>
    typeof found === 'string' || finished(found.receipt);
  const from = log.now();
  const first = yield* read;
  if (!wait || done(first)) return first;
  const kinds: ReadonlySet<string> = new Set(RECEIPT_ROW_TYPES);
  const later = yield* log.tail(from).pipe(
    Stream.filter((row) => row.aggregateId === run && kinds.has(row.type)),
    Stream.mapEffect(() => read),
    Stream.filter(done),
    Stream.runHead,
  );
  return Option.isSome(later) ? later.value : yield* Effect.interrupt;
});

/** The follow-up id of a caller's `followUp.send` named `id`: scoped to its
 *  run and to that request kind, apart from every id a run mints. */
export const sentFollowUpId = (id: string): string => `followUp.send/${id}`;

/** Whether two follow-ups ask the same of their run: compared as stored,
 *  never by serialization order. */
const sameRequest = Schema.toEquivalence(FollowUpRequestSchema);

/** Fail `Conflict` unless `row` asks what the message first sent under the
 *  caller's id `caller` asked, as the run's rows say it. */
export const sameAsFirst = (
  log: Pick<SessionLog['Service'], 'history'>,
  runId: RunId,
  row: Omit<QueuedFollowUp, 'commit'>,
  caller: string,
): Effect.Effect<void, Conflict | DatabaseReadFailed> =>
  Effect.flatMap(
    log.history(qualifyAggregateId('run', runId), 1, RECEIPT_ROW_TYPES),
    (rows) => {
      const first = followUpReceipt(rows, row.followUpId);
      return typeof first === 'string' || sameRequest(first.queued, row)
        ? Effect.void
        : Effect.fail(new Conflict({ runId, id: caller }));
    },
  );

/**
 * Whether run `runId` already holds `item`, a message under the id its
 * caller named it by (`InboxItem.caller`; false with none), whatever the
 * run's input takes now: a different message under that id fails
 * {@link Conflict}. Its media is read (`attach`) to compare as stored.
 */
export const sentBefore = Effect.fn('sentBefore')(function* (
  runId: RunId,
  item: InboxItem,
  hold: QueuedFollowUp['holdUntil'],
  attach?: Effect.Effect<Pick<InboxItem, 'media' | 'blobs'>, Error>,
): Effect.fn.Return<boolean, Error, SessionLog> {
  const id = item.caller;
  if (id === undefined) return false;
  const log = yield* SessionLog;
  const deliveryId = sentFollowUpId(id);
  const first = yield* readFollowUp(log, runId, deliveryId);
  // None, or a deleted run, whose send the path past this refuses.
  if (typeof first === 'string') return false;
  const media = attach === undefined ? {} : yield* attach;
  // The relation it was stamped with: a retry after a detach is the same
  // request, not a new one.
  const stamped = first.queued.content.from;
  const asked = queuedRow({ ...item, ...media, deliveryId }, hold, () =>
    stamped.kind === 'run' ? stamped.relation : 'peer',
  );
  if (!sameRequest(first.queued, asked))
    return yield* new Conflict({ runId, id });
  return true;
});

/** The receipt of the message sent to run `runId` under the caller's `id`;
 *  with `wait`, once it is answered or unanswered. */
export const sentReceipt = Effect.fn('sentReceipt')(function* (
  log: Pick<SessionLog['Service'], 'history' | 'now' | 'tail'>,
  req: {
    readonly runId: RunId;
    readonly id: string;
    readonly wait?: boolean | null;
  },
): Effect.fn.Return<FollowUpReceipt, Rejected | Unavailable> {
  const { runId } = req;
  const found = yield* Effect.orDie(
    readFollowUp(log, runId, sentFollowUpId(req.id), req.wait === true),
  );
  if (found === 'unknown')
    return yield* new Rejected({
      reason: 'No message was sent under that id.',
    });
  if (found === 'deleted')
    return yield* new Unavailable({
      runId,
      reason: 'The run was deleted, and its messages with it.',
    });
  return found.receipt;
});
