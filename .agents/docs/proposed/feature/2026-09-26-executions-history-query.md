# History as a queryable substrate: an executions `query` action

Date: 2026-09-26

Status: proposed

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
  `tool.binding`, `tool.result`, `model.retry`, `flow.snapshot`,
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

- **Where it lives.** A worker thread owns the query store. `node:sqlite` is
  synchronous and has no interrupt or progress handler (on Node 22.22 the
  `DatabaseSync` prototype has `open close prepare exec function aggregate
createSession applyChangeset enableLoadExtension loadExtension`). An
  Effect timeout cannot preempt a statement already on the main thread, so one
  runaway recursive CTE would freeze the extension host. In a worker, the
  timeout, or interrupting the calling fiber, terminates the worker.
  Acquiring and releasing the worker is scoped to the session.
- **How it is fed.** One table, `display_event(run_id, type, at, data)`. It has
  no `seq`, `commit` or `owner_id`, and the type has no `.1` suffix. Before
  each query, the session side reads the tail since its cursor with
  `Database.readDisplay(cursor)` and posts it to the worker, which appends it.
  The query then sees a consistent prefix through that commit.
  - `readDisplay` is the existing C7 read family. Rows arrive decoded by the
    one read authority, so the worker never opens the session file. It works
    the same for persistent and ephemeral sessions.
  - A `run.removed` row deletes that run's rows, and those of its dependents,
    from the store (`runIds` is on the row).
  - A store cleared by a format reset (`Database.cleared`) drops the query
    store, which is rebuilt from commit 0 on the next query.
  - A terminated worker is rebuilt the same way.
- **Nothing is persisted.** The query store is a cache of public rows in
  memory, so §5 and C10 (no projection tables; nothing derived is stored
  except `flow.snapshot`) still hold.
- **What the worker refuses.** The model's statement runs with
  `PRAGMA query_only = ON`; the feed turns it off only while appending.
  - A statement must be exactly one statement starting with `SELECT`, `WITH`
    or `EXPLAIN`. The prefix gives a clear message, and it also blocks
    `PRAGMA`, the only way to turn `query_only` off.
  - `prepare()` compiles only the first statement and ignores the rest
    (checked on Node 22.22), so a trailing statement never runs. The worker
    refuses input that has one rather than dropping it silently.
  - `query_only` catches `WITH … INSERT/DELETE`, which passes the prefix check
    (checked: it fails with `attempt to write a readonly database`).
  - Extension loading stays disabled, which is the `node:sqlite` default.
  - Even a write that got through would only reach the query store, which
    holds public rows the next rebuild restores. The session database is
    never reachable from the worker.
- **The error.** `DatabaseQueryRefused { reason: 'syntax' | 'not-a-read' |
'timeout', message }` is a `Data.TaggedError`. The error channel is never
  `unknown`.

The service surface is one method on the session handle's database, served
from the session layer:

```ts
query: (sql: string, params: ReadonlyArray<SqlParam>) =>
  Effect.Effect<QueryPage, DatabaseQueryRefused | DatabaseReadFailed>;
```

`QueryPage` is `{ columns, rows, more: boolean }`. The worker steps the
statement with `iterate()` and stops at the row cap plus one, so `more` is
known without running the whole result.

**Ratchet amendment.** `persistenceWriteBoundary.vitest.ts` excludes a single
module, `DATABASE_MODULE`, from both of its scans: the SQLite-import scan and
the event-table write scan. The worker entry (for example
`src/controllers/session/queryStoreWorker.ts`) must import `node:sqlite`, so
the two scans need separate allowlists:

- The import allowlist becomes `Database.ts` plus the worker.
- The write-SQL scan still excludes only `Database.ts`.

The ratchet exists so there is never a second owner of the ordinals. The
worker opens no session file, assigns no `seq` or `commit`, and claims
nothing, so it is not a second owner.

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

Add the arm to `ExecutionsToolActionSchema`:

