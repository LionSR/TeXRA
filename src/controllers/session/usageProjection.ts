/**
 * The display projection of a run's spend. A run with a ledger stores its
 * usage once, on each priced `model.message` response (and a child's cost on
 * the `tool.result` that adds it); every display read derives the per-turn
 * `usage` rows renderers fold from those rows, here, in SQL, so no reader
 * decodes a response only to read its usage.
 */
/**
 * The `usage` rows a run with a ledger never stores, projected from the rows
 * that hold its spend: one per priced `model.message` response, from the
 * response's own `usage`, and one per `tool.result` that adds a child's cost
 * to the run (the one usage operation a settlement makes). Each keeps its
 * source row's envelope, so its identity is that row's (aggregate, seq).
 * `json_patch` drops the fields a response left out. Every display read
 * unions it in; a ledger read never sees it.
 */
export const USAGE_ROWS = `(
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
WHERE e.type = 'model.message.1'
  AND json_extract(e.data, '$.payload.kind') = 'response'
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
