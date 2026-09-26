# History as a queryable substrate: an executions `query` action

Date: 2026-09-26

Status: proposed

Baseline: `origin/main` at `7071105` (`SESSION_EVENT_FORMAT = 17`).

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

`executions` is one `defineTool` (`src/tools/ExecutionsTool.ts`, 943 lines).
Its handlers are `Effect.fn('ExecutionsTool.*')`, and its schema is a
three-arm discriminated union (`view` / `wait` / `kill`,
`src/tools/executions/toolInput.ts`). The paths draw on five different
sources:

| Source | Paths |
| --- | --- |
| Listing fold, `session.readView([])` | `/executions`, `/children`, `/todos`, the `/config` category filter |
| One aggregate folded, `readView([runId])` | `/executions/{id}` (workflow board) |
| Private run records, `getRunRecords` (`run.report`, `run.result`, `run.record`, `run.workspaceFiles`) | `/report`, `/result`, `/config`, `/workspace-files` |
| Transcript fold, `readCompletedRunConversation` → `readRunTranscript` | `/conversation` |
| Live, in-memory `session.runView` | `/output`, plus the liveness notes on `/report` and `/result` |
| Filesystem (`StorageFs`, `FileSystem`) | `/files`, `/files/{path}`, `/workspace-files/{path}` |

The first four are the `event` table read four different ways. The
[tools-surface collapse](../../archived/simplification/2026-09-20-tools-and-schema-surface-collapse.md)
already moved the tool onto `SessionView`. What remains is that each
question is still a path with its own code.

Four storage facts constrain the design:

- `event.type` is stored as `name.1`, and row content is JSON in `data`.
  Changing the vocabulary bumps `SESSION_EVENT_FORMAT`, which clears a
  mismatched store when it opens.
- A subagent's link to its parent is `run.start.parent.id` inside `data`, not
  `event_sequence.parent_id`. That column is the ownership and deletion edge
  for workflow checkpoints and inquiries.
- Run-ledger rows (`model.message`, `model.compaction`, `tool.intent`,
  `tool.binding`, `tool.result`, `model.retry`, `flow.snapshot`,
  `child.turn`) share the table and the `["run", id]` aggregate with the
  display rows. C3 makes them byte-exact and readable only through
  `RunLedger`.
- Liveness is not in the table. "Is it running" is the in-memory `Runs`
  registry plus `proveOwnerLiveness` over the claim.

## Proposal

### 1. `Database.query`, a C7 read family

Add one method to the `Database` service (`src/shared/session/database.ts`),
implemented in `src/controllers/session/Database.ts`:

```ts
query: (sql: string, params: ReadonlyArray<SqlParam>) =>
  Effect.Effect<QueryRows, DatabaseQueryRefused | DatabaseReadFailed>
```

- It runs on its own `readOnly: true` connection to the same file. Writes
  fail with `attempt to write a readonly database` (checked on Node 22.22).
  WAL gives it a consistent snapshot next to the writer.
- It runs in a worker thread. `node:sqlite` is synchronous and exposes no
  interrupt, progress handler or authorizer (on 22.22 the `DatabaseSync`
  prototype has `open close prepare exec function aggregate createSession
  applyChangeset enableLoadExtension loadExtension`). An Effect timeout
  cannot preempt a statement already on the main thread, so one runaway
  recursive CTE would freeze the extension host. Running in a worker makes
  interruption real: the timeout, or interrupting the calling fiber,
  terminates the worker. Acquiring and releasing the worker is scoped.
- The views are `CREATE TEMP VIEW`s on that connection. Nothing is persisted,
  consistent with §5 and C10 (no projection tables; nothing derived is
  stored except `flow.snapshot`).
- A statement must start with `SELECT`, `WITH` or `EXPLAIN`. This is only for
  a clear error message; the read-only connection is what enforces it.
  Extension loading stays disabled, which is the `node:sqlite` default.
