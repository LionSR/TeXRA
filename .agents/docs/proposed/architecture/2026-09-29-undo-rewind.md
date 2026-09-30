# Undo and rewind: per-call file history and a rewind marker

Date: 2026-09-29

Status: proposed. The owner accepted undo/rewind for 1.0; this note decides
the design and waits for the owner's read before any code.

Audit baseline: `origin/main` `98aa293907`. The opencode reference is
opencode `origin/dev` `7945de2089` (`packages/core/src/snapshot.ts`,
`packages/core/src/git.ts`, `packages/core/src/session/revert.ts`).

## Summary

- **What is covered.** Every file TeXRA's own write path changes is
  recorded exactly, wherever it lives: the workspace, the custom agents
  directory, skill directories, a subagent's working directory. Tools that
  spawn processes (bash, the Claude Code and Codex tools, MCP servers) are
  covered by a stat scan of the roots they can write. For those tools, text
  files up to 1 MiB are restorable; binary and larger files are detected
  and named, but not restored.
- **Mechanism.** No git. Content-addressed file copies go in the session
  store: sha256, zstd level 3, and reachability collection, the same
  machinery the `blob` table uses. They sit in their own `file_blob` table
  so that event reads never inflate them.
- **When.** Nothing runs per step. A pre-image is taken when a write
  happens, and a scan runs around a process-spawning tool call only. A step
  that edits nothing costs nothing.
- **Recording.**
  - A `files.changed` row commits with each call's `tool.result`.
  - A `run.rewind` row hides the conversation after a boundary. It deletes
    nothing, and a later `run.rewind` can undo it.
  - A `run.agent` row pins the agent definition the run started with.
- **Surface.** The user bubble in the progress view (extension and
  desktop) gets a "Rewind to here" action. The TUI gets `/rewind`, and the
  CLI gets `texra rewind` for headless use. Each can restore the
  conversation, the files, or both, and each rewind can be undone.
- **Freeze.** No existing row kind and no existing table changes shape.
  Nothing has to land before the storage watermark (§9). The agent pin
  should land before it anyway, because a 1.0 run recorded without a pin
  can never be resumed pinned.

### What this deletes or collapses

Nothing is deleted. TeXRA has no undo today; `rewind`, `undo`, `revert` and
`checkpoint` have no file-history meaning anywhere in `src/` or
`packages/*/src`. Two things are reused instead of rebuilt:

- the write chokepoint, `writeApprovedContent`
  (`src/tools/approval/approvedWrite.ts`), which already reads the file in
  a per-file lane immediately before writing;
- the storage primitives of the 1.0 store design
  (`2026-09-28-storage-v1-design.md` §2, §7): content addressing, zstd and
  reachability collection.

## 1. Scope

**Covered exactly: every write through `writeApprovedContent`.**

- This is `write_file` and `edit_file`, which go through
  `applyApprovedFileEdit` (`src/tools/fileEditFlow.ts:262`), and
  `accept_run_files`, which calls `approvedWriteConflict`, a wrapper over
  the same function.
- The memory tool writes through a second site,
  `writeMemoryFile`/`deleteMemoryPath`
  (`src/tools/memory/memoryFileSystem.ts:127-144`). That site takes the
  same capture call, with root `memories`. Memories are agent-written state
  outside the workspace, so they count as self-edits.
- The pre-image is captured wherever the path lives: the workspace, the
  custom agents directory (`AgentDirectoryService.custom()`, default
  `<globalStorage>/custom_agents`), `<workspace>/.texra/skills`,
  `~/.texra/skills`, a subagent's `workingDirectory`, or the memory store.
- Self-edits are the risk that motivated undo. When an agent rewrites
  itself or another agent, it does so with these tools: the flow already
  reloads the catalog when the path is in the custom agents directory
  (`fileEditFlow.ts:292-305`). So self-edits are covered by the one
  mechanism, with no special case.

**Covered by scan: tools that spawn processes.**

