# History as a queryable substrate: an executions `query` action

Date: 2026-09-26

Status: implemented (#13344). The planned phase 2, `query()` as a workflow-script
operation, was never built: codemode made it unnecessary, because a script calls
`tools.executions({ action: 'query', … })` and replays its `tool.result` like any
other nested call.

## Thesis

The harness supplies ground truth; it does not guess at the model's
questions. The `executions` tool's virtual paths are questions we decided
the model would ask, each with a hand-written reader and formatter. A
question outside that set ("which of my subagents failed in a tool call, and
what did they call?") would take several `view` calls and the model's own
joins.

The run history sits in one SQLite table, and the general way to question
that data is code. So the model writes the question as SQL. **Views are the
contract; SQL is the interface.** A general primitive improves as the model
improves. A fixed set of views does not.

## 1. The query store holds only public rows

The model's SQL never runs against the session database. It runs against a
separate in-memory SQLite database, the **query store**, which holds only
the session's display rows. The isolation comes from what the store holds,
not from filtering statements.

This is the only sound option. `node:sqlite` has no authorizer, so a
connection to the session file cannot stop `SELECT * FROM event` from
reading run history rows and the envelope columns. A `TEMP VIEW` over that
connection sits next to the base tables and does not hide them, and checking
the statement's text cannot tell a base-table name from a view name. In the
query store, those tables do not exist.

- **Where it lives.** A child process owns the store
  (`packages/harness/src/agent/runtime/historyQuery/childSource.ts`), started
  on the first query with the host's own binary (`ELECTRON_RUN_AS_NODE=1`
  for the Electron hosts) through Effect's `ChildProcessSpawner`, and closed
  with the session's scope. It is a process, not a worker thread, because
  `node:sqlite` is synchronous with no interrupt or progress handler, and
  `Worker.terminate()` takes effect only when control returns to
  JavaScript: a `WITH RECURSIVE … SELECT count(*)` runs inside one native
  `step()` and would keep a core busy after its caller gave up. A process
  takes `SIGKILL`.
- **How it is fed.** One table, `events(position, run_id, type, at, data)`
  (`historyQuery/views.ts`), with no envelope columns and `at` as ISO-8601
  text. Before each query the store reads the display tail from its cursor
  through `SessionEvents.all`, up to the commit the query was asked at, so
  the query sees a consistent prefix. Rows arrive decoded by the one read
  authority, so the process never opens the session file, and persistent
  and in-memory sessions are served the same way. A `run.removed` row
  deletes that run's rows. Long text values and oversized rows are cut on
  the way in (`HISTORY_TEXT_LIMIT`, `HISTORY_ROW_LIMIT`).
- **Nothing is persisted.** The store is a cache of public rows in memory.
  SQLite's own memory there is capped with `PRAGMA hard_heap_limit` (1 GiB).
- **What the store refuses.** The model's statement runs with
  `PRAGMA query_only = ON`; the feed turns it off only while appending.
  - The session side admits exactly one statement starting with `SELECT`,
    `WITH`, `EXPLAIN` or `VALUES`, read with comments and quoted text
    blanked. The prefix keeps out `PRAGMA`, the only way to turn
    `query_only` off.
  - `prepare()` compiles only the first statement and ignores the rest, so
    a second statement is refused rather than silently dropped.
  - `query_only` catches `WITH … INSERT/DELETE`, which passes the prefix
    check.
  - Extension loading stays disabled, the `node:sqlite` default.
- **Errors.** `HistoryQueryRefused { reason: 'not-a-read' | 'rejected' |
'timeout', message }` is the model's to correct; `HistoryQueryFailed` is
  the store's own failure, logged at `warn` as the store is dropped.
- **Deadline and interruption.** A query gets 5 seconds. Past that, or when
  its caller is interrupted, the process is killed and the next query
  rebuilds the store; a late reply can never be paired with the next
  request.

The surface is `HistoryQuery`
(`packages/harness/src/agent/runtime/historyQuery/HistoryQuery.ts`), built in
the session layer's scope and carried as `SessionHandle.history`. A page is
`{ columns, rows, more }`, cut at 200 rows. Queries on one session run one at
a time.

Two architecture ratchets name the process source as their one exception:
`persistenceWriteBoundary.vitest.ts` (it may import `node:sqlite`, and it
opens no session file and assigns no ordinals, so it is not a second owner
of them) and `storedShapeBoundary.vitest.ts`.

## 2. The views are the contract

The views flatten the JSON and apply the fold's lifecycle rules, so a query
never has to know them. The tool description renders from one source,
`HISTORY_VIEW_SUMMARY` in `views.ts`, so the model's first query needs no
discovery call. Today: `runs`, `run_tree`, `messages`, `tool_calls`, `usage`,
and the raw `events`.

Lifecycle rules in `runs`:

- `parent_id` is NULL for a top-level or detached run, matching the fold, so
  `run_tree` stays correct for a child that outlived its parent's stop.
- `lifecycle` is `'created'`, `'activated'` (launched or resumed) or
  `'ended'`. `ended_at`, `outcome`, `error` and the totals are set only when
  ended, so a resumed run is never reported with its previous outcome.
- `lifecycle` records history, not liveness. An `'activated'` run may have
  died with its process; whether it is running now is the `Runs`
  registry's, asked through `/executions/{id}` or `wait`.

Other rules:

- **No private records.** `run.report` and `run.result` are left out. Their
  paths warn when the latest record belongs to an earlier turn of a
  multi-turn child (`executions/turnAttribution.ts`), which a view could not
  do, so those paths stay.
- **No run history rows**, by construction: the display tail never carries
  them.
- **The project database only.** The global database is out of scope.
- **The views move with the vocabulary.** A change to a row a view reads
  updates the view in the same PR; `HistoryQuery.vitest.ts` fails when a
  view no longer compiles.

## 3. The tool arm

`query` is an arm of the `executions` action union
(`packages/harness/src/tools/executions/toolInput.ts`): `path` (must be
`/executions`), `sql`, and `params` as text.

- **`params` are text**, so the provider-facing schema has no `anyOf` in
  array items; a number is written as a literal in the SQL.
- **`path` stays required**, because `flattenTopLevelUnion` keeps a field
  required only if every arm requires it; an optional `path` here would
  loosen it on every arm.
- **Output** (`executions/queryAction.ts`): always a page, with each cell cut
  at 2,000 characters. When `more` is true the page ends with a line saying
  how to page. A large result is never an error and never silently cut.
- **Errors.** `HistoryQueryRefused` becomes a `ToolError` in SQLite's own
  words, or naming the rule or the deadline.

`/children` and `/todos` were deleted in the same change: each is one line
of SQL over the views. `wait`, `kill`, `send`, `/output`, `/executions/{id}`,
`/report`, `/result`, `/files`, `/workspace-files` and `/conversation` stay:
they are actions, live state, turn-attributed records, the filesystem, or
the model's formatted first call.

## Testing

- **E2E.** `packages/cli/scripts/validate-run.mjs`
  (`validateHistoryQueryRunCommand`) runs the bundled `texra` binary
  headless; the internal validation model, under
  `TEXRA_INTERNAL_VALIDATE_HISTORY_QUERY=1`, calls `executions` with a
  `query` and answers with the result. The NDJSON lands in
  `packages/cli/.texra-validate-run/artifacts/history-query-run.ndjson`.
- **The view contract.** `src/test-kernel/agent/runtime/HistoryQuery.vitest.ts`
  runs over a real in-memory session. Its failure modes: a vocabulary change
  leaves a view that no longer compiles; a resumed run shows its previous
  outcome; a detached child still appears under its former parent; a
  runaway statement holds the store past its deadline, or the store stays
  dead after it; a run history row, private record or session table is
  reachable; a statement writes or runs a second statement.

## Not measured

The budgets are first guesses: 200 rows per page, 5 s per query, 2,000
characters per cell, a 1 GiB SQLite heap. The store also copies every display
row of the project database into the process; nobody has measured that on a
large real database. If it proves too large, the options are an idle-evicted
process, per-view lazy loading, or a scoped feed.
