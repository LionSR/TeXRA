import { randomUUID } from 'node:crypto';

import { Effect, Option, Schema, Stream } from 'effect';

import {
  deliveryTagOf,
  SUMMARIZED_TAGS,
  formatScriptDeliverySummary,
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
import type { DatabaseReadFailed } from '@shared/session/database';
import {
  followUpReceipt,
  RECEIPT_ROW_TYPES,
  type FollowUpRecord,
} from '@shared/session/runRowReads';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { runRelation } from '@shared/session/runRelation';
import { Conflict, Unavailable } from '@shared/session/runtimeRequest';
import { isInstruction } from '@shared/session/runFacts';
import type { WithBlobs } from '@shared/session/historyTurns';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { InboxItem } from './Inbox';

interface FollowUpDisplay {
  readonly text: string;
  /** Typed workflow delivery facts logged beside the collapsed row text. */
  readonly scriptSummary?: ScriptDeliverySummary;
}

export function followUpDisplay(followUp: FollowUpContent): FollowUpDisplay {
  if (followUp.displayText != null) {
    return { text: followUp.displayText };
  }
  const { from } = followUp;
  if (from.kind !== 'run' || from.relation !== 'child') {
    return { text: followUp.text };
  }
  // This is where a delivery envelope becomes a transcript row: parse the
  // workflow summary once here and carry it structured, so renderers never
  // re-extract it from the rendered text. Only the script envelopes own a
  // `<script-summary>` element — other tags' bodies are entity-escaped.
  const tag = deliveryTagOf(followUp.text);
  const scriptSummary =
    tag !== undefined && SUMMARIZED_TAGS.has(tag)
      ? parseScriptDeliverySummary(followUp.text)
      : undefined;
  if (scriptSummary) {
    return {
      text: formatScriptDeliverySummary(scriptSummary),
      scriptSummary,
    };
  }
  return { text: summarizeSubagentFollowup(followUp.text) };
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
 *  brings: its id is the delivery id when the producer gave one, and a run
 *  sender gets its relation to the recipient. */
export function queuedRow(
  item: InboxItem,
  hold: QueuedFollowUp['holdUntil'],
  relationOf: (sender: RunId) => RunRelation,
): WithBlobs<Omit<QueuedFollowUp, 'commit'>> {
  const { from, deliveryId, media, blobs, control, ...content } = item;
  return {
    followUpId: deliveryId ?? randomUUID(),
    ...(hold ? { holdUntil: hold } : {}),
    ...(control ? { control } : {}),
    ...(blobs !== undefined && { blobs }),
    content: {
      ...content,
      ...(media !== undefined && { media: [...media] }),
      from:
        from.kind === 'run'
          ? { kind: 'run', runId: from.runId, relation: relationOf(from.runId) }
          : from,
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
 * `wait`, once its receipt is finished: the tail opens before the first
 * read, so a row committed between the two is seen. None for an id no row
 * queued, a run deleted, or a session that closed while it waited.
 */
const readFollowUp = Effect.fn('readFollowUp')(function* (
  log: Pick<SessionLog['Service'], 'rows' | 'now' | 'tail'>,
  runId: RunId,
  followUpId: string,
  wait = false,
): Effect.fn.Return<Option.Option<FollowUpRecord>, DatabaseReadFailed> {
  const run = qualifyAggregateId('run', runId);
  const read = Effect.map(log.rows(run, RECEIPT_ROW_TYPES), (rows) =>
    Option.fromUndefinedOr(followUpReceipt(rows, followUpId)),
  );
  const from = log.now();
  const first = yield* read;
  if (!wait || Option.isNone(first) || finished(first.value.receipt))
    return first;
  const kinds: ReadonlySet<string> = new Set(RECEIPT_ROW_TYPES);
  return Option.flatten(
    yield* log.tail(from).pipe(
      Stream.filter((row) => row.aggregateId === run && kinds.has(row.type)),
      Stream.mapEffect(() => read),
      Stream.filter(
        (found) => Option.isNone(found) || finished(found.value.receipt),
      ),
      Stream.runHead,
    ),
  );
});

/** The follow-up id of a caller's `followUp.send` named `id`: scoped to its
 *  run and to that request kind, apart from every id a run mints. */
export const sentFollowUpId = (id: string): string => `followUp.send/${id}`;

/** Whether two follow-ups ask the same of their run: compared as stored,
 *  never by serialization order. */
const sameRequest = Schema.toEquivalence(FollowUpRequestSchema);

/**
 * Whether run `runId` already holds `item`, a caller's message under its id
 * `id`, whatever its input takes now: a different message under that id
 * fails {@link Conflict}. Its media is read (`attach`) to compare as stored.
 */
export const sentBefore = Effect.fn('sentBefore')(function* (
  runId: RunId,
  id: string,
  item: InboxItem,
  hold: QueuedFollowUp['holdUntil'],
  attach?: Effect.Effect<Pick<InboxItem, 'media' | 'blobs'>, Error>,
): Effect.fn.Return<boolean, Error, SessionLog | SessionViewAccess> {
  const deliveryId = sentFollowUpId(id);
  const first = yield* readFollowUp(yield* SessionLog, runId, deliveryId);
  if (Option.isNone(first)) return false;
  const media = attach === undefined ? {} : yield* attach;
  const view = yield* SessionViewAccess;
  const asked = queuedRow({ ...item, ...media, deliveryId }, hold, (sender) =>
    runRelation(sender, runId, (run) => view.run(run)?.parentId),
  );
  if (!sameRequest(first.value.queued, asked))
    return yield* new Conflict({ runId, id });
  return true;
});

/** The receipt of the message sent to run `runId` under the caller's `id`;
 *  with `wait`, once it is answered or unanswered. */
export const sentReceipt = (
  log: Pick<SessionLog['Service'], 'rows' | 'now' | 'tail'>,
  req: {
    readonly runId: RunId;
    readonly id: string;
    readonly wait?: boolean | null;
  },
): Effect.Effect<FollowUpReceipt, Unavailable> =>
  readFollowUp(log, req.runId, sentFollowUpId(req.id), req.wait === true).pipe(
    Effect.orDie,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new Unavailable({
              runId: req.runId,
              reason: 'No message under that id.',
            }),
          ),
        onSome: (found) => Effect.succeed(found.receipt),
      }),
    ),
  );
