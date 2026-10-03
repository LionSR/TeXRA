/**
 * The history query contract: the one table the query store holds and the
 * views over it, as SQL, with the summary the executions tool description
 * renders. The store holds only display rows (`Database.readDisplay`), so
 * nothing a query names can reach a run history row, a private run record, or an
 * envelope column: they are never copied in.
 *
 * The views apply the fold's lifecycle rules (`sessionFold.ts`) so a query
 * never has to: a `run.detach` severs the parent edge, and a later
 * `run.activate` reopens a run whose earlier `run.end` belonged to its
 * previous lifecycle. A vocabulary change that moves a row these views read
 * updates them in the same change.
 */

/** `events.position` is load order, not the database's commit ordinal: a
 *  rebuilt store renumbers it. Times are ISO-8601 UTC text. */
const TABLES = `
CREATE TABLE events (
  position INTEGER PRIMARY KEY,
  run_id   TEXT NOT NULL,
  type     TEXT NOT NULL,
  at       TEXT NOT NULL,
  data     TEXT NOT NULL
);
CREATE INDEX events_run_type ON events(run_id, type, position);
CREATE INDEX events_type ON events(type, position);
CREATE INDEX events_tool_call
  ON events(run_id, type, json_extract(data, '$.logId'));
`;

const RUNS = `
CREATE VIEW runs AS
WITH lifecycle AS (
  SELECT run_id, type, at, data,
    ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY position DESC) AS latest
  FROM events WHERE type IN ('run.activate', 'run.end')
)
SELECT
  s.run_id AS id,
  CASE WHEN EXISTS (
    SELECT 1 FROM events d WHERE d.run_id = s.run_id AND d.type = 'run.detach'
  ) THEN NULL ELSE json_extract(s.data, '$.parent.id') END AS parent_id,
  json_extract(s.data, '$.identity.kind') AS kind,
  COALESCE(
    json_extract(s.data, '$.identity.agent'),
    json_extract(s.data, '$.identity.workflowName'),
    json_extract(s.data, '$.identity.tool')
  ) AS name,
  json_extract(s.data, '$.category') AS category,
  COALESCE(
    (SELECT json_extract(m.data, '$.model') FROM events m
      WHERE m.run_id = s.run_id AND m.type = 'run.model'
      ORDER BY m.position DESC LIMIT 1),
    (SELECT json_extract(c.data, '$.config.model') FROM events c
      WHERE c.run_id = s.run_id AND c.type = 'run.config'
      ORDER BY c.position DESC LIMIT 1)
  ) AS model,
  (SELECT json_extract(x.data, '$.description') FROM events x
    WHERE x.run_id = s.run_id AND x.type = 'run.description'
    ORDER BY json_extract(x.data, '$.by') = 'user' DESC, x.position DESC
    LIMIT 1) AS description,
  s.at AS started_at,
  CASE l.type WHEN 'run.end' THEN 'ended' WHEN 'run.activate' THEN 'activated'
    ELSE 'created' END AS lifecycle,
  CASE WHEN l.type = 'run.end' THEN l.at END AS ended_at,
  CASE WHEN l.type = 'run.end' THEN json_extract(l.data, '$.outcome') END AS outcome,
  CASE WHEN l.type = 'run.end' THEN json_extract(l.data, '$.error.message') END AS error,
  CASE WHEN l.type = 'run.end' THEN u.cost END AS cost,
  CASE WHEN l.type = 'run.end' THEN u.input_tokens END AS input_tokens,
  CASE WHEN l.type = 'run.end' THEN u.output_tokens END AS output_tokens
FROM events s
LEFT JOIN lifecycle l ON l.run_id = s.run_id AND l.latest = 1
LEFT JOIN (
  SELECT run_id, total(json_extract(data, '$.usage.cost')) AS cost,
    total(json_extract(data, '$.usage.inputTokens')) AS input_tokens,
    total(json_extract(data, '$.usage.outputTokens')) AS output_tokens
  FROM events WHERE type = 'usage' GROUP BY run_id
) u ON u.run_id = s.run_id
WHERE s.type = 'run.start';
`;

const RUN_TREE = `
CREATE VIEW run_tree AS
WITH RECURSIVE tree(ancestor_id, id, depth) AS (
  SELECT parent_id, id, 1 FROM runs WHERE parent_id IS NOT NULL
  UNION ALL
  SELECT r.parent_id, tree.id, tree.depth + 1
  FROM tree JOIN runs r ON r.id = tree.ancestor_id
  WHERE r.parent_id IS NOT NULL
)
SELECT ancestor_id, id, depth FROM tree;
`;

/** The user's turns and each round's authoritative model text: the
 *  transcript fold settles a streamed response to `response.finalized`. */