- The tools are `bash` (`src/tools/bash.ts`), `claude_code` and `codex`
  (`src/tools/claudeAgent.ts`, `src/tools/codex.ts`), and MCP tool calls.
  None of them knows which files it touched.
- The scan covers these roots:
  - the workspace roots;
  - the call's working directory, when it is outside them
    (`bash.ts:373`);
  - the custom agents directory;
  - the two TeXRA skill directories.
- What is restorable is text files of at most 1 MiB that the ignore rules
  admit (§3).
- Binary files, larger files, and files a capped scan did not reach are
  still detected, because their stat changed. They are recorded as
  unrestorable with the reason, and the rewind dialog names them.

**Not covered.**

- Interop skill directories that TeXRA does not own, such as
  `~/.claude/skills`. They are outside the scan roots, and TeXRA's own
  tools write there only through the chokepoint, which does cover them.
- Writes a host makes outside any tool call, such as the progress view's
  Accept button when it does not go through `accept_run_files`.
- Git state: refs, the index and stashes. Rewind changes working files,
  never a repository.

**Workspaces that are not git repos get the same coverage.** Nothing in
this design reads git. That matters for TeXRA's users: most projects are
LaTeX papers, many are not repositories, and some hold hundreds of
megabytes of figures.

## 2. Mechanism: TeXRA's own content-addressed store

### Measurements

The scratch benchmark ran on 2026-09-29 on an APFS laptop with Node 26.9 and
git 2.54. It used synchronous APIs, one process, and a file cap of 2 MiB. It
measured two mechanisms:

- **A**, the own store: SQLite, sha256, zstd 3, and an in-memory stat index
  keyed by size, mtime and inode.
- **B**, an opencode-style shadow repo: `add --all` then `write-tree`, with
  and without `objects/info/alternates` and a copied index.

The projects were two real papers (copies), and this repository's worktree
as the code repo. The scratch data is removed.

