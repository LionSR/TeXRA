/**
 * The history query contract: the tables the query store holds and the
 * views over them, as SQL, with the summary the executions tool description
 * renders. The store holds only display rows (`Database.readDisplay`) and
 * the session view's runs, so nothing a query names can reach a run history
 * row, a private run record, or an envelope column: they are never copied in.
 */

// Local imports
import { RUN_LIFECYCLE_READY, runIdentityName } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';

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
-- Copied whole from the session view's runs (replaceRuns), so a run's
-- lifecycle, parent, title, model and usage follow the view's rules.
CREATE TABLE runs (id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT, name TEXT,
  model TEXT, description TEXT, started_at TEXT, lifecycle TEXT, outcome TEXT,
  cost REAL, input_tokens INTEGER, output_tokens INTEGER);
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

/** Everything the store runs once, before the first row arrives. */
export const HISTORY_SCHEMA_SQL = [
  TABLES,
  RUN_TREE,
  MESSAGES,
  TOOL_CALLS,
  USAGE,
].join('\n');

/** The longest text value the store holds whole: a longer one, a large
 *  tool output most often, is cut to this many characters and marked with
 *  its full length, so a long history stays within the store's memory. */
const HISTORY_TEXT_LIMIT = 16 * 1024;
/** `value`, or a text value past {@link HISTORY_TEXT_LIMIT} cut to it. */
export const cutText = <T>(value: T): T | string =>
  typeof value === 'string' && value.length > HISTORY_TEXT_LIMIT
    ? `${value.slice(0, HISTORY_TEXT_LIMIT)}… [cut: ${value.length} characters in all]`
    : value;
/** The longest row the store holds whole, after its text values are cut: a
 *  longer one (many values, a large object) keeps only its length. */
export const HISTORY_ROW_LIMIT = 64 * 1024;

/** The store's writes, by the name an append op starts with: a run's rows
 *  come and go by run, the runs table is replaced whole. */
export const HISTORY_WRITE_SQL = {
  insert: 'INSERT INTO events (run_id, type, at, data) VALUES (?, ?, ?, ?)',
  remove: 'DELETE FROM events WHERE run_id = ?',
  clearRuns: 'DELETE FROM runs',
  run: 'INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
};

/** One write: its `HISTORY_WRITE_SQL` statement's name, then its values. */
export type HistoryWrite = readonly [
  keyof typeof HISTORY_WRITE_SQL,
  ...(string | number | null)[],
];

/** The writes that replace the runs table with the view's `runs`. */
export const replaceRuns = (runs: SessionView['runs']): HistoryWrite[] => [
  ['clearRuns'],
  ...Array.from(runs.values(), (run): HistoryWrite => {
    let lifecycle = 'activated';
    if (run.durableOutcome !== null) lifecycle = 'ended';
    else if (run.status === RUN_LIFECYCLE_READY) lifecycle = 'created';
    const row = [
      run.id,
      run.parentId,
      run.identity.kind,
      runIdentityName(run.identity),
      run.model,
      run.description,
      new Date(run.launchedAt).toISOString(),
      lifecycle,
      run.durableOutcome,
      run.usage.cost,
      run.usage.inputTokens,
      run.usage.outputTokens,
    ];
    return ['run', ...row.map(cutText)];
  }),
];

/** What the tool description tells the model it can query. */
export const HISTORY_VIEW_SUMMARY = `- runs(id, parent_id, kind, name, model, description, started_at, lifecycle, outcome, cost, input_tokens, output_tokens) - one row per run. lifecycle is 'created', 'activated' (launched or resumed; it may still be running or may have died) or 'ended'; outcome is set only when ended. cost/tokens are the sums of the run's usage rows so far. parent_id is NULL for a top-level or detached run.
- run_tree(ancestor_id, id, depth) - every ancestor of every run; depth 1 is the direct parent.
- messages(position, run_id, at, role, text) - user turns and assistant replies, role 'user' or 'assistant'.
- tool_calls(position, run_id, call_id, tool, input, status, result, started_at, ended_at) - input and result are JSON text; status/result are NULL while the call is open.
- usage(position, run_id, at, input_tokens, output_tokens, cache_read_input_tokens, reasoning_tokens, cost) - one row per priced model call (turns and compaction summaries).
- events(position, run_id, type, at, data) - the session's display rows, data as JSON text, which every view above but runs reads.
Times are ISO-8601 UTC text. Order by position for load order. A text value longer than ${HISTORY_TEXT_LIMIT} characters (a large tool input or result, most often) is stored cut to its first ${HISTORY_TEXT_LIMIT}, followed by '… [cut: N characters in all]'; a row whose data is still longer than ${HISTORY_ROW_LIMIT} characters is stored as {"cut": N}.`;
