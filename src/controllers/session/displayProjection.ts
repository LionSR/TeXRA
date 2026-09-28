/**
 * The display tier's SQL: the listing read (7.2) and the projection of a
 * run's spend every display read unions in. A run with a ledger stores its
 * usage once, on each priced `model.message` response and `model.compaction`
 * summary (and a child's cost on the `tool.result` that adds it); every
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
 * `model.compaction` summary, from the row's own `usage`, and one per
 * `tool.result` that adds a child's cost
 * to the run (the one usage operation a settlement makes). Each keeps its
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
UNION ALL
SELECT "commit", aggregate_id, seq, 'usage.1', origin, at,
  json_object('usage', json_object('inputTokens', 0, 'outputTokens', 0,
    'cost', cost))
FROM (
  SELECT e."commit", e.aggregate_id, e.seq, e.origin, e.at, (
    SELECT total(json_extract(op.value, '$.amount'))
    FROM json_each(e.data, '$.payload.stateMutation') op
    WHERE json_extract(op.value, '$.op') = 'add'
      AND json_extract(op.value, '$.path[0]') = 'usage'
      AND json_extract(op.value, '$.path[1]') = 'totalCost'
  ) AS cost
  FROM event e WHERE e.type = 'tool.result.1'
)
WHERE cost > 0
)`;

/**
 * The `run.model` rows no run stores, projected from its `flow.snapshot`
 * rows: one at each snapshot whose `modelId` differs from the one before it,
 * so a run that never switched projects none and reads its launch model from
 * `run.config`. Each keeps its snapshot's envelope.
 */
const MODEL_ROWS = `(
SELECT "commit", aggregateId, seq, 'run.model.1' AS type, origin, at,
  json_object('model', model) AS data
FROM (
  SELECT e."commit" AS "commit", e.aggregate_id AS aggregateId, e.seq,
    e.origin AS origin, e.at,
    json_extract(e.data, '$.payload.runtime.modelId') AS model,
    LAG(json_extract(e.data, '$.payload.runtime.modelId')) OVER (
      PARTITION BY e.aggregate_id ORDER BY e.seq) AS previous
  FROM event e WHERE e.type = 'flow.snapshot.1'
)
WHERE previous IS NOT NULL AND model IS NOT previous
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
 *  it switched (`MODEL_ROWS`), in commit order. */
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
  SELECT "commit", aggregateId, seq, type, origin, at, data FROM (
    SELECT *, MAX("commit") FROM ${MODEL_ROWS} GROUP BY aggregateId
  )
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