| File set                                                   |   Files, bytes |                     A cold | A warm, no change | A warm, 3 edits | A new process |                   A store |                    B cold (plain / alternates) |    B warm |        B store |
| ---------------------------------------------------------- | -------------: | -------------------------: | ----------------: | --------------: | ------------: | ------------------------: | ---------------------------------------------: | --------: | -------------: |
| Paper 1, `.gitignore` applied                              |    97, 6.5 MiB |                      43 ms |              0 ms |            0 ms |          4 ms |                   4.4 MiB |                                    142 / 44 ms |     22 ms |  4.7 / 0.3 MiB |
| Paper 2, `.gitignore` applied                              |     93, 11 MiB |                      56 ms |              1 ms |            1 ms |          6 ms |                   8.9 MiB |                                    218 / 46 ms |     23 ms |  9.2 / 0.2 MiB |
| Code repo (this worktree)                                  |  2,857, 32 MiB |                     227 ms |              8 ms |            6 ms |         67 ms |                  13.4 MiB |                                  1,492 / 95 ms | 87–100 ms | 21.4 / 0.4 MiB |
| Paper 2, no ignore rules                                   |    148, 16 MiB |                     132 ms |              2 ms |            2 ms |         34 ms |                  10.4 MiB |                                     764 ms / — |     55 ms |       11.1 MiB |
| Paper 1, no ignore rules (a non-git user's folder)         | 5,118, 822 MiB |                   3,425 ms |             18 ms |           18 ms |        549 ms | 1.3 GiB before checkpoint | failed: `pathspec … is beyond a symbolic link` |         — |              — |
| Paper 1, no ignore rules, text files of at most 1 MiB only | 3,728, 171 MiB | 878 ms (hash and compress) |                 — |               — |             — |             40.5 MiB zstd |                                              — |         — |              — |

A stat-only walk takes 64–79 ms for 5,168 files. On the largest project on
this disk, 127,200 files and 10 GB, it takes 1.4–2.7 s.

What the numbers say:

- **Warm steps are cheap for both mechanisms.** The own store with its
  stat index takes 0–18 ms, and a git capture 22–100 ms, most of that
  process spawn and index refresh.
- **Git wins on storage only in a git repo with alternates.** There the
  store is nearly free, because blobs are never re-hashed. Without
  alternates it stores the same bytes as A, and its cold capture is 3–6
  times slower.
- **The real cost is what gets captured, not how.** In a non-git paper
  folder with no ignore file, a whole-tree baseline is 822 MiB of mostly
  incompressible PDFs, and the capture took 3.4 s. The shadow repo failed
  outright on a symlinked `Diffs/` folder, a common layout in paper
  directories. Restricting capture to text files of at most 1 MiB cuts the
  same folder to 40.5 MiB.

### Decision

Use TeXRA's own store and no git.

- **Git is not guaranteed.** It is an optional tool in
  `ProbeEnvironmentTool`. On a Mac without the command line tools, `git`
  opens an install prompt. On Windows it is often missing.
- **One path, not two.** Every production spawn of git today tolerates its
  absence (`workspaceInfo.ts:67`, `pluginGit.ts`, `latexdiff.ts:284`). A
  snapshot that needed git would be the first hard dependency, and it
  would need a second, git-free path for the users who most need undo.
- **It is built from primitives the store already has.** The store already
  does sha256, zstd through `node:zlib`, SQLite and reachability
  collection. The stat index replaces git's index at a fraction of the
  per-step cost.
- **opencode's whole-tree snapshot is the wrong unit here.** TeXRA knows
  exactly what its own tools write, so a tree hash per step would pay the
  baseline cost to learn what the chokepoint already knows.

### Physical layout

Two additive tables go in the workspace session store, in the `ADDITIVE`
list of `src/controllers/session/storeSchema.ts`. Every open creates them
with `CREATE … IF NOT EXISTS`, and `SCHEMA_VERSION` does not change.

```sql
CREATE TABLE IF NOT EXISTS file_blob (
  digest TEXT PRIMARY KEY CHECK (length(digest) = 64),  -- sha256 of the raw bytes
  value  BLOB NOT NULL,                                  -- zstd level 3 of the raw bytes
  size   INTEGER NOT NULL,                               -- uncompressed bytes
  at     INTEGER NOT NULL                                -- last capture that touched it
) STRICT;
CREATE TABLE IF NOT EXISTS event_file (
  "commit" INTEGER NOT NULL REFERENCES event("commit") ON DELETE CASCADE,
  digest   TEXT NOT NULL REFERENCES file_blob(digest),
  PRIMARY KEY ("commit", digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS event_file_digest ON event_file(digest);
```

Why the file copies get their own table instead of the `blob` table:

- **Reads would inflate them.** Every event read selects its row's blobs
  through `event_blob` (`EVENT_COLUMNS` in `rowCodec.ts`). If file
  contents rode `event_blob`, a run load would pull every file it ever
  changed.
- **Different encodings.** `blob` holds zstd of a JSON-encoded string
  under the string's sha256, while a file is raw bytes. A `read_file`
  result of 4096 or more characters would share a digest with that file's
  copy but not its encoding.
- **Age.** The scan baseline (§3) needs a timestamp to be collected by,
  and `blob` has none.

The codec stays the only module that knows a stored shape:

- The `files.changed` and `run.rewind` entries in `ROW_KINDS` name the
  digests their payloads reference.
- The codec writes the `event_file` rows in the append transaction, as it
  writes `event_blob` today.
- Nothing above the codec sees `file_blob`. File bytes are read and written
  through one small port, `FileHistory` (`put`, `get`, `has`), served by
  the session store.

Writes to `file_blob` never hold the store's write lock for long. Bytes
are hashed and compressed with the async `node:zlib` and `node:fs` APIs,
off the host thread, before the transaction opens. A scan baseline inserts
in chunks of about 2 MiB per transaction, under the store's busy retry
(storage design §8).

## 3. When capture happens, and the cost bound

Capture never runs per step. It runs when a write happens.

### At TeXRA's write chokepoint

`writeApprovedContent` already holds a per-file lane, keyed by the real
path, for its read-merge-write. Inside that lane, immediately before the
write, it:

- reads the file's raw bytes. The read is byte-exact, not the
  line-normalized text `readNormalizedFile` returns, because a restore must
  be exact;
- records the file's `lstat` mode;
- `put`s the bytes, and adds `{ path, before, after }` to the call's
  collector (§4).

A file that does not exist yet has `before: absent`.

The captured pre-image is the bytes on disk at write time, not the version
the approval diff was computed against. So an undo restores a user's
concurrent edit that landed during the approval wait. Cost: one extra read,
one sha256 and one zstd of the one file being written, in milliseconds.

### Around a process-spawning call

A module in `src/tools/` exposes `recordFileChanges(roots, effect)`. Bash,
`claude_code`, `codex` and the MCP call path wrap only their execution in
it. The wrap goes after approval, so an approval wait is never inside the
window.

The steps:

1. **Pre-scan.** A stat walk of the roots, which does not follow symlinks.
   It applies:
   - the workspace `.gitignore` and the global ignore, through the
     existing `src/tools/gitignore.ts`;
   - a built-in list of LaTeX and tool outputs: `*.aux`, `*.log`, `*.out`,
     `*.toc`, `*.fls`, `*.fdb_latexmk`, `*.synctex.gz`, `*.blg`, `build/`,
     `.texpadtmp/`, `node_modules/`, `.git/`.

   Each text file of at most 1 MiB whose stat differs from the in-memory
   index is read, hashed and `put`, and the index is updated. A file is
   text when its first 8 KiB contain no NUL byte.

2. **Execute.**

3. **Post-scan.** The same walk. Every path whose stat changed, appeared,
   or disappeared becomes an entry:
   - `before` is the index's digest when it holds the file, or
     `unknown: binary | too-large | not-captured`;
   - `after` is hashed now. A text file's new bytes are hashed but not
     stored, because a later rewind captures whatever it overwrites (§4).

The stat index lives in the process only. The first wrapped call in a
process re-hashes the text set. The measurements put that at 4–67 ms for an
ignore-filtered repository and up to 0.9 s for a messy paper folder. Blobs
already present are not compressed again, and they are touched
(`ON CONFLICT DO UPDATE SET at`).

**Cost bound.**

- **Per wrapped call:** two stat walks, 10–80 ms for up to 5,000 files,
  plus reads of the files that changed.
- **Per root:** a walk that reaches 20,000 entries stops. That root is
  recorded as `uncovered: too-many-files` on every wrapped call until the
  process restarts, with one `warn` log and a note in the rewind dialog.
  This is loud, never silent. The 127,000-file project above needs
  1.4–2.7 s per walk, so without the cap a single bash call would cost
  3–5 s.
- **Storage:** the text baseline once per workspace, deduplicated across
  runs. That is 4.4–13 MiB for the ignore-filtered projects measured and
  about 40 MiB for the worst unfiltered paper.
- **Chokepoint writes:** proportional to the files the agent writes.

## 4. Recording

### New row kinds

All three kinds are new and live on the run aggregate. No existing kind
changes shape.

```ts
const FileStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({
    kind: z.literal('file'),
    digest: Sha256Schema,
    mode: z.int().nonnegative(),
    stored: z.boolean(), // false: digest only, bytes not kept
  }),
  z.strictObject({ kind: z.literal('symlink'), target: z.string() }),
  z.strictObject({
    kind: z.literal('unknown'),
    reason: z.enum(['binary', 'too-large', 'not-captured']),
  }),
]);

const FileChangeSchema = z.strictObject({
  path: z.string().min(1), // absolute real path
  root: z.enum([
    'workspace',
    'working-directory',
    'custom-agents',
    'skills',
    'memories',
  ]),
  before: FileStateSchema,
  after: FileStateSchema,
});

// The files one settled call changed; commits in the settlement batch,
// immediately after that call's `tool.result`.
durable('files.changed', {
  callId: CallIdSchema,
  source: z.enum(['write', 'scan']),
  changes: z.array(FileChangeSchema),
  uncovered: z.array(
    z.strictObject({ root: z.string(), reason: z.literal('too-many-files') }),
  ),
});

// Conversation, files, or both moved back to the state before `to`.
durable('run.rewind', {
  to: CommitOrdinalSchema, // first commit hidden: the turn's opening row
  keepPrefix: z.int().nonnegative(), // messages kept, computed at write
  scope: z.enum(['conversation', 'files', 'both']),
  undoes: CommitOrdinalSchema.nullable(), // the rewind this row undoes
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      root: FileChangeSchema.shape.root,
      previous: FileStateSchema, // what was on disk, captured before the write
      restored: FileStateSchema, // what the rewind wrote
      outcome: z.enum(['restored', 'kept', 'failed', 'unrestorable']),
      detail: z.string().nullish(),
    }),
  ),
});

// The agent definition the run launched with; the definition is a
// `context.blob` row with this digest.
durable('run.agent', { definition: Sha256Schema });
```

### Who writes the rows

- **`files.changed`.** A per-call collector (a `Ref`) is served in the
  call's context beside `ToolCall`. Dispatch reads it at settlement and
  appends the row in the batch that carries the call's `tool.result`
  (`toolUseDispatch.ts:321`), through the run's one ledger writer. A tool
  never writes a row; the card stays loop-owned.
- **A duplicate call** writes no row, because it has no effects.
- **An interrupted call.** If the process dies mid-call, it leaves a
  `tool.intent` with no `tool.result`. Its pre-images are orphans in
  `file_blob`, and the rewind dialog lists that call as "interrupted; its
  changes were not recorded". This is loud and derived from the rows.

### The boundary

A rewind names a commit, never a step. "Rewind to here" on a user turn uses
the commit of that turn's opening row: the `model.message` `append` that
delivered the user's message, or its `followup.consumed`.

`commit` is store-global and ordered, so a boundary also orders the run's
descendants. A child run spawned after the boundary is inside the rewound
span, and its file changes are reverted with the parent's. Parallel root
runs in the same workspace are not touched. If one of them wrote the same
file later, the conflict check (§8) catches it.

For each path, the plan is:

- **Restore target:** the `before` of the earliest `files.changed` entry
  for that path with commit ≥ `to`, in the run's subtree.
- **Expected current:** the `after` of the latest such entry.

No full-tree manifest is ever stored.

### Order of a rewind

1. **Plan.** Compute each path's restore target and expected current.
2. **Check conflicts.** Hash each file as it is now (§8).
3. **Capture.** `put` the current bytes of every file the rewind will
   overwrite. This is `previous`, what makes the rewind undoable.
4. **Append.** Write `run.rewind`, with `previous` referenced, so those
   bytes are reachable before anything on disk changes.
5. **Restore.** Write each file atomically: a temp file in the same
   directory, then a rename, with the mode applied.
6. **Report.** Show the per-file outcomes to the user. A failed write is
   logged at `warn` and shown in the dialog.

The row is written ahead of the file writes on purpose. A crash between
steps 4 and 5 leaves a rewind that names bytes it may not have written. An
undo re-applies every `previous` under the same conflict check, so the
state stays recoverable.

### Fold semantics: hidden, not deleted

`foldRunState` gets one arm, modelled on `model.compaction`
(`runStateFold.ts:557-577`).

**A rewind** (`undoes: null`, scope `conversation` or `both`):

- The messages become `messages.slice(0, keepPrefix)`. The dropped tail
  is kept in `RunState.rewound`, keyed by the row's commit.
- `continuation` is reset, so no provider-side `previous_response_id` still
  holds the hidden turns. So are `offeredSystem` and `offeredContext`,
  which makes the next step record what it offers again.
- `turn` goes back to the boundary's turn.
- `usage` is unchanged, because the money was spent.

The ledger writes a `run.snapshot` after the rewind. It carries the
workspace slices (`readFiles`, `edits`, the work plan) from the latest
snapshot before `to`, followed by a `run.position` `waiting`. Both are
existing kinds at their current shapes.

**An undo** (`undoes` set):

- The stashed tail is appended back.
- The row is valid only while the run has no turn since the rewind:
  `messages.length === keepPrefix`. Once the user sends a new turn, the
  rewound span stays hidden for good, and the transcript still shows it.

**The precondition, a ledger refusal** (`inconsistent`, never a defect): the
run is at rest, so `pendingResponse` and `openAttempt` are both null, and
none of its descendants is running.

A `files`-only rewind leaves the conversation alone. It can be undone at any
time, because it touches only files and has the same conflict check.

The transcript is a separate projection over session events
(`src/shared/session/transcriptFold.ts`), and it hides nothing. Rows with
commit in `[to, rewind)` fold into one collapsed "Rewound: N turns" block,
the way compaction blocks fold now. An undo expands the block again.

## 5. User surface

The action has one home, the user's message. Secondary surfaces only show
status.

**Extension and desktop.** Both render the same `ProgressApp`.

- `<user-message>` (`progressView/frontend/components/UserMessage.ts`) gets
  a hover action, "Rewind to here", next to copy.
- It opens a dialog built from a dry-run plan the host-neutral controller
  returns:
  - a choice of **Conversation and files** (the default), **Conversation
    only**, or **Files only**;
  - the files that will change, each marked restore, conflict (with a diff
    of now against the restore target, and a per-file choice that defaults
    to "keep current"), unrestorable (with the reason), or interrupted.
- A conversation rewind puts the rewound message's text back in the
  composer.
- The transcript shows the collapsed block with **Undo rewind** until the
  next turn.

**VS Code only.** Before a restore, the extension checks
`workspace.textDocuments` for dirty buffers on planned paths and asks the
user to save or discard. This check is a host port served in
`packages/extension/src/`. Core never imports `vscode`.

**CLI TUI.**

- `/rewind` lists the run's user turns in a picker (it registers beside
  `compact` in `handlers/sessionCommands.ts`), then shows the same choice
  and file list.