- `DatabaseQueryRefused { reason: 'syntax' | 'not-a-read' | 'timeout' |
  'row-limit', message }` is a `Data.TaggedError`. The error channel is never
  `unknown`.
- Ephemeral sessions (`:memory:`) have no file for a second connection to
  open. There, `query` fails loudly with `DatabaseQueryRefused`. It does not
  fall back to the writer connection.

**Ratchet amendment.** `persistenceWriteBoundary.vitest.ts` allows only
`Database.ts` to import SQLite, "because a second entry would mean a second
owner of the ordinals". The worker entry file (for example
`src/controllers/session/databaseQueryWorker.ts`) has to import `node:sqlite`.
This proposal asks for exactly one more allowlist entry, and argues that the
ratchet's reason does not cover it: a read-only connection assigns no `seq`
or `commit`, claims nothing, and SQLite itself refuses any write it attempts.
The write-SQL half of the ratchet is unchanged and still applies to this
file.

### 2. The views are the contract

The views cover display rows and the private run records only. They strip the
`.1` suffix, hide `seq`, `commit` and `owner_id`, and flatten the JSON.

| View | Columns (sketch) | Rows |
| --- | --- | --- |
| `runs` | `id, parent_id, agent, model, category, is_remote, started_at, ended_at, outcome, error, cost, input_tokens, output_tokens, closed` | `run.start`, `run.config`, `run.end`, `event_sequence.closed` |
| `run_tree` | `ancestor_id, id, depth` | recursive over `run.start.parent.id` |
| `messages` | `run_id, at, role, text` | the rows `foldRunTranscript` reads: `log` by `messageType`, `stream.end.finalText`, `response.finalized` |
| `tool_calls` | `run_id, call_id, tool, input, status, result, started_at, ended_at` | `tool.start` joined to `tool.end` on `logId` |
| `usage` | `run_id, at, model, input_tokens, output_tokens, cost` | `usage` |
| `todos` | `run_id, content, status` | the latest `run.fact` with `key = 'todos'` |
| `reports` | `run_id, report, result_json` | `run.report`, `run.result` |

Rules:

- **No ledger rows.** C3 makes them readable only through `RunLedger`.
  Everything the model could want from them is already in the trace rows,
  and `flow.snapshot` is loop internals.
- **No redaction step.** Trace rows are scrubbed before they are written. The
  tool already returns the private records unredacted (there is no `redact`
  call anywhere under `src/tools/executions/` or in the readers it uses). The
  model already saw this content in some run's context. Adding redaction
  would protect nothing.
- **The project database only.** The global database (app state, inquiries,
  desktop projects) is out of scope.
- **One source for the view schema.** The `CREATE TEMP VIEW` text and a column
  summary live in one module. The tool description renders from it, the way
  `pathCatalog.ts` renders `EXECUTION_PATH_LIST`, so the model's first query
  needs no discovery call.
- **The views move with the vocabulary.** Any PR that bumps
  `SESSION_EVENT_FORMAT` and changes a row a view reads updates the view in
  the same PR. The existing `sessionEventFormat.vitest.ts` gains one case that
  prepares every view against a freshly opened store, so a view that stops
  compiling fails there.

### 3. The tool: a fourth arm

Add the arm to `ExecutionsToolInputSchema`:

```ts
const QueryActionSchema = z.strictObject({
  path: PathFieldSchema.nullish(),        // ignored; kept for union flattening
  action: z.literal('query'),
  sql: z.string().min(1).describe('One read-only SQL statement over the views below.'),
  params: z.array(z.union([z.string(), z.number(), z.null()])).nullish(),
});
```

- The handler is `Effect.fn('ExecutionsTool.query')`. It takes `Database`
  from context through the session it already resolves, and returns
  `executed(table, summary)`.
- **Errors.** `DatabaseQueryRefused` with reason `syntax` or `not-a-read`
  becomes a `ToolError` carrying SQLite's message, so the model can correct
  the query. `timeout` and `row-limit` also become a `ToolError`, and each
  says what limit was hit.