```ts
const QueryActionSchema = z.strictObject({
  path: PathFieldSchema, // required, as on every arm; must be /executions
  action: z
    .literal('query')
    .describe(
      'Run one read-only SQL statement over the views (use on /executions).',
    ),
  sql: z
    .string()
    .min(1)
    .describe('One SELECT/WITH statement over the views below.'),
  params: z.array(z.union([z.string(), z.number(), z.null()])).nullish(),
});
```

- **`path` stays required.** `flattenTopLevelUnion` keeps a field in
  `required` only if every arm requires it (`src/agent/runtime/run/toolSchema.ts`).
  A nullish `path` on this arm would drop `path` from the advertised schema
  for `view`, `wait`, `kill` and `send` too. Like `wait` on the listing,
  `query` is valid only on `/executions`, and any other path is a
  `ToolError`.
- **The handler** is `Effect.fn('ExecutionsTool.query')`. It reaches the query
  store through the session it already resolves and returns
  `executed(table, summary)`.
- **Errors.** `DatabaseQueryRefused` becomes a `ToolError` carrying SQLite's
  message (`syntax`, `not-a-read`) or the limit that was hit (`timeout`), so
  the model can correct the query.
- **Output: one behavior past the row cap.** The result is always a page: the
  first 200 rows (the existing `limit` maximum), with per-cell truncation.
  When `more` is true, it ends with `More rows exist; add LIMIT/OFFSET to
page.`. A large result is never an error and never silently cut.
- **Rendering.** It stays one tool, so the existing `executionsDisplay.ts` and
  `toolRowSections.ts` tool cards apply; they gain only a `query` preview
  (showing the SQL).

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

- **E2E.** Drive the real `texra` binary headless through one run whose agent
  calls `executions` with `action: 'query'`. The artifact is the run's saved
  transcript (NDJSON) at a known path, containing the query card and its
  result table. This exercises the real tool-schema conversion (including
  union flattening), worker packaging in the bundled binary, and the host
  boundary, none of which an isolated suite reaches. It needs a deterministic
  model route for the CLI; see Open questions.
- **Isolated, at the durable boundary: the view contract.** The failure modes
  are written before the code:
  1. a vocabulary change leaves a view that no longer compiles;
  2. a resumed run shows its previous outcome;
  3. a detached child still appears under its former parent;
  4. a runaway statement blocks the caller instead of timing out;
  5. a ledger or private row reaches the query store.

  Each gets one case, in one kernel-tier suite next to the session database
  tests (`src/test-kernel/controllers/session/`). It feeds `readDisplay` rows
  from a real ephemeral `Database`. The suite imports the query store and
  `node:sqlite`, so it belongs in the kernel tier. It is not added to
  `sessionEventFormat.vitest.ts`, which is a pure-tier suite whose imports
  must stay SQLite-free.

- `persistenceWriteBoundary.vitest.ts`: the split allowlists from §1, with the
  argument in the comment.

## Open questions

1. **Deterministic model route for the CLI E2E.** No scripted or recorded
   model route exists for the `texra` binary today. Landing one is a
   prerequisite every tool-level E2E shares. The alternative, a real provider
   behind a key, is not repeatable.
2. **Worker mechanism.** Use Effect 4's worker module or `node:worker_threads`
   under `Effect.acquireRelease`. Check against the pinned `4.0.0-rc.117`
   before implementing.
3. **Query store memory.** The store copies every display row of the project
   database into worker memory. Measure a large real database. If the copy is
   too large, options are an idle-evicted worker, per-view lazy loading, or
   scoping the feed to the current session (question 5).
4. **`messages` after the view-state collapse.** C3's named residue says the
   collapse deletes the trace copy of message text, after which the display
   fold reads `model.message` with redaction applied. At that point
   `readDisplay` no longer carries message text. `messages` must then be fed
   from a projection that `RunLedger` owns, and `/conversation` can retire.
5. **Scope across sessions.** One project database holds every session in
   the workspace. `runs` should probably default to what `/executions` lists
   today. Should cross-session history be reachable deliberately, through a
   `session_id` column, or not at all?
6. **Time and size budgets.** Proposed: 200 rows per page, 2 s wall clock,
   2,000 chars per cell. These need measuring before they are fixed.