- `/rewind undo` undoes the last rewind.

**Headless.** `texra rewind <run> --to <turn> [--files | --conversation]
[--yes]` runs the same request. It prints the plan and exits non-zero on
any conflict unless `--yes` is given with a conflict policy
(`--on-conflict keep|overwrite`, default `keep`). This is also the E2E
driver.

**One request for all hosts.**

- A new `run.rewind` runtime request in `SessionRequests.ts`, gated through
  `GATED_ACTIONS` by a new `rewind` run action. The run's `actions` offer
  it only when the run is at rest.
- A `run.rewind.plan` read returns the dry-run plan.
- The planner and the restore live in `src/controllers/session/rewind.ts`
  and are host-neutral. They write through the process `FileSystem`, with
  the root check in §8.

Workflow runs do not get the action in 1.0. Their outputs reach the
workspace only through `accept_run_files`, which the chokepoint records, so
a rewind of the tool-use run that accepted them restores those files.

## 6. Pinning the agent definition

What happens today:

- `resumeToolUseFromResumeData` (`src/agent/runtime/executeAgent.ts:474`)
  calls `prepareAgentDefinition` (`AgentLaunchContext.ts:217`), which
  resolves the agent from the live catalog on disk.
- `run.config` stores only `agent` and `agentSource`, and no digest of the
  definition exists anywhere.