- **Output.** A plain-text table with at most 200 rows (the existing `limit`
  maximum) and per-cell truncation. It always ends with an explicit
  `N more rows; add LIMIT/OFFSET` line when rows were cut. Truncation is never
  silent.
- **Rendering.** It stays one tool, so the existing `executionsDisplay.ts` and
  `toolRowSections.ts` tool cards apply; they gain only a `query` preview
  (showing the SQL).

### 4. What it deletes

Per review checklist §13, a new port pays for itself in the same PR:

- `/children` and `/todos` are pure listing-fold reads. Each becomes one line
  of SQL, so the paths, their handlers (`showChildren`, `showTodos`) and their
  catalog entries go.
- `/executions` listing formatting stays for now. It is the model's cheapest
  first call.
- The PR reports net elements (R6) and consumer counts (R8).

Later candidates, once the query has proven itself: `/config` (its
category-filter logic moves into the `runs` view), and `/report` and
`/result` (keeping only the liveness note, which `/executions/{id}` already
has).

### 5. What stays

`wait`, `kill`, `/output`, `/executions/{id}`, `/files`, `/workspace-files`
and `/conversation` stay. They are actions, live state, the filesystem, or
the model's formatted first call. `/conversation` remains until the
view-state collapse settles where message text lives (see Open questions).

### 6. Phase 2: `query()` in workflow scripts

Workflow scripts already run model-written code
(`src/agent/workflowScript/`). The script yields `WorkflowOperation`s
(`Agent`, `All`, `Attempt`, `Retry`, `Timeout`), and `interpreter.ts` runs
each one as an Effect. `query()` becomes one more operation:

```ts
| { readonly _tag: 'Query'; readonly sql: string; readonly params: readonly SqlParam[] }
```

The interpreter runs it through the same `Database.query`. **Its result is
journaled** like an `Agent` result. History keeps changing while a run is
live, and replay is deterministic only if a resumed script sees the same rows
the first attempt saw. An orchestrator script then treats history as data:

```js
const failed = yield* query(
  "select id, error from runs where parent_id = ? and outcome = 'failed'", [args.runId]);
yield* all(failed.map((r) => agent(`Diagnose run ${r.id}: ${r.error}`)));
```

This is where "code as the tool" leads: the model's reads and its control flow
are written in the same program.

## Testing

This follows AGENTS.md "Testing discipline":

- `sessionEventFormat.vitest.ts`: one added case, in which every view
  prepares against a fresh store.
- The existing executions suite (`ExecutionsToolWorkspaceFiles.vitest.ts`)
  gets two cases: a query returns rows from a seeded store, and a write or a
  runaway recursive CTE is refused with its reason. Both use `it.effect` and
  mock nothing.
- `persistenceWriteBoundary.vitest.ts`: the allowlist entry, whose comment
  gives the argument from §1.

## Open questions

1. **Worker mechanism.** Use Effect 4's worker module or `node:worker_threads`
   under `Effect.acquireRelease`. Check against the pinned `4.0.0-rc.117`
   before implementing. Also decide between one worker per query and one
   pooled, idle-evicted worker per database. The pooled worker keeps the
   cost of opening a connection and creating the views off every call.
2. **`messages` after the view-state collapse.** C3's named residue says the
   collapse deletes the trace copy of message text, after which the display
   fold reads `model.message` with redaction applied. When that lands,
   `messages` must read the ledger through a projection that `RunLedger`
   owns, not directly. That is the point to decide whether `/conversation`
   retires.
3. **Scope across sessions.** One project database holds every session in
   the workspace. `runs` should probably default to what `/executions` lists
   today. Should cross-session history be reachable deliberately, through a
   `session_id` column, or not at all?
4. **Row and time budgets.** Proposed: 200 rows, 2 s wall clock, 2,000 chars
   per cell. These need a measurement against a large real database before
   they are fixed.
