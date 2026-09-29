/**
 * The display tier's SQL: the listing read (7.2) and the projection of a
 * run's spend every display read unions in. A run with a ledger stores its
 * usage once, on each priced `model.message` response and `model.compaction`
 * summary, and a child's on its own run, never its parent's; every
 * display read derives the per-call `usage` rows renderers fold from those
 * rows, here, in SQL, so no reader decodes a response only to read its usage. The listing instead carries one
 * row per run, its spend so far, which {@link totalRunUsage} sums.
 */
import { Result } from 'effect';
import { z } from 'zod';

import { parseJsonWith } from '@common/parsing/safeParseJson';
import {
  ExtendedTokenUsageStatsSchema,
  SessionEventDraftSchema,
  listingTypeOf,
  sumUsageStats,
} from '@shared/schemas';

/** The columns every read selects, as `decodeEvent` takes them. */
export const EVENT_COLUMNS = `e."commit" AS "commit", e.aggregate_id AS aggregateId,
  e.seq, e.type, e.origin AS origin, e.at, e.data`;
/** Listing arms of the present vocabulary; requests and follow-ups are sets. */
export const LISTING_TYPES = SessionEventDraftSchema.options
  .map((schema) => schema.shape.type.value)
  .filter(
    (type) =>
      listingTypeOf({ type }) !== null &&
      type !== 'request.opened' &&
      type !== 'request.decided' &&
      type !== 'followup.queued' &&
      type !== 'followup.consumed',
  )
  .map((type) => `${type}.1`);
/** Latest per aggregate, type and family (`listingKeyOf`). */
export const LISTING_GROUP = `aggregate_id, type, json_extract(data, '$.fact.key'),
  json_extract(data, '$.plugin'), json_extract(data, '$.kind')`;

/**
 * The `usage` rows a run with a ledger never stores, projected from the rows
 * that hold its spend: one per priced `model.message` response or
 * `model.compaction` summary, from the row's own `usage`. Each keeps its
 * source row's envelope, so its identity is that row's (aggregate, seq).
 * `json_patch` drops the fields a response left out. Every display read
 * unions it in; a ledger read never sees it.
 */
const USAGE_ROWS = `(
SELECT e."commit" AS "commit", e.aggregate_id AS aggregateId, e.seq,
  'usage.1' AS type, e.origin AS origin, e.at,
  json_object('usage', json_patch('{}', json_object(
    'inputTokens', json_extract(e.data, '$.payload.usage.inputTokens'),
    'outputTokens', json_extract(e.data, '$.payload.usage.outputTokens'),
    'cost', json_extract(e.data, '$.payload.usage.cost'),
    'cacheReadInputTokens',
      json_extract(e.data, '$.payload.usage.cachedInputTokens'),
    'cacheMissInputTokens',
      json_extract(e.data, '$.payload.usage.cacheMissInputTokens'),
    'cacheCreationInputTokens',
      json_extract(e.data, '$.payload.usage.cacheCreationTokens'),
    'reasoningTokens', json_extract(e.data, '$.payload.usage.reasoningTokens'),
    'toolUseTokens',
      json_extract(e.data, '$.payload.usage.toolUsePromptTokens'),
    'elapsedTime',
      json_extract(e.data, '$.payload.usage.responseTimeMs') / 1000.0,
    'usageRoute', json_extract(e.data, '$.payload.usage.usageRoute'),
    'usagePlan', json_extract(e.data, '$.payload.usage.usagePlan')
  ))) AS data
FROM event e
WHERE (e.type = 'model.compaction.1' OR (e.type = 'model.message.1'
    AND json_extract(e.data, '$.payload.kind') = 'response'))
  AND json_type(e.data, '$.payload.usage') = 'object'
)`;

/**
 * The `run.model` rows no run stores, projected from its `run.snapshot`
 * rows: one at each snapshot whose `modelId` differs from the snapshot before
 * it, so a run that never switched projects none and reads its launch model
 * from `run.config`. Each keeps its snapshot's envelope. The earlier snapshot
 * is one indexed lookup (`event_agg_type_seq`) from the row being read, so a
 * read's commit or aggregate range reaches the snapshots themselves and an
 * incremental read costs what it reads.
 */
const MODEL_ROWS = `(
SELECT e."commit" AS "commit", e.aggregate_id AS aggregateId, e.seq,
  'run.model.1' AS type, e.origin AS origin, e.at,
  json_object('model', json_extract(e.data, '$.payload.runtime.modelId')) AS data
FROM event e
WHERE e.type = 'run.snapshot.1'
  AND json_extract(e.data, '$.payload.runtime.modelId') IS NOT COALESCE((
    SELECT json_extract(p.data, '$.payload.runtime.modelId') FROM event p
    WHERE p.aggregate_id = e.aggregate_id AND p.type = 'run.snapshot.1'
      AND p.seq < e.seq
    ORDER BY p.seq DESC LIMIT 1
  ), json_extract(e.data, '$.payload.runtime.modelId'))
)`;

/** A snapshot row's model, spelled as `event_snapshot_model` indexes it. */
const SNAPSHOT_MODEL = (alias: string) =>
  `json_extract(${alias}.data, '$.payload.runtime.modelId')`;

/** Whether snapshot `l`'s run has a snapshot whose model sorts `op` its
 *  own: one seek in `event_snapshot_model`. */
const OTHER_MODEL = (op: '<' | '>') => `EXISTS (
    SELECT 1 FROM event o
    WHERE o.aggregate_id = l.aggregate_id AND o.type = 'run.snapshot.1'
      AND ${SNAPSHOT_MODEL('o')} ${op} ${SNAPSHOT_MODEL('l')})`;