- The system text is frozen at the first step, but the agent's setting is
  re-read on resume: the model, the tools, delegation and skills.

So a run whose agent edited its own YAML resumes as the edited agent.

The decision:

- **At launch,** `prepareAgentDefinition` writes the resolved definition,
  `{ source, path, setting, prompt }`, as a `context.blob` row under its
  canonical JSON digest, followed by `run.agent { definition }`. Both go in
  the run's opening ledger batch, beside the first `tools.offered`.
- **On resume,** `prepareAgentDefinition` reads the pinned blob and never
  the catalog.
- **Fresh launches** read the catalog, as now. A user who wants the edited
  agent starts a new run.
- **Rewind does not change a pin.** Restoring the agent YAML file restores
  the catalog for future runs; the running one never used the edit.
- **Subagents** get their own pin at their own launch, so a child launched
  after its parent's self-edit runs the edited child agent. That is the
  honest reading of "the definition this run started with".

## 7. Collection and retention

File history lives exactly as long as its run. There is no time-based
expiry in 1.0.

- **Run deletion.** `collectDeletion` (`Database.ts:1127`) already cascades
  the run's events, which now cascades `event_file` too. Its final
  transaction also reads the file digests the collected rows referenced,
  and deletes those that no remaining `event_file` row names. This mirrors
  the blob rule (storage design §7), and the `event_file.digest` foreign
  key makes deleting a reachable file blob impossible.
