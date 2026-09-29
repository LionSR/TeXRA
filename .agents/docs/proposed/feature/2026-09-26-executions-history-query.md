# History as a queryable substrate: an executions `query` action

Date: 2026-09-26

Status: accepted 2026-09-27; phase 1 is in [#13344](https://github.com/LionSR/TeXRA/pull/13344), phase 2 is open

Baseline: `origin/main` at `b865508` (`SESSION_EVENT_FORMAT = 19`).

## Thesis

The harness supplies ground truth; it does not guess at the model's
questions ([research roadmap](../../archived/feature/2026-07-05-open-problem-research-roadmap.md):
"The harness provisions; it does not supervise"). The `executions` tool does
the opposite today. Its thirteen virtual paths are thirteen questions we
decided the model would ask, each with a hand-written reader and formatter.
A question outside that set ("which of my subagents failed in a tool call, and
what did they call?") takes several `view` calls and the model's own joins.

The run history now sits in one SQLite table
([persistence substrate](../../archived/architecture/2026-09-03-persistence-substrate-decision.md)).
The general way to question that data is code. So the model writes the
question as SQL, and later as a workflow script. **Views are the contract;
SQL is the interface.** A general primitive improves as the model improves.
A fixed set of views does not.

## Finding: what the tool reads today

`executions` is one `defineTool` (`src/tools/ExecutionsTool.ts`, 915 lines).
Its handlers are `Effect.fn('ExecutionsTool.*')`, and its schema is a
four-arm discriminated union (`view` / `wait` / `kill` / `send`,
`src/tools/executions/toolInput.ts`). Every arm requires `path`. The paths
draw on five different sources:

| Source                                                                                                | Paths                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Listing fold, `session.readView([])`                                                                  | `/executions` (`executions/runListing.ts`), `/children`, `/todos`, the `/config` category filter |
| One aggregate folded, `readView([runId])`                                                             | `/executions/{id}` (workflow board)                                                              |
| Private run records, `getRunRecords` (`run.report`, `run.result`, `run.record`, `run.workspaceFiles`) | `/report`, `/result`, `/config`, `/workspace-files`                                              |
| Transcript fold, `readCompletedRunConversation` → `readRunTranscript`                                 | `/conversation`                                                                                  |
| Live, in-memory `session.runView`                                                                     | `/output`, plus the liveness notes on `/report` and `/result`                                    |
| Filesystem (`StorageFs`, `FileSystem`)                                                                | `/files`, `/files/{path}`, `/workspace-files/{path}`                                             |

The first four are the `event` table read four different ways. The
[tools-surface collapse](../../archived/simplification/2026-09-20-tools-and-schema-surface-collapse.md)
already moved the tool onto `SessionView`. What remains is that each
question is still a path with its own code.

These storage facts constrain the design:

- `event.type` is stored as `name.1`, and row content is JSON in `data`.
  Changing the vocabulary bumps `SESSION_EVENT_FORMAT`, which clears a
  mismatched store when it opens.
- A subagent's link to its parent is `run.start.parent.id` inside `data`, not
  `event_sequence.parent_id`. That column is the ownership and deletion edge
  for workflow checkpoints and inquiries. A later `run.detach` severs the link:
  the fold makes the child top level (`sessionFold.ts`, `case 'run.detach'`).
- Every `run.activate` opens a new running window. A resumed run's earlier
  `run.end` belongs to the previous lifecycle (`sessionFold.ts`,
  `case 'run.activate'`; `runEndFromEvents` in `runRecords.ts`).
- Run-ledger rows (`model.message`, `model.compaction`, `tool.intent`,
  `tool.binding`, `tool.result`, `model.retry`, `run.snapshot`,
  `child.turn`) share the table and the `["run", id]` aggregate with the
  display rows. C3 makes them byte-exact and readable only through
  `RunLedger`.
- `Database.readDisplay(fromCommit)` already returns exactly the public rows:
  `DISPLAY_EVENT_TYPES`, which excludes the private run records, the ledger
  rows and the stored-value rows, filtered in SQL.
- Liveness is not in the table. "Is it running" is the in-memory `Runs`
  registry plus `proveOwnerLiveness` over the claim.
- SDK consumers open every session in ephemeral (`:memory:`) mode
  (`packages/agent/src/effect/sessionPrograms.ts`), so a design that needs a
  database file excludes them.

## Proposal

### 1. The query engine holds only public rows

The model's SQL never runs against the session database. It runs against a
separate in-memory SQLite database, the **query store**. The store contains
only rows `readDisplay` returned, so the isolation comes from what the store
holds, not from filtering statements.

This is the only sound option. `node:sqlite` has no authorizer, so a
connection to the session file cannot stop `SELECT * FROM event` from reading
ledger rows and the hidden envelope columns. A `TEMP VIEW` over that
connection sits next to the base tables and does not hide them. Checking the
statement's text cannot tell a base-table name from a view name. In the query
store, those tables do not exist.

- **Where it lives.** A child process owns the query store: `node -e` on the
  host's own binary (`ELECTRON_RUN_AS_NODE=1` for the Electron hosts),
  spawned through Effect's `ChildProcessSpawner` in a scope forked from the
  session's. `node:sqlite` is synchronous and has no interrupt or progress
  handler (on Node 22.22 the `DatabaseSync` prototype has `open close prepare
exec function aggregate createSession applyChangeset enableLoadExtension
loadExtension`). The first draft put the store in a worker thread, but
  `Worker.terminate()` only takes effect when control returns to
  JavaScript: a `WITH RECURSIVE … SELECT count(*)` runs entirely inside one
  native `step()` and would keep a core busy after its caller gave up. A
  process takes `SIGKILL`. The process exits when its stdin closes, so it
  never outlives its host.
- **How it is fed.** One table, `events(position, run_id, type, at, data)`
  (`src/agent/runtime/historyQuery/views.ts`). It has no `seq`, `commit` or
  `owner_id`, the type has no `.1` suffix, and `at` is ISO-8601 text. Before
  each query, the store reads the session's display tail from its cursor,
  `SessionEvents.all(cursor, drained)`, until `drained` reaches the commit
  the query was asked at (`session.now()`), and sends those rows to the
  process. The query then sees a consistent prefix through that commit.
  - `SessionEvents.all` is the display tail over `Database.readDisplay`, the
    existing C7 read family. Rows arrive decoded by the one read authority,
    so the process never opens the session file. Persistent and ephemeral
    sessions are served the same way.
  - A `run.removed` row deletes that run's rows, and those of its dependents
    (`runIds` is on the row).
  - A current commit below the store's cursor means the database was cleared.
    The store is dropped and rebuilt from commit 0, as it is after a killed
    process.
- **Nothing is persisted.** The query store is a cache of public rows in
  memory, so §5 and C10 (no projection tables; nothing derived is stored
  except `run.snapshot`) still hold. SQLite's own memory in the store is
  capped with `PRAGMA hard_heap_limit` (1 GiB).
- **What the store refuses.** The model's statement runs with
  `PRAGMA query_only = ON`; the feed turns it off only while appending.
  - The session side admits exactly one statement starting with `SELECT`,
    `WITH`, `EXPLAIN` or `VALUES`, read with comments and quoted text blanked.
    The prefix gives a clear message and keeps out `PRAGMA`, the only way to
    turn `query_only` off.
  - `prepare()` compiles only the first statement and ignores the rest
    (checked on Node 22.22), so a second statement is refused rather than
    silently dropped.
  - `query_only` catches `WITH … INSERT/DELETE`, which passes the prefix check
    (tested: SQLite answers `attempt to write a readonly database`).
  - Extension loading stays disabled, which is the `node:sqlite` default.
  - Even a write that got through would only reach the query store, which
    holds public rows the next rebuild restores.
- **The errors.** `HistoryQueryRefused { reason: 'not-a-read' | 'rejected' |
'timeout', message }` is the model's to correct; `HistoryQueryFailed` is the
  store's own failure (would not start, exited, unreadable reply), logged at
  `warn` as the store is dropped. Both are `Data.TaggedError`s.
- **Deadline and interruption.** A query gets 5 seconds. Past that, or when
  its caller is interrupted, the process is killed and the next query
  rebuilds the store; a late reply can never be paired with the next request.

The surface is one class, `HistoryQuery` (`src/agent/runtime/historyQuery/`),
built in the session layer's scope beside `ModelRetryGate` and carried as
`SessionHandle.history`:

```ts
query: (sql: string, params: readonly HistoryCell[]) =>
  Effect.Effect<
    HistoryPage,
    HistoryQueryRefused | HistoryQueryFailed | DatabaseReadFailed
  >;
```

`HistoryPage` is `{ columns, rows, more }`. The process steps the statement
with `iterate()` and stops at 200 rows plus one, so `more` is known without
running the whole result. Queries on one session run one at a time.

**Ratchet amendment.** `persistenceWriteBoundary.vitest.ts` excluded a single
module, `DATABASE_MODULE`, from both of its scans. The process source
(`src/agent/runtime/historyQuery/childSource.ts`) requires `node:sqlite`, so
the two scans now take separate allowlists:

- The import allowlist is `Database.ts` plus the process source.
- The write-SQL scan still excludes only `Database.ts`.

The ratchet exists so there is never a second owner of the ordinals. The
process opens no session file, assigns no `seq` or `commit`, and claims
nothing, so it is not a second owner. The ratchet also asserts the process
source still matches the import pattern, so the entry cannot go stale.

### 2. The views are the contract

The views live in the query store over `display_event`. They flatten the JSON
and apply the fold's lifecycle rules, so a query never has to know them.

| View         | Columns (sketch)                                                                                                                       | Rows                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `runs`       | `id, parent_id, agent, model, category, is_remote, started_at, lifecycle, ended_at, outcome, error, cost, input_tokens, output_tokens` | `run.start`, `run.config`, `run.activate`, `run.end`, `run.detach`                                       |
| `run_tree`   | `ancestor_id, id, depth`                                                                                                               | recursive over `runs.parent_id`                                                                          |
| `messages`   | `run_id, at, role, text`                                                                                                               | the rows `foldRunTranscript` reads: `log` by `messageType`, `stream.end.finalText`, `response.finalized` |
| `tool_calls` | `run_id, call_id, tool, input, status, result, started_at, ended_at`                                                                   | `tool.start` joined to `tool.end` on `logId`                                                             |
| `usage`      | `run_id, at, model, input_tokens, output_tokens, cost`                                                                                 | `usage`                                                                                                  |
| `todos`      | `run_id, content, status`                                                                                                              | the latest `run.fact` with `key = 'todos'`                                                               |

Lifecycle rules in `runs`:

- `parent_id` is `run.start.parent.id`, or `NULL` once the run has a
  `run.detach` row, matching the fold. `run_tree` recurses over this effective
  parent, so the SQL replacement for `/children` stays correct for a child
  that outlived its parent's stop.
- `lifecycle` is `'ended'` only when the run's latest lifecycle row is
  `run.end`, and `'activated'` when a later `run.activate` reopened it.
  `ended_at`, `outcome` and `error` are `NULL` unless `lifecycle = 'ended'`.
  A resumed run is never reported with its previous outcome.
- `lifecycle` records history, not liveness. An `'activated'` run may have
  died with its process. Whether it is running now is the `Runs` registry's,
  and the model asks `/executions/{id}` or `wait`.

Other rules:

- **No private records.** `run.report` and `run.result` are left out.
  `/report` and `/result` currently warn when the latest record belongs to an
  earlier turn of a multi-turn child. That warning needs `child.turn`, a ledger
  row (`executions/turnAttribution.ts`). A view could not attribute a report
  to its turn, so it would silently present an old turn's result as current.
  Those paths stay.
- **No ledger rows**, by construction: `readDisplay` never returns them.
- **No redaction step.** Trace rows are scrubbed before they are written, and
  display rows are the scrubbed set.
- **The project database only.** The global database (app state, inquiries,
  desktop projects) is out of scope.
- **One source for the view schema.** The view definitions and a column
  summary live in one module. The tool description renders from it, the way
  `pathCatalog.ts` renders `EXECUTION_PATH_LIST`, so the model's first query
  needs no discovery call.
- **The views move with the vocabulary.** Any PR that bumps
  `SESSION_EVENT_FORMAT` and changes a row a view reads updates the view in
  the same PR (see Testing).

### 3. The tool: a fifth arm

The arm on `ExecutionsToolActionSchema` (`src/tools/executions/toolInput.ts`):

```ts
const QueryActionSchema = z.strictObject({
  path: PathFieldSchema, // required, as on every arm; must be /executions
  action: z.literal('query'),
  sql: z.string().min(1),
  params: nullishWithDefault(z.array(z.string()), []),
});
```

- **`params` are text.** An array of one type keeps the provider-facing
  schema free of an `anyOf` in array items; a number is written as a literal
  in the SQL.
- **`path` stays required.** `flattenTopLevelUnion` keeps a field in
  `required` only if every arm requires it (`src/agent/runtime/run/toolSchema.ts`).
  A nullish `path` on this arm would drop `path` from the advertised schema
  for `view`, `wait`, `kill` and `send` too. Like `wait` on the listing,
  `query` is valid only on `/executions`, and any other path is a
  `ToolError`.
- **The handler** is `Effect.fn('ExecutionsTool.query')`. It reaches the query
  store through the session it already resolves and returns
  `executed(table, summary)`.
- **Errors.** `HistoryQueryRefused` becomes a `ToolError`: SQLite's own
  message for `rejected`, the rule for `not-a-read`, the deadline for
  `timeout`, so the model can correct the query.
- **Output: one behavior past the row cap.** The result is always a page: the
  first 200 rows (the existing `limit` maximum), with per-cell truncation.
  When `more` is true, it ends with a line saying more rows exist and how to
  page. A large result is never an error and never silently cut.
- **Rendering.** It stays one tool, so the existing `executionsDisplay.ts` and
  `toolRowSections.ts` tool cards apply; a `query` call shows its SQL in the
  preview and an `SQL:` section.

### 4. What it deletes

Per review checklist §13, a new port pays for itself in the same PR:

- `/children` and `/todos` are pure listing-fold reads. Each becomes one line
  of SQL over `run_tree` or `todos`, so the paths, their handlers
  (`showChildren`, `showTodos`) and their catalog entries go. Because the
  query store serves ephemeral sessions too, no caller loses these reads.
- `/executions` listing formatting stays. It is the model's cheapest first
  call, and `send` builds on it.
- The PR reports net elements (R6) and consumer counts (R8).

A later candidate, once the query has proven itself, is `/config`: its
category-filter logic moves into the `runs` view. `/report` and `/result`
stay (see §2).

### 5. What stays

`wait`, `kill`, `send`, `/output`, `/executions/{id}`, `/report`, `/result`,
`/files`, `/workspace-files` and `/conversation` stay. They are actions, live
state, turn-attributed records, the filesystem, or the model's formatted
first call. `/conversation` remains until the view-state collapse settles
where message text lives (see Open questions).

### 6. Phase 2: `query()` in workflow scripts

Workflow scripts already run model-written code
(`src/agent/workflowScript/`). The script yields `WorkflowOperation`s
(`Agent`, `All`, `Attempt`, `Retry`, `Timeout`), and `interpreter.ts` runs
each one as an Effect. `query()` becomes one more operation:

```ts
| { readonly _tag: 'Query'; readonly sql: string; readonly params: readonly SqlParam[] }
```

The interpreter runs it through the same query store, and **its result is
journaled**. History keeps changing while a run is live, and replay is
deterministic only if a resumed script sees the same rows the first attempt
saw.

The journal entry must say what it holds. `WorkflowJournalEntry` today is
`{ index, key, result }`, and settlement treats every entry as an agent's
result: `workflowJournalEntryCost` parses `entry.result` as `RunEndSchema` and
throws on anything else (`src/tools/delegation/workflowScriptRun.ts`). Phase
2 therefore:

- adds a discriminant, `kind: 'agent' | 'query'`, to the journal entry;
- skips `query` entries in the cost total, since a query spends nothing;
- bumps `SESSION_EVENT_FORMAT`, because `workflow.journal` rows change shape.

An orchestrator script then treats history as data:

```
const failed = yield* query(
  "select id, error from runs where parent_id = ? and lifecycle = 'ended' and outcome = 'failed'",
  [args.runId],
);
yield* all(failed.map((r) => agent(`Diagnose run ${r.id}: ${r.error}`)));
```

This is where "code as the tool" leads: the model's reads and its control flow
are written in the same program.

## Testing

This follows AGENTS.md "Testing discipline": a new feature gets E2E coverage
of its user-visible path, ending in an artifact, and isolated tests only at a
durable boundary, from a failure-mode list written first.

- **E2E.** `packages/cli/scripts/validate-run.mjs`
  (`validateHistoryQueryRunCommand`) runs the real bundled `texra` binary
  headless with a custom tool-use agent that has only `executions`. The
  internal validation model (`validationModel.ts`, under
  `TEXRA_INTERNAL_VALIDATE_HISTORY_QUERY=1`) calls `executions` with a
  `query`, then answers with the tool result verbatim. The check asserts the
  page for the run's own row. The NDJSON the run printed is saved to
  `packages/cli/.texra-validate-run/artifacts/history-query-run.ndjson`. This
  covers the provider-facing schema (union flattening included), the real
  session, and the store's process spawned from the bundled binary.
- **Isolated, at the durable boundary: the view contract.**
  `src/test-kernel/agent/runtime/HistoryQuery.vitest.ts` (kernel tier) runs
  over a real ephemeral session. Its failure modes were written before the
  store:
  1. a vocabulary change leaves a view that no longer compiles;
  2. a resumed run shows its previous lifecycle's outcome;
  3. a detached child still appears under its former parent;
  4. a runaway statement holds the store instead of stopping at its deadline,
     or the store stays dead after it;
  5. a ledger row, a private record, or the session database's own tables are
     reachable from a query;
  6. a statement writes to the store or runs a second statement.
- The two `/todos` cases in `ExecutionsToolWorkspaceFiles.vitest.ts` now read
  the task list through the query.
- `persistenceWriteBoundary.vitest.ts`: the split allowlists from §1.

## Landed

Phase 1 (§1 to §5), in [#13344](https://github.com/LionSR/TeXRA/pull/13344):
the query store, the views, the `query` action, the SQL on the executions
card, and the removal of `/children` and `/todos` (the orchestrator, Lean
orchestrator and progress-check prompts now use the query).

## Open

1. **Phase 2** (§6): `query()` as a workflow-script operation, with the
   journal discriminant and the format bump.
2. **Query store memory.** The store copies every display row of the project
   database into the process. Measure a large real database. If the copy is
   too large, options are an idle-evicted process, per-view lazy loading, or
   scoping the feed.
3. **`messages` after the view-state collapse.** C3's named residue says the
   collapse deletes the trace copy of message text, after which the display
   fold reads `model.message` with redaction applied. At that point the
   display rows no longer carry message text. `messages` must then be fed
   from a projection that `RunLedger` owns, and `/conversation` can retire.
4. **Budgets.** 200 rows per page, 5 s per query, 2,000 characters per cell
   and a 1 GiB SQLite heap are first guesses, not measurements.
5. **`/config`** could move onto the `runs` view once the query has proven
   itself.