const MESSAGES = `
CREATE VIEW messages AS
SELECT position, run_id, at, 'user' AS role,
  json_extract(data, '$.message') AS text
FROM events
WHERE type = 'log' AND json_extract(data, '$.messageType') = 'userMessage'
UNION ALL
SELECT position, run_id, at, 'assistant', json_extract(data, '$.text')
FROM events WHERE type = 'response.finalized';
`;

const TOOL_CALLS = `
CREATE VIEW tool_calls AS
SELECT s.position, s.run_id,
  json_extract(s.data, '$.logId') AS call_id,
  json_extract(s.data, '$.toolName') AS tool,
  json_extract(s.data, '$.input') AS input,
  json_extract(e.data, '$.status') AS status,
  json_extract(e.data, '$.result') AS result,
  s.at AS started_at,
  e.at AS ended_at
FROM events s
LEFT JOIN events e ON e.run_id = s.run_id AND e.type = 'tool.end'
  AND json_extract(e.data, '$.logId') = json_extract(s.data, '$.logId')
WHERE s.type = 'tool.start';
`;

/** One row per priced model turn of the run it is on (`usage` rows are
 *  never running totals), so a run's spend is their sum. */
const USAGE = `
CREATE VIEW usage AS
SELECT position, run_id, at,
  json_extract(data, '$.usage.inputTokens') AS input_tokens,
  json_extract(data, '$.usage.outputTokens') AS output_tokens,
  json_extract(data, '$.usage.cacheReadInputTokens') AS cache_read_input_tokens,
  json_extract(data, '$.usage.reasoningTokens') AS reasoning_tokens,
  json_extract(data, '$.usage.cost') AS cost
FROM events WHERE type = 'usage';
`;

const TODOS = `
CREATE VIEW todos AS
WITH latest AS (
  SELECT run_id, data,
    ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY position DESC) AS latest
  FROM events
  WHERE type = 'run.fact' AND json_extract(data, '$.fact.key') = 'todos'
)
SELECT latest.run_id, CAST(item.key AS INTEGER) + 1 AS item,
  json_extract(item.value, '$.content') AS content,
  json_extract(item.value, '$.status') AS status
FROM latest, json_each(latest.data, '$.fact.todos') AS item
WHERE latest.latest = 1;
`;

/** Everything the store runs once, before the first row arrives. */
export const HISTORY_SCHEMA_SQL = [
  TABLES,
  RUNS,
  RUN_TREE,
  MESSAGES,
  TOOL_CALLS,
  USAGE,
  TODOS,
].join('\n');

/** The longest text value the store holds whole: a longer one, a large
 *  tool output most often, is cut to this many characters and marked with
 *  its full length, so a long history stays within the store's memory. */
export const HISTORY_TEXT_LIMIT = 16 * 1024;
/** The longest row the store holds whole, after its text values are cut: a
 *  longer one (many values, a large object) keeps only its length. */
export const HISTORY_ROW_LIMIT = 64 * 1024;

export const HISTORY_INSERT_SQL =
  'INSERT INTO events (run_id, type, at, data) VALUES (?, ?, ?, ?)';
export const HISTORY_REMOVE_SQL = 'DELETE FROM events WHERE run_id = ?';

/** What the tool description tells the model it can query. */
export const HISTORY_VIEW_SUMMARY = `- runs(id, parent_id, kind, name, category, model, description, started_at, lifecycle, ended_at, outcome, error, cost, input_tokens, output_tokens) - one row per run. lifecycle is 'created', 'activated' (launched or resumed; it may still be running or may have died) or 'ended'; ended_at/outcome/error/cost/tokens are set only when ended, and cost/tokens are the sums of the run's usage rows. parent_id is NULL for a top-level or detached run.
- run_tree(ancestor_id, id, depth) - every ancestor of every run; depth 1 is the direct parent.
- messages(position, run_id, at, role, text) - user turns and assistant replies, role 'user' or 'assistant'.
- tool_calls(position, run_id, call_id, tool, input, status, result, started_at, ended_at) - input and result are JSON text; status/result are NULL while the call is open.
- usage(position, run_id, at, input_tokens, output_tokens, cache_read_input_tokens, reasoning_tokens, cost) - one row per priced model call (turns and compaction summaries).
- todos(run_id, item, content, status) - each run's current task list.
- events(position, run_id, type, at, data) - every row above is derived from this: the session's display rows, data as JSON text.
Times are ISO-8601 UTC text. Order by position for load order. A text value longer than ${HISTORY_TEXT_LIMIT} characters (a large tool input or result, most often) is stored cut to its first ${HISTORY_TEXT_LIMIT}, followed by '… [cut: N characters in all]'; a row whose data is still longer than ${HISTORY_ROW_LIMIT} characters is stored as {"cut": N}.`;