- **The scan baseline.** These are blobs no row references. Housekeeping at
  store open deletes unreferenced `file_blob` rows whose `at` is more than
  7 days old, and a capture touches `at`. This is opencode's
  `gc --prune=7.days`, done by reachability plus age.
- **A process that runs longer than that.** Its stat index can name a
  swept blob. At settlement, a `before` whose blob is missing is recorded as
  `unknown: not-captured`, which is loud, never a dangling digest.
- **`texra doctor`** reports each store's file-history bytes, referenced
  and unreferenced.
- **`texra doctor --prune-storage`** also deletes every unreferenced
  `file_blob`, whatever its age, and runs the incremental vacuum.

## 8. Risks

**User edits made outside TeXRA** (an editor, another run, git). Before any
write, the rewind hashes the file on disk and compares it with the expected
current `after`:

- **Equal:** the restore proceeds.
- **Different:** the file is a conflict. The dialog shows both versions and
  defaults to keeping the current one; headless mode keeps it unless
  `--on-conflict overwrite` is given.
- **Either way,** the overwritten bytes are captured as `previous`, so even
  a chosen overwrite can be undone.
- **A file the span created** (`before: absent`) is deleted only when it is
  unchanged since TeXRA's last write. Empty directories the span created
  are left in place, and the dialog says so.