/**
 * The listing's {@link MODEL_ROWS}: each run's latest projected `run.model`
 * row, read without walking its history. With `m` the model of the run's
 * latest snapshot and `x` its latest snapshot of another model (a
 * snapshot's `modelId` is a required string, so `<>` is `IS NOT`),
 * a run with no `x` never switched and projects nothing; otherwise its
 * latest change is the first snapshot after `x`: its predecessor is `x`,
 * and every snapshot after it keeps `m`. That row is the one `MODEL_ROWS`
 * projects there, with its envelope. Whether an `x` exists is one seek in
 * `event_snapshot_model`, so a run that never switched costs its latest
 * snapshot; one that did walks back only to its last switch. The joins are
 * `CROSS JOIN`s to hold that order: a store is never `ANALYZE`d, and without
 * statistics the planner scans `event` first, row by row.
 */
const LATEST_MODEL_ROWS = `(
SELECT c."commit" AS "commit", c.aggregate_id AS aggregateId, c.seq,
  'run.model.1' AS type, c.origin AS origin, c.at,
  json_object('model', ${SNAPSHOT_MODEL('c')}) AS data
FROM (
  SELECT l.aggregate_id AS aggregateId, (
    SELECT p.seq FROM event p INDEXED BY event_agg_type_seq
    WHERE p.aggregate_id = l.aggregate_id AND p.type = 'run.snapshot.1'
      AND ${SNAPSHOT_MODEL('p')} <> ${SNAPSHOT_MODEL('l')}
    ORDER BY p.seq DESC LIMIT 1
  ) AS x
  FROM (
    SELECT s.aggregate_id AS aggregateId, (
      SELECT MAX(seq) FROM event
      WHERE aggregate_id = s.aggregate_id AND type = 'run.snapshot.1'
    ) AS seq
    FROM event_sequence s
  ) latest
  CROSS JOIN event l ON l.aggregate_id = latest.aggregateId
    AND l.seq = latest.seq
  WHERE ${OTHER_MODEL('<')} OR ${OTHER_MODEL('>')}
) switched
CROSS JOIN event c ON c.aggregate_id = switched.aggregateId AND c.seq = (
  SELECT MIN(n.seq) FROM event n
  WHERE n.aggregate_id = switched.aggregateId AND n.type = 'run.snapshot.1'
    AND n.seq > switched.x
)
)`;

/** Every projected display row: a run's spend and its model changes. */
export const PROJECTED_ROWS = `(SELECT * FROM ${USAGE_ROWS}
UNION ALL SELECT * FROM ${MODEL_ROWS})`;

/**
 * One `usage` row per run for the listing: the envelope of the run's newest
 * priced row and, as its `data`, every priced row's data in commit order,
 * which {@link totalRunUsage} sums. A fold takes it as the run's spend
 * through that commit, so a cold listing carries one row per run, not one
 * per turn.
 */
const RUN_USAGE = `(
SELECT MAX("commit") AS "commit", aggregateId, seq, type, origin, at,
  json_group_array(json(data) ORDER BY "commit") AS data
FROM (
  SELECT ${EVENT_COLUMNS} FROM event e WHERE e.type = 'usage.1'
  UNION ALL SELECT * FROM ${USAGE_ROWS}
)
GROUP BY aggregateId
)`;

/** The listing: each run's latest listing rows, its open requests and
 *  queued follow-ups, its spend (`RUN_USAGE`) and its current model where
 *  it switched (`LATEST_MODEL_ROWS`), in commit order. */
export const READ_LISTING = `
WITH latest AS (
  SELECT aggregate_id, type, MAX(seq) AS seq FROM event
  WHERE type IN (SELECT value FROM json_each(?))
  GROUP BY ${LISTING_GROUP}
), selected AS (
  SELECT ${EVENT_COLUMNS} FROM latest
  JOIN event e ON e.aggregate_id = latest.aggregate_id
    AND e.type = latest.type AND e.seq = latest.seq
  UNION ALL
  SELECT ${EVENT_COLUMNS} FROM event e
  WHERE e.type = 'request.opened.1' AND NOT EXISTS (
    SELECT 1 FROM event decided
    WHERE decided.aggregate_id = e.aggregate_id
      AND decided.type = 'request.decided.1'
      AND json_extract(decided.data, '$.requestId') = json_extract(e.data, '$.requestId')
  )
  UNION ALL
  SELECT ${EVENT_COLUMNS} FROM event e
  WHERE e.type = 'followup.queued.1' AND NOT EXISTS (
    SELECT 1 FROM event consumed
    WHERE consumed.aggregate_id = e.aggregate_id
      AND consumed.type = 'followup.consumed.1'
      AND json_extract(consumed.data, '$.followUpId') = json_extract(e.data, '$.followUpId')
  )
  UNION ALL
  SELECT * FROM ${RUN_USAGE}
  UNION ALL
  SELECT * FROM ${LATEST_MODEL_ROWS}
)
SELECT * FROM selected
ORDER BY "commit"
`;

const RunUsagePartsSchema = z.array(
  z.object({
    usage: ExtendedTokenUsageStatsSchema.omit({ percentageCached: true }),
  }),
);

/**
 * A {@link RUN_USAGE} row as the `usage` row it stands for: its priced rows
 * summed by `sumUsageStats` in commit order, the sum a fold adds each later
 * turn with, so the total is exactly what the turns would have folded to.
 * Every other row passes through.
 */
export function totalRunUsage(
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (row.type !== 'usage.1') return row;
  const parts = Result.getOrThrow(
    parseJsonWith(z.string().parse(row.data), RunUsagePartsSchema),
  );
  return {
    ...row,
    data: JSON.stringify({
      usage: sumUsageStats(parts.map((part) => part.usage)),
    }),
  };
}
