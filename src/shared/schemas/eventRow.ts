/**
 * The two persisted row shapes of the substrate's C1 schema
 * (`docs/proposals/2026-09-03-persistence-substrate-decision.md`, 6.1): the
 * `event` row and the `event_sequence` row, plus the codec between a row and
 * the `SessionEvent` vocabulary the fold already speaks.
 *
 * A row is not a second event vocabulary. The envelope C1 gives its own
 * columns (`aggregate_id`, `seq`, `commit`, `owner_id`, `at`) and the arm
 * discriminant (`type`) are columns; `data` carries only what is left of the
 * arm, so no field is stored twice and a decoded row is validated by
 * `SessionEventSchema` itself. The SQL side aliases its snake-case columns to
 * these names, so the shared vocabulary never learns SQL spelling.
 *
 * These schemas describe persisted data, so nothing here is `.catch()`ed and
 * nothing is defaulted: a row that does not parse is corruption to report,
 * never a value to invent.
 */
import { z } from 'zod';

import {
  AggregateIdSchema,
  AggregateSeqSchema,
  CommitOrdinalSchema,
  OwnerIdSchema,
  SessionEventSchema,
  type SessionEvent,
  type SessionEventDraft,
} from './sessionEvent';

/**
 * One `event` row. `commit` is the database-wide `AUTOINCREMENT` ordinal:
 * monotone, never reused, and always above zero on a stored row (zero is the
 * cursor of a reader that has seen nothing). `at` is the publish clock,
 * informational only, and an integer because C1 stores it in an `INTEGER`
 * column of a `STRICT` table.
 */
export const EventRowSchema = z.strictObject({
  commit: CommitOrdinalSchema,
  aggregateId: AggregateIdSchema,
  seq: AggregateSeqSchema,
  type: z.string().min(1),
  /** The process that appended the row (C5); historical attribution only,
   *  never a present claim. */
  ownerId: OwnerIdSchema,
  at: z.int(),
  /** The arm's remaining fields as JSON; `eventFromRow` validates them. */
  data: z.string(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

/**
 * One `event_sequence` row: an aggregate's last assigned `seq`, its current
 * writer (C5, null when unclaimed), its owning lifecycle (C9, null for an
 * independent root), and whether its tombstone has closed it.
 */
export const EventSequenceRowSchema = z.strictObject({
  aggregateId: AggregateIdSchema,
  seq: AggregateSeqSchema,
  ownerId: OwnerIdSchema.nullable(),
  parentId: AggregateIdSchema.nullable(),
  /** SQLite has no boolean type; C1 stores the flag as `INTEGER`. */
  closed: z.union([z.literal(0), z.literal(1)]),
});

/**
 * The `data` column of a draft: the arm minus the two fields C1 gives their
 * own columns. The rest of the envelope is not on a draft at all, so no
 * caller can smuggle a `seq`, `commit`, `ownerId`, or `at` into the payload.
 */
export function eventPayload(draft: SessionEventDraft): string {
  const { type, aggregateId, ...payload } = draft;
  void type;
  void aggregateId;
  return JSON.stringify(payload);
}

/** A stored row read back as the event it was, validated as a whole. */
export function eventFromRow(row: EventRow): SessionEvent {
  return SessionEventSchema.parse({
    ...(JSON.parse(row.data) as Record<string, unknown>),
    type: row.type,
    aggregateId: row.aggregateId,
    seq: row.seq,
    commit: row.commit,
    ownerId: row.ownerId,
    at: row.at,
  });
}