- **A scan cannot tell who changed a file.** A user edit made during a bash
  call is attributed to that call. The window is the call's execution
  time, and the conflict check still guards the rewind.

**Symlinks.**

- Scans use `lstat` and never follow links, so a symlinked folder is never
  walked twice or escaped through.
- A symlink change is recorded as `symlink { target }` and restored as a
  link, never written through.
- The chokepoint records the real path it wrote.
- Before each restore write, the target's real path (the nearest existing
  ancestor for a missing file) must still be inside one of the covered
  roots. A path that now escapes, for example a folder someone replaced
  with a link, is `unrestorable` with that detail.

**Permissions.**

- The mode is recorded and restored, so a script keeps its executable bit.
- A write that fails with `EACCES` or `EPERM` gets a `failed` outcome
  carrying the error. The remaining files and the conversation part of the
  rewind still apply, and the dialog lists the failure.
- On Windows the mode is recorded but only the read-only bit is applied.

**Size.** The chokepoint captures what the model writes, which is text
bounded by the model's output. Files over 16 MiB are recorded as
`unknown: too-large`.

## 9. Plan

### Nothing has to land before the watermark

Checked against the code:

- **New kinds.** `files.changed`, `run.rewind` and `run.agent` are new, so
  each arrives as version 1 of its kind in `ROW_KINDS`, whenever it lands.
- **Existing kinds.** The design deliberately puts no snapshot id on
  `model.message`, on the attempt, or on `tool.result`: the boundary is an
  existing row's `commit`. The rows it writes of existing kinds
  (`context.blob`, `run.snapshot`, `run.position`) keep their current
  shapes.
- **Tables.** `file_blob` and `event_file` are in the `ADDITIVE` list, so
  `SCHEMA_VERSION` stays at 101.
- **Downgrades.** A 1.0 build that opens a store written after these lanes
  sees an unknown kind on runs that recorded file history, and shows those
  runs as `Blocked`. It never rewrites them; this is the storage design's
  accepted cost for a newer kind. Its `collectDeletion` leaves orphaned
  `file_blob` rows, which the next newer build sweeps.

