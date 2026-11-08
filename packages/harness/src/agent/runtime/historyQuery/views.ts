/**
 * The history query contract: the tables the query store holds, as SQL,
 * with the summary the executions tool description renders. Each column is
 * filled from a decoded value (a run's call facts, the session view's
 * runs), never copied from a stored row, so the store's row encoding can
 * change behind these tables and a query never reaches a private record,
 * an envelope column or the session database.
 */

// Local imports
import { runIdentityName } from '@shared/schemas';
import {
  isInterrupted,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';

/**
 * The tables a history query reads and their columns, in order: the public
 * contract of `executions` `query`. A column changes meaning only with a
 * new name. `position` is load order, not the database's commit ordinal: a
 * rebuilt store renumbers it.
 */
export const HISTORY_TABLES = Object.freeze({
  runs: Object.freeze([
    'id',
    'parent_id',
    'parent_call_position',
    'kind',
    'name',
    'model',
    'description',
    'started_at',
    'status',
    'outcome',
    'cost',
    'input_tokens',
    'output_tokens',
    'calls_unreadable',
  ] as const),
  run_tree: Object.freeze(['ancestor_id', 'id', 'depth'] as const),
  tool_calls: Object.freeze([
    'position',
    'run_id',
    'call_id',
    'script_call_id',
    'tool',
    'input',
    'attempt',
    'status',
    'output',
    'value',
    'error',
    'issued_at',
    'started_at',
    'ended_at',
  ] as const),
  model_calls: Object.freeze([
    'position',
    'run_id',
    'invocation_id',
    'attempt',
    'model',
    'status',
    'output',
    'error',
    'input_tokens',
    'output_tokens',
    'cost',
    'started_at',
    'ended_at',
  ] as const),
});

/** A table's columns, `key` declared as its primary key; every other
 *  column holds the value it is given (no type affinity). */
const table = (
  name: 'runs' | 'tool_calls' | 'model_calls',
  key: { readonly column: string; readonly type: 'TEXT' | 'INTEGER' },
) =>
  `CREATE TABLE ${name} (${HISTORY_TABLES[name]
    .map((column) =>
      column === key.column ? `${column} ${key.type} PRIMARY KEY` : column,
    )
    .join(', ')});`;

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

/** Everything the store runs once, before the first row arrives. */
export const HISTORY_SCHEMA_SQL = [
  // `runs` is keyed by id, which `run_tree` joins on at every step.
  table('runs', { column: 'id', type: 'TEXT' }),
  table('tool_calls', { column: 'position', type: 'INTEGER' }),
  table('model_calls', { column: 'position', type: 'INTEGER' }),
  'CREATE INDEX tool_calls_call ON tool_calls(run_id, call_id);',
  'CREATE INDEX model_calls_attempt ON model_calls(run_id, invocation_id, attempt);',
  RUN_TREE,
].join('\n');

/** One `SELECT`, `WITH`, `EXPLAIN` or `VALUES` statement, read with its
 *  comments and quoted text blanked so neither can hide structure. */
export function statementRefusal(sql: string): string | null {
  const shape = sql.replaceAll(
    /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?/g,
    ' ',
  );
  if (!/^\s*(?:select|with|explain|values)\b/i.test(shape)) {
    return 'Only a read is allowed: one SELECT, WITH, EXPLAIN or VALUES statement.';
  }
  if (shape.trim().replace(/;\s*$/, '').includes(';')) {
    return 'Send one statement per query; this one has more than one.';
  }
  return null;
}

/** The longest text value the store holds whole: a longer one, a large
 *  tool output most often, is cut to this many characters and marked with
 *  its full length, so a long history stays within the store's memory. */
const HISTORY_TEXT_LIMIT = 16 * 1024;
/** `value`, or a text value past {@link HISTORY_TEXT_LIMIT} cut to it. */
export const cutText = <T>(value: T): T | string =>
  typeof value === 'string' && value.length > HISTORY_TEXT_LIMIT
    ? `${value.slice(0, HISTORY_TEXT_LIMIT)}… [cut: ${value.length} characters in all]`
    : value;
/** The longest JSON cell the store holds whole, after its text values are
 *  cut: a longer one (many values, a large object) keeps only its length. */
const HISTORY_JSON_LIMIT = 64 * 1024;
/** `value` as a JSON cell, its long texts cut; `null` when absent. */
export const cutJson = (value: unknown): string | null => {
  if (value === undefined) return null;
  const json = JSON.stringify(value, (_key, inner: unknown) => cutText(inner));
  return json.length > HISTORY_JSON_LIMIT
    ? JSON.stringify({ cut: json.length })
    : json;
};

/** The row a call's intent and result update: its latest issue under that
 *  id in its run, as a provider may reuse a call id in a later turn. */
const LATEST_CALL =
  'SELECT max(position) FROM tool_calls WHERE run_id = :run_id AND call_id = :call_id';
/** What an open call is: running while its run is live, otherwise its
 *  result is unknown (its body may have run with nothing recorded). */
const OPEN_STATUS = `CASE WHEN run_id IN
  (SELECT id FROM runs WHERE status IN ('running', 'waiting'))
  THEN 'running' ELSE 'unknown' END`;

/** A value a history column holds. */
type Value = string | number | null;

/** What each of the store's writes binds, by parameter name. */
interface HistoryParams {
  readonly toolCall: {
    readonly position: number;
    readonly run_id: string;
    readonly call_id: string;
    readonly script_call_id: string | null;
    readonly tool: string;
    readonly input: Value;
    readonly issued_at: string;
  };
  readonly toolStart: {
    readonly attempt: number;
    readonly started_at: string;
    readonly run_id: string;
    readonly call_id: string;
  };
  readonly toolEnd: {
    readonly attempt: number;
    readonly status: string;
    readonly output: Value;
    readonly value: Value;
    readonly error: Value;
    readonly ended_at: string;
    readonly run_id: string;
    readonly call_id: string;
  };
  readonly modelAttempt: {
    readonly run_id: string;
    readonly invocation_id: string;
    readonly attempt: number;
    readonly model: string;
    readonly started_at: string;
  };
  readonly modelEnd: {
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly output: Value;
    readonly error: Value;
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly cost: number | null;
    readonly ended_at: string;
    readonly run_id: string;
    readonly invocation_id: string;
    readonly attempt: number;
  };
  readonly removeTools: { readonly run_id: string };
  readonly removeModels: { readonly run_id: string };
  readonly clearRuns: Readonly<Record<never, never>>;
  readonly run: Readonly<Record<(typeof HISTORY_TABLES.runs)[number], Value>>;
  readonly openTools: Readonly<Record<never, never>>;
  readonly openModels: Readonly<Record<never, never>>;
}

/** The store's writes, by the name an append op carries: calls are added as
 *  their facts arrive, the runs table is replaced whole, and open calls are
 *  read against it again. Each binds its `HistoryParams` by name. */
export const HISTORY_WRITE_SQL: Readonly<Record<keyof HistoryParams, string>> =
  Object.freeze({
    toolCall: `INSERT INTO tool_calls
    (position, run_id, call_id, script_call_id, tool, input, status, issued_at)
    VALUES (:position, :run_id, :call_id, :script_call_id, :tool, :input,
    'pending', :issued_at)`,
    toolStart: `UPDATE tool_calls SET attempt = :attempt, status = 'running',
    started_at = :started_at WHERE position = (${LATEST_CALL})`,
    toolEnd: `UPDATE tool_calls SET attempt = :attempt, status = :status,
    output = :output, value = :value, error = :error, ended_at = :ended_at
    WHERE position = (${LATEST_CALL})`,
    modelAttempt: `INSERT INTO model_calls
    (run_id, invocation_id, attempt, model, status, started_at)
    VALUES (:run_id, :invocation_id, :attempt, :model, 'running', :started_at)`,
    modelEnd: `UPDATE model_calls SET status = :status, output = :output,
    error = :error, input_tokens = :input_tokens,
    output_tokens = :output_tokens, cost = :cost, ended_at = :ended_at
    WHERE run_id = :run_id AND invocation_id = :invocation_id
    AND attempt = :attempt`,
    removeTools: 'DELETE FROM tool_calls WHERE run_id = :run_id',
    removeModels: 'DELETE FROM model_calls WHERE run_id = :run_id',
    clearRuns: 'DELETE FROM runs',
    run: `INSERT INTO runs (${HISTORY_TABLES.runs.join(', ')})
    VALUES (${HISTORY_TABLES.runs.map((column) => `:${column}`).join(', ')})`,
    openTools: `UPDATE tool_calls SET status = ${OPEN_STATUS}
    WHERE status IN ('running', 'unknown')`,
    openModels: `UPDATE model_calls SET status = ${OPEN_STATUS}
    WHERE status IN ('running', 'unknown')`,
  });

/** One write: its `HISTORY_WRITE_SQL` statement and the values it binds. */
export type HistoryWrite = {
  [K in keyof HistoryParams]: {
    readonly statement: K;
    readonly params: HistoryParams[K];
  };
}[keyof HistoryParams];

/** A run's status as `runs.status` words it. */
function runStatus(run: RunView): string {
  if (run.outcome !== null) return 'ended';
  if (run.position === 'ready') return 'created';
  return isInterrupted(run) ? 'interrupted' : run.position;
}

/** The writes that replace the runs table with the view's `runs` and read
 *  the open calls against it: `calls` places each tool card's call,
 *  `unreadable` says why a run's calls are missing. */
export const replaceRuns = (
  runs: SessionView['runs'],
  fed: {
    readonly calls: { readonly byCard: ReadonlyMap<string, number> };
    readonly unreadable: ReadonlyMap<string, string>;
  },
): HistoryWrite[] => [
  { statement: 'clearRuns', params: {} },
  ...Array.from(runs.values(), (run): HistoryWrite => {
    // Every cell is cut as the store holds it: a run's texts may be long.
    const params: HistoryParams['run'] = {
      id: cutText(run.id),
      parent_id: cutText(run.parentId),
      // Only a run still under its parent names the launching call: a
      // detached child's parent, and its rows, may be gone.
      parent_call_position:
        run.parentId === null || run.launch?.card == null
          ? null
          : (fed.calls.byCard.get(run.launch.card) ?? null),
      kind: cutText(run.identity.kind),
      name: cutText(runIdentityName(run.identity)),
      model: cutText(run.model),
      description: cutText(run.description),
      started_at: new Date(run.launchedAt).toISOString(),
      status: cutText(runStatus(run)),
      outcome: cutText(run.outcome),
      cost: run.usage.cost,
      input_tokens: run.usage.inputTokens,
      output_tokens: run.usage.outputTokens,
      calls_unreadable: cutText(fed.unreadable.get(run.id) ?? null),
    };
    return { statement: 'run', params };
  }),
  { statement: 'openTools', params: {} },
  { statement: 'openModels', params: {} },
];

/** What the tool description tells the model it can query. */
export const HISTORY_VIEW_SUMMARY = `- runs(${HISTORY_TABLES.runs.join(', ')}) - one row per run of this session. status is 'created', 'running', 'waiting', 'interrupted' (not ended, and no live process holds it) or 'ended'; outcome ('completed', 'failed', 'cancelled') is set only when ended. parent_id is NULL for a top-level or detached run; parent_call_position (NULL when parent_id is) is the position of the parent's tool call that launched it (join tool_calls ON tool_calls.position = runs.parent_call_position for its input and result). cost/tokens are the run's own model calls so far. calls_unreadable is NULL, or why this run's calls are missing from tool_calls and model_calls (its stored history does not read in this build).
- run_tree(${HISTORY_TABLES.run_tree.join(', ')}) - every ancestor of every run; depth 1 is the direct parent.
- tool_calls(${HISTORY_TABLES.tool_calls.join(', ')}) - one row per tool call a model turn or a script issued; script_call_id is the issuing script call (NULL for a model's call). input and value are JSON text (value: the structured result a script reads). status is 'pending' (its body has not started), 'running', 'unknown' (its body started and its run stopped with no result recorded: it may or may not have taken effect), or how it ended: 'executed', 'failed', 'skipped', 'duplicate'. output is an executed call's text, error a failed one's.
- model_calls(${HISTORY_TABLES.model_calls.join(', ')}) - one row per model request a turn sent; attempt counts retries of one invocation. status is 'running', 'unknown' (sent, and its run stopped with no answer recorded), 'completed', 'failed' (error says why) or 'cancelled'. output is a completed request's reply text. A compaction's summary call is not listed; its cost is on the run's history as the edit that landed it.
Read only: a write or a second statement is refused. Times are ISO-8601 UTC text. Within a run, position is issue order. A text value longer than ${HISTORY_TEXT_LIMIT} characters is stored cut to its first ${HISTORY_TEXT_LIMIT}, followed by '… [cut: N characters in all]'; a JSON cell still longer than ${HISTORY_JSON_LIMIT} characters is stored as {"cut": N}.`;