### Recommended before the watermark: Lane 1 only

If the agent pin ships after 1.0, every run recorded by 1.0 has no
`run.agent` row, and no upcaster can invent one. Resume would then need a
permanent "pinned, else the catalog" branch for those runs. That is a
format-version branch downstream, which the Zod rules forbid. Landing
Lane 1 first avoids the branch entirely.

### Lanes

| Lane                        | Work                                                                                                                                                                                                                                                       | Effort | Depends on | E2E proof (cheap models: `gemini38f`, `deepseek41T`, `glm53flash`)                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Agent pin                | `run.agent` kind; the `context.blob` of the resolved definition in the opening batch; `prepareAgentDefinition` reads the pin on resume.                                                                                                                    | 1 day  | none       | `texra run` with a custom agent that edits its own YAML (changing its `model`), kill the process, `texra run --resume`; the resumed run's `run.model` row shows the launch model. Artifact: the two `run.model` rows and the YAML diff.                                                                                                    |
| 2. File store and writes    | `file_blob`, `event_file`; codec file references; the `FileHistory` port; the per-call collector; capture in `writeApprovedContent`; `files.changed` in the settlement batch; `collectDeletion` and housekeeping; the `texra doctor` report.               | 3 days | none       | A run that `edit_file`s `main.tex` and a custom agent YAML; `sqlite3` dump of the `files.changed` rows and `file_blob` count; delete the run; the count returns to zero.                                                                                                                                                                   |
| 3. Rewind core and headless | `run.rewind` kind; the fold arm and the transcript block; the planner, conflict check, `previous` capture, atomic restore, modes, symlinks and root check; undo; the `run.rewind` request, `rewind` run action and `run.rewind.plan` read; `texra rewind`. | 4 days | 2          | A fixture paper plus a custom agent: two turns that edit files; `texra rewind --to 1 --yes`; `diff -r` against the pre-run copy is empty; `texra rewind` undo; `diff -r` against the post-run copy is empty. A third case edits a file by hand between the run and the rewind and checks that the file is kept and reported as a conflict. |
| 4. Process-tool scan        | the walker (ignore rules, built-in LaTeX list, no symlink follow, 20,000-entry cap), the stat index, the text baseline, `recordFileChanges` around `bash`, `claude_code`, `codex` and MCP calls.                                                           | 3 days | 2, 3       | The agent runs `sed -i` on `main.tex` and `rm` on a `.bib` through bash; rewind restores both byte-exactly (`cmp`); a deleted PNG is reported `unrestorable: binary`.                                                                                                                                                                      |
| 5. Host surfaces            | the `ProgressApp` user-message action and dialog (extension and desktop); the VS Code dirty-buffer port; the CLI `/rewind` picker and `/rewind undo`.                                                                                                      | 3 days | 3          | Desktop: the Electron smoke runner's screenshot of the dialog and of the collapsed block, then the `diff -r` check. CLI: PTY harness frames of `/rewind` against the same fixture.                                                                                                                                                         |

Lanes 1 and 2 run in parallel. Lane 3 follows Lane 2. Lanes 4 and 5 run in
parallel after Lane 3. The total is about 14 lane-days. Each lane's E2E
test leaves a diffable artifact; the lanes add no unit tests beyond those
the fold arm's failure list earns.

## 10. Open questions for the owner

1. **Can an undo survive a new turn?** This note says no: once the user
   sends a turn, the rewound span stays hidden. Keeping it undoable means
   merging two branches of a conversation, which is a fork, not an undo.
2. **Expiry.** File history lives as long as its run. Should old runs lose
   their file history, but keep their conversation, after N days? That
   would need a new retention row, because rows are append-only.
3. **Resume with an edited agent.** This note always resumes pinned.
   Should a "resume with the current definition" action exist after 1.0?
4. **Binary files changed by a process tool** are detected but not
   restored. Is that acceptable for figures that scripts regenerate, or
   should binaries of at most 2 MiB be captured too, at the measured
   storage cost?
5. **Timing:** whether Lane 1 lands before the storage freeze.
