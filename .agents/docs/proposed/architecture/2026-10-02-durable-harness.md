---
created: 2026-10-02
status: accepted
---

# The durable harness: one ledger, one script tool, everything else a plugin

Baseline: `main` at `f78a5501ff` (includes #13604, durable approvals). Line
references point into that tree. References to the code-mode design point to
[`2026-10-01-codemode-everywhere.md`](./2026-10-01-codemode-everywhere.md),
called "the codemode doc" below. Codemode lanes 1–7 have since merged
(#13616–#13626); "Since the baseline" says what that changed here.

Accepted 2026-10-02 with owner rulings on five of the six questions (see
"Owner rulings"). The package names (Q5) stay open.

## Summary

The owner wants a general, Effect-native, durable agent harness, with TeXRA
as one app on it ("texra would just be an example", 2026-10-01). He wants
something like pi-durable, and TeXRA already has a strong base for it
(2026-10-02). This note does not port pi-durable. It names what TeXRA already
has, closes the gaps pi-durable shows, and draws the line between the harness
and the app.

The harness has five parts:

1. the durable ledger and the run loop;
2. `script` as the one model-facing tool, from the codemode doc;
3. everything else contributed by plugins into the generational Registry:
   tools, MCP servers, agents, skills, and domain capabilities such as
   LaTeX, papers and Lean;
4. a hot-pluggable tool engine, which changes the catalog at step
   boundaries;
5. tool search over the pinned catalog, so that a large catalog costs no
   prompt tokens.

Most of it exists or is being built in the codemode lanes. This note adds
six things:

- a durable rule for who owns a child run;
- one row kind for every edit of the model's view, which compaction, reset,
  handoff and fork all use;
- fork as a `run.start.provenance` arm;
- auto-continue when a session opens, with a per-host default (ruling
  Q2) and blocked-until-installed;
- the "extend" half of the SDK, built as Effect values over the plugin table
  that exists today;
- a crash-point conformance suite in place of a prose specification.

Three of these change row shapes, so they must land before the freeze. The
rest can follow it.

## The shape

```
            ┌──────────────────────────────────────────────────────────┐
 discovery  │ searchTools (BM25) · describeTool, over the pinned       │ codemode lane 5
            │ generation                                               │
            ├──────────────────────────────────────────────────────────┤
 registry   │ Registry<K,V> generations: tools · continuations ·       │ exists
            │ prompt sections · process/session layers                 │
            │   ▲ built-in harness plugins (file-ops, web, memory,     │ exists (table)
            │   │   goal, agent, codemode)                             │
            │   ▲ TeXRA app plugins (latex, arxiv, crossref, zotero,   │ exists; moves to
            │   │   lean4, texcount, wolfram, documents)               │   the app (H3)
            │   ▲ MCP servers (stdio, trust per content hash)          │ exists
            │   ▲ installed Claude Code / Codex plugins: data + hooks  │ exists
            │   ▲ embedder plugins (SDK, first-party, in process)      │ new (H4)
            ├──────────────────────────────────────────────────────────┤
 step       │ Step.open pins every registry, records tools.offered,    │ exists
            │ contextUpdate; a stale call settles tool_unavailable     │
            ├──────────────────────────────────────────────────────────┤
 script     │ `script` tool → CodeSandbox (QuickJS on a worker)        │ codemode lanes 1–2
            ├──────────────────────────────────────────────────────────┤
 per call   │ hooks · guard · approval · body · settle                 │ exists
            ├──────────────────────────────────────────────────────────┤
 loop       │ toolUse.ts: one Effect program over the run ledger       │ exists
            ├──────────────────────────────────────────────────────────┤
 ledger     │ RunLedger.appendBatch (fold-validated) · SessionEvents   │ exists
            │ (one publisher) · SQLite, blobs, row versions, claims    │
            └──────────────────────────────────────────────────────────┘
```

| Layer                                                                 | Where it is                                                                                                                                                                                                                                                                     | Status                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Ledger                                                                | `RunLedger` (`src/shared/session/runLedger.ts:86`); `appendBatch` folds the batch first and refuses `inconsistent` (`src/agent/runtime/RunLedger.ts:402`, `:429-431`); one publisher (`src/shared/session/sessionEvents.ts:77`)                                                 | exists                         |
| Loop                                                                  | `src/agent/runtime/loop/toolUse.ts`; resume through `resumeRun` (`src/agent/runtime/resumeRun.ts:109`)                                                                                                                                                                          | exists                         |
| Per-call program                                                      | `toolUseDispatch.ts:393` (`executeCall`), `:817` (`dispatchCall`), `:672` (outcome unknown)                                                                                                                                                                                     | exists                         |
| `script` and sandbox                                                  | the codemode doc, lanes 1–2                                                                                                                                                                                                                                                     | codemode                       |
| Step                                                                  | `Step.open` (`src/agent/runtime/loop/step.ts:190`), `tools.offered` (`:393`), stale calls (`:417-419`); `contextUpdate` (`src/agent/prompt/PromptBuilder.ts:97`)                                                                                                                | exists                         |
| Registry                                                              | `makeRegistry` (`src/tools/liveRegistry.ts`, 160 lines: contribute in a `Scope`, rebuild, pin with `RcMap`, drain); `LiveTools.pinSwitched` (`src/tools/liveTools.ts:81`); MCP holds (`src/tools/serverHolds.ts`); trust per digest (`src/common/plugins/pluginTrust.ts:44-54`) | exists                         |
| Plugin table                                                          | `ToolTable` (`src/tools/toolTable.ts:167`); TeXRA's instance `TOOL_TABLE` (`src/tools/registry.ts:285`); the kernel takes any table through `toolTableLayer(table, …)` (`liveTools.ts:417`)                                                                                     | exists; the binding moves (H3) |
| Discovery                                                             | `searchTools`, `describeTool`                                                                                                                                                                                                                                                   | codemode lane 5                |
| Blocked-until-installed, owned children, view edits, fork, SDK extend | this note                                                                                                                                                                                                                                                                       | new, H1–H5                     |

The hot-plug engine is already sound. The 2026-09-27 live-plugins ruling is
built for tools, continuations and prompt sections (#13364, #13387). When a
plugin is switched off, its contribution scope closes, its entries leave the
next generation, and generations that still pin it drain through `RcMap`. A
call that is already in flight finishes on the generation that offered it,
because the step holds its pin until the next step pins (`step.ts:12-17`). A
resumed call whose tool changed settles as `tool_unavailable`. A script
keeps the pinned generation for its whole run (codemode doc, "Fit with the
plugin model"). This note does not redesign any of that. It does two things
for the engine: it makes the table an input rather than an import (H3), and
it lets an embedder contribute to it (H4).

## What TeXRA already has

pi-durable 1.0.0 (`packages/durable`, its spec at `docs/spec.md`) compared
with TeXRA on `f78a5501ff`. "Stronger" means TeXRA holds an invariant that pi
does not.

| pi-durable concept                                                          | TeXRA piece                                                                                                                                                                                                                               | Verdict                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Atomic session commit, immutable entries (spec §1, `:41-44`)                | One publisher per root; commit order is enqueue order (`sessionEvents.ts:77`, jobs `:89-126`)                                                                                                                                             | equal                                                                                                                               |
| Committed state is the only truth                                           | `appendBatch` folds the candidate batch with `foldRunState` before publishing and commits nothing if the fold refuses (`RunLedger.ts:402-431`; `runStateFold.ts:782`)                                                                     | stronger: pi validates per entry type; TeXRA validates the whole run projection                                                     |
| Effect sandwich: intent, effect, outcome (`spec.md:1825-1841`)              | The attempt row and its context blobs commit before the request leaves the process (`ModelInvoker.ts:592-596`; `requestContext.ts:124`); a response commits before its tools dispatch; `tool.result` commits before the loop continues    | stronger: a billed attempt is always on disk                                                                                        |
| Tool `replay: safe \| unsafe`, rerun only when both say safe (`:2977-2984`) | `DispatchFacts.replay` (`runLedgerEvent.ts:111`), `replayable` (`run/tools.ts:139-146`), default `unsafe` (`ToolTypes.ts:79`)                                                                                                             | equal: the same binary rule                                                                                                         |
| `interrupted` result for an unsafe in-flight call                           | `decideOutcomeUnknown` asks "Run again / Skip" as a durable request (`toolUseDispatch.ts:672`, `:861-863`)                                                                                                                                | stronger: a person decides; pi settles it as an error                                                                               |
| Retry                                                                       | Two owners: the route-scoped `ModelRetryGate` (`ModelRetryGate.ts:86`), and a durable human permit (`pendingRetry`, `runStateFold.ts:157`; `ModelInvoker.ts:841`)                                                                         | stronger                                                                                                                            |
| Approvals that survive a restart                                            | `tool.binding` beside `request.opened` (`runLedgerEvent.ts:300-317`; #13604)                                                                                                                                                              | stronger: pi has no approval model                                                                                                  |
| Hooks                                                                       | Recorded once per point as `hook.outcome` and reused on resume (`hooks.ts:167-176`, `:246`)                                                                                                                                               | stronger                                                                                                                            |
| Single writer per conversation                                              | Per-aggregate SQL claims with proved liveness, no clock lease (`Database.ts:409-412`, `:1027`; `leaseOwnerLiveness.ts:62`)                                                                                                                | stronger: multi-process                                                                                                             |
| Storage ports, three backends                                               | One SQLite store; content-addressed blobs (`storeSchema.ts:68`, `:83`; `rowCodec.ts:165-180`); a version per row kind with upcasters (`rowVersions.ts:41-91`)                                                                             | equal in substance; one backend on purpose                                                                                          |
| Extensions: named bundles, reloadable (§7.1)                                | Plugins: the manifest (`src/common/plugins/pluginManifest.ts:41`) plus the `satisfies` tables (`registry.ts:137-259`); live Registry; trust per content hash; out-of-process hooks                                                        | stronger on trust and live change; weaker on the embedder surface (gap 5)                                                           |
| `tool_unavailable` for a missing tool (`:736-743`)                          | `step.ts:417-419`; `toolUseDispatch.ts:530-535`                                                                                                                                                                                           | equal                                                                                                                               |
| Blocked-until-installed for a missing definition (`:1947-1989`)             | Only `run.blocked` for rows this build cannot read (`sessionFold.ts:597`)                                                                                                                                                                 | missing (gap 2)                                                                                                                     |
| Auto-continue on open (`:607-638`)                                          | None. "Interrupted" is computed on read from owner loss (`sessionFold.ts:568-591`); every resume is a user action or a follow-up wake (`hostRunActions.ts:592`; `ToolUseFollowUp.ts:117-173`; CLI `resumeRun.ts:211`)                     | missing (gap 2)                                                                                                                     |
| Structured concurrency: `completing`, bottom-up abort (§5.5)                | Live: a parent's stop cascades and waits for in-band children (`inBandSubagentRun.ts:393-415`; `runRegistry.ts:701-749`), and no child is admitted under a stopping parent (`:407-419`). Durable: nothing                                 | live equal; durable missing (gap 1)                                                                                                 |
| `defineDoc`: typed, versioned app state                                     | `plugin.fact {plugin, kind, version, value}` (`sessionEvent.ts:343-350`), with arms and upcasters (`pluginArms.ts:36`), latest value per (plugin, kind) in the listing                                                                    | equal for built-in plugins; fork-awareness is a single rule (gap 3)                                                                 |
| Fork, reset, handoff (`:640-659`, `:836-840`, `:2963-2971`)                 | None. "Edit as new task" prefills the launcher and carries no history (`hostRunActions.ts:665`)                                                                                                                                           | missing (gap 3)                                                                                                                     |
| Background compaction with a stale rule (§8.7)                              | Compaction runs inline between turns (`compaction.ts:129`; `toolUse.ts:485`); `model.compaction` replaces the history from `keepPrefix` on, with no range and no base to say what view it was computed from (`runLedgerEvent.ts:281-287`) | missing (gap 4)                                                                                                                     |
| `ExecutionEnv` (fs + shell) per conversation                                | `WorkspaceFs`/`StorageFs` per run (`rootedFs.ts:27`, `:33`; provided at `executeAgent.ts:113`); `ChildProcessSpawner` is process-wide (`processRuntime.ts:67-71`)                                                                         | half there (gap 5)                                                                                                                  |
| Same-path edit queue (`file-mutation-queue.ts:29-53`)                       | `withPerKeyLane` on the real path plus a three-way merge or conflict (`approvedWrite.ts:39-46`, `:105-131`)                                                                                                                               | stronger: the merge catches writers outside the lane                                                                                |
| `Submission` handle                                                         | SDK `Run.result`, `events`, `view`, `interrupt` (`packages/agent/src/effect/sessions.ts:59-89`)                                                                                                                                           | equal for a run started here; missing for reattaching after a reopen (gap 5)                                                        |
| Kernel, ports, subpath exports, conformance suite                           | `@texra-ai/agent` with `.`, `./schemas`, `./node`; a golden-store suite (`goldenStore.vitest.ts`, 684 lines; `golden-1.0.sql`)                                                                                                            | partly: the boundary is not drawn (Harness boundary below), and conformance covers storage but not crash points (Conformance below) |

## Since the baseline

Codemode lanes 1–7 merged as #13616–#13626. For gap 1 they already deliver:

- **A child's id comes from the call.** `agentChildRunId(call, attempt)`
  (`src/tools/delegation/agentChild.ts`) derives it from the parent run, the
  response, the call id and the intent attempt; `earlierChild` finds the
  child an earlier attempt launched. `agent` and background `script` share
  that one owner (#13621).
- **`agent` reattaches.** `recoverAgentChild` settles a resumed call from
  the child its earlier attempt left before anything is decided again: a
  settled turn with a manifest is read back, a child cut short resumes in
  band under its own id, and a child whose rows leave work unaccounted for
  gets an outcome question bound to the call (#13619). The golden store's
  `golden_fanout` run is killed mid-fan-out and resumes with no relaunch.
- **The workflow-script runner is gone,** with its crash refusal and
  `run.start.checkpointId` (lane 7, #13626). `delegate_multi_agents` and
  the delegate pair are deleted.

What gap 1 still needs is the durable half: `run.start.parent.callId`, the
fold's refusal of `run.end` over an open owned call, Resume on an owned child
routed to its parent, and the remaining paths that mint a fresh child id for
a call whose earlier child is still live.

## Gaps worth closing

Ranked by what a user loses today.

### The three code questions

**Does any host auto-resume at startup?** No. A run whose process died is
not written to at all. It reads as interrupted because its owner claim is
dead (`sessionFold.ts:568-591`), and it continues only when a user resumes it
(`hostRunActions.ts:592-594`; CLI `resumeRun.ts:211`; TUI `/resume`,
`packages/cli/src/chat/tui/commands/registerBuiltins.tsx:476-491`) or a follow-up wakes it
(`ToolUseFollowUp.ts:166-173`). A graceful close is different: it settles
open runs as CANCELLED (`sessionLayer.ts:799-890`).

**Can a parent reach a terminal state with a live non-detached child across a
crash?** Yes. In a live process it cannot, because an interrupted in-band
caller stops its child by id and waits for it (`inBandSubagentRun.ts:393-415`).
Across a crash, both runs are left non-terminal. When the parent resumes, its
delegation call is `replay: 'unsafe'`, so it gets the outcome-unknown
question. "Run again" starts a new child with a fresh id and does not
reattach (`subagentRun.ts:155`). "Skip" lets the parent go on and end. Either
way the old child is an orphan. It can still be resumed by itself
(`resumeRun.ts:341-357`), and it then delivers to an ended parent, which is
revived or the delivery is dropped with a warning
(`childRunLoop.ts:478-492`). The fold has no parent/child check:
`runStateFold` ignores `run.start`, `run.detach` and `run.end`
(`runStateFold.ts:221-226`). The workflow-script runner refused the crash
case outright; it was deleted in codemode lane 7. The edge itself is
durable (`run.start.parent`, `sessionEvent.ts:261-270`). The live tree is not:
every run forks on the session `FiberSet` (`sessionLayer.ts:517`;
`runRegistry.ts:441`), and the parent is data.

**Are same-path edits serialized?** Within one run, yes: edit and write
tools are not `parallelSafe`, so each one is a barrier
(`run/tools.ts:95-110`). Across runs in one process, yes: `edit_file`,
`write_file` and `accept_run_files` do their read, merge and write on a
process-wide `withPerKeyLane` keyed by real path (`approvedWrite.ts:39-46`,
`:128`). If the merge fails, the result is `ApprovedEditConflictError` and
nothing is written. Across processes, nothing is serialized; the
merge-or-conflict check leaves a small window. `bash` writes are not covered
anywhere, and neither are pi's.

### The gaps

| #   | Gap                                                | Design (Effect-native)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Deletes or replaces                                                                                                   | Rows                                                                  | Before the freeze?                    |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| 1   | Durable child ownership                            | An awaited child belongs to the call that awaits it. Its id derives from `(callId, attempt)`, which codemode lane 3 already does for `agent`, and `run.start.parent` records `callId`. On resume, the parent's open `agent` call reattaches: it awaits the child's durable `run.end` if there is one, and otherwise resumes that child under the call. The call becomes replay-safe because it is idempotent by id. An owned child is never resumed by itself: Resume on it resumes its parent. The fold refuses `run.end` on a parent whose projection holds an open owned call.                                                                                              | The orphan path; "Run again" minting a new child id; the workflow runner's crash refusal (deleted in codemode lane 7) | `run.start.parent` gains `callId: string \| null` (null for detached) | yes (shape)                           |
| 2   | Auto-continue on open; blocked-until-installed     | Opening a session reads the listing's interrupted root runs and applies the host's policy (`off \| ask \| auto`; defaults per ruling Q2). `auto` calls `resumeRun` per root and owned children follow (gap 1). `ask` shows one prompt that lists them. A resume whose agent is missing, or whose declared plugin is not installed or not trusted, does not fail: the run stays interrupted with a reason in the projection, and a fiber following `AgentCatalog` and the tool registry's `current` (`SubscriptionRef`) retries it when either changes. Tool calls keep `tool_unavailable`.                                                                                     | "Resume" as the only way back after a crash; the per-host startup notices                                             | none: the reason lives in the projection, not in a row                | no                                    |
| 3   | Fork, reset, handoff                               | All three are one row (decision D2). **Fork** starts a new run whose `run.start.provenance` is `{ kind: 'fork', from, at }` and whose first ledger row is a view edit carrying the source's model view at `at`, as blob references, plus its offered system and tools. The cut must be a settled position: no open attempt, tool intent, request or retry. Pending sets are not copied, so the follow-up queue, requests and retry permits start empty, and usage starts at zero. Plugin facts are not copied; goal mode is paused, as on resume. **Reset** is the same edit on the same run with no messages. **Handoff** is reset plus the handoff text as a user follow-up. | "Edit as new task" becomes fork-at-end; the parked undo note (#13546) uses the same row when it is unparked           | D2 and D3                                                             | yes (shape); the behaviour can follow |
| 4   | Background compaction                              | Once the range exists (D2), a compaction can be computed off the loop. A fiber in the run scope summarises the range `[from, to)` of the view as it stands at edit `base`. At the next step boundary the loop applies the result only if no view edit has committed since `base`; otherwise the result is stale, dropped, and its usage still recorded. The blocking path stays for overflow. A `Deferred` hands the result to the step, and the fiber is forked into the run's `Scope`, so a stop interrupts it.                                                                                                                                                              | The inline wait between turns in long conversations                                                                   | none beyond D2                                                        | no; D2 is                             |
| 5   | The SDK's extend half, `ExecutionEnv` and reattach | Defined under "The harness boundary". The extend half is a `Plugin` value of today's table shape, passed as a layer argument or contributed in a `Scope`. `ChildProcessSpawner` moves from the process layer to the run layer beside `WorkspaceFs`, so the run's file system and shell are one environment an embedder can replace together. `Session.resume(runId)` returns the same `Run` handle as `start`.                                                                                                                                                                                                                                                                 | The kernel's import of TeXRA's table (`sessionLayer.ts:1109` → `registry.ts:285`); the ambient spawner                | none                                                                  | no                                    |

**Considered and dropped.**

- **An effect class (read/write/external) replacing `replay`.** pi's rule is
  the same binary rule TeXRA has (`spec.md:2693`, `:2977-2984`). A class
  would derive `parallelSafe` and `replay` from one word, but it deletes
  neither stored field and adds a third vocabulary. The 2026-09-30 survey
  already refuted the "effects taxonomy". Keep both flags (D1).
- **A same-path edit queue.** It exists, and the merge makes it stronger
  than pi's. Nested script edits go through the same per-call program.
- **`defineDoc`.** `plugin.fact` is typed and versioned per plugin, with
  upcasters. The one missing rule is the fork rule (not copied, gap 3).
  Third-party plugins stay without durable state for 1.0 (storage design
  §6).
- **The live tree as a `FiberSet` per parent.** Children fork on the session
  `FiberSet` through the one launch door, by rule R2, so that a child never
  inherits its parent's context. Ownership is enforced durably (gap 1) and
  by the existing live cascade. Moving children into the parent's scope
  would break R2.
- **`completing` holds.** pi needs them because its parent tasks can commit
  an outcome while children run. In TeXRA the parent's result is the
  awaiting call's `tool.result`, which cannot commit before the child ends,
  so gap 1's fold check is all that is needed.
- **A second storage backend and a storage contract suite parameterised by
  backend.** TeXRA has one backend on purpose.
- **In-process hooks as Effect values.** Hooks stay the Claude Code
  protocol, recorded once. Typed extension points (tools, guards,
  continuations, prompt sections, layers, arms) cover in-process needs, and a
  second hook system would be a dual system.
- **A daemon for auto-continue.** D4 (2026-09-30) rules it out: the next
  process to open the session continues the run.

## The harness boundary

### Kernel, ports, extension points, app

| Part             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel           | `src/shared/session/`, the core arms of `src/shared/schemas/`, `src/agent/runtime/` (minus round mode), `src/agent/core/`, `src/agent/followUp/`, `src/agent/trace/`, `src/agent/prompt/`, `src/agent/storage/`, `src/controllers/session/`, `src/platform/`, `src/common/plugins/` (trust), the engine half of `src/tools/` (`liveRegistry`, `liveTools`, `toolTable`, `serverHolds`, `pluginLayers`, `pluginArms`, `catalogEntries`, `core/definition`, `approval/`), `src/agent/codeSandbox/` and `src/tools/codemode/` (codemode), `packages/llm` |
| Ports            | The codemode doc's table: Storage, Models, Settings, Execution env, Sandbox. This note narrows Execution env to one run-lifetime pair (`WorkspaceFs` + `ChildProcessSpawner`), and Settings to what a binding carries (the codemode doc's "later" item, done in H3)                                                                                                                                                                                                                                                                                   |
| Extension points | The `ToolTable` fields (`toolTable.ts:167`): tools, continuations, prompt contributions, process layers, session layers. Plus plugin arms (`plugin.fact`), agents and skills (directories as data), MCP servers, and hooks (out of process). Each is read in one place, through the step's snapshot                                                                                                                                                                                                                                                   |
| Harness plugins  | `file-ops`, `web`, `memory-workflow` (memory, todo, executions, accept_run_files), `goal`, `multi-agent` (contributing `agent`), `codemode`, `ask_user_question`; optional: `codex`, `claude-agent`, `github-pr-subscription`, `external-inquiry`                                                                                                                                                                                                                                                                                                 |
| App (TeXRA)      | `latex-extract`, `latex-diagnostics`, `arxiv`, `crossref`, `texcount`, `wolfram`, `zotero`, `lean4`; the TeXRA half of `core` (`inline_comment`, `open_pdf`, `lean_loogle`); `setup`; the **documents** plugin (`src/agent/output/`, round mode); `src/latex/`; the agent YAMLs and skills; the hosts. `copilot` belongs to the VS Code host                                                                                                                                                                                                          |

### Violations and fixes

The codemode doc names the first three. This note adds the rest.

1. **The agent core imports LaTeX.** There are runtime imports in
   `output/documentRounds.ts:51-52`, `output/LatexDiffManager.ts:6-8` and
   `output/compileCheck.ts:6-7`, all of which move with the documents
   plugin. There are type-only imports in `SessionHandle.ts:49`,
   `responseTextProcessing.ts:3` and `storage/runListing.ts:13`; the type
   moves to the plugin's arm, or the field becomes opaque JSON.
2. **`agent` names `extractFigures`/`extractTikz`.** These become options the
   documents plugin declares on the workflow agents it owns. They stay one
   group, for parity with lane 3.
3. **`ModelInvoker` reads a setting itself** (`ModelInvoker.ts:76`, `:933`).
   The value comes with the binding.
4. **Round mode is a category branch in the loop.** `toolUse.ts:74`, `:132-133`
   pick `roundsContinuation` when `agentCategory === Workflow`, and `rounds.ts`
   imports `makeDocumentRounds`. The fix: round policy becomes a
   contribution keyed by category, like `Continuation`
   (`toolTable.ts:130-142`). The documents plugin contributes it for
   `workflow`, and the loop reads it once at run open from the pinned
   generation. `rounds.ts` and `src/agent/output/` move to the app. The loop
   keeps its round hooks (`open`, `afterResponse`, `request`, `stage`) as the
   contribution's interface.
5. **The kernel binds TeXRA's table.** `sessionLayer.ts:1109` calls
   `toolRegistryLayer`, which closes over `TOOL_TABLE` (`registry.ts:285`).
   The fix: the table becomes a field of the platform the composition root
   passes in (`AgentPlatform`, `packages/agent/src/effect/runtime.ts:49`, and
   the hosts' `installProcessRuntime`). Each host passes TeXRA's table. The
   machinery (`toolTableLayer`) already takes any table.
6. **The prompt contribution type has a TeXRA field.** `PromptSection` takes
   `bibPath` (`toolTable.ts:155`). The plugin reads its own setting instead.
7. **The SDK's dependencies carry the app.** `packages/agent/package.json`
   lists `arxiv-client`, `@jamesgopsill/crossref-client`, `bibtex`,
   `@cantoo/pdf-lib` and other app dependencies. They move with the app
   plugins when the package splits.

A kernel/app ESLint zone, built like `VSCODE_FREE_ZONE_DIRS`, is added in
the PR that clears the last edge, not before. A rule with a baseline is a
ratchet on directories that are about to move.

### The extend half, as Effect values

The SDK can start and observe runs today, and can pass per-run tools
(`StartInput.tools`, `sessions.ts:51-56`; `defineTool`, `index.ts:75`). What
it lacks is a way to say what the harness is. The design reuses the table
shape that already exists and adds no loader:

```ts
// One plugin: the manifest row and its table entries as one value.
interface Plugin {
  readonly id: string;
  readonly revision: string;                       // 'builtin' or a content digest
  readonly tools?: ReadonlyMap<string, ITool>;     // defineTool(...)
  readonly continuation?: Continuation;
  readonly rounds?: RoundPolicy;                   // violation 4
  readonly prompt?: PromptContribution;
  readonly processLayer?: ProcessPluginLayer;      // Layer: its ports and services
  readonly sessionLayer?: SessionPluginLayer;
  readonly arms?: readonly PluginArm[];            // typed, versioned plugin.fact kinds
  readonly agents?: string; readonly skills?: string;  // directories, as data
}

Sessions.layer({ ...platform, plugins: [harnessPlugins, texraPlugins].flat() })
Plugins.contribute(plugin): Effect<void, RegistryConflict, Scope>  // live; withdrawn on scope close
Session.resume(runId): Effect<Run, LaunchError | RunFailure>      // the same handle as start
```

- **Define a tool.** Use `defineTool`, as today.
- **Contribute in a `Scope`.** `Plugins.contribute` is the existing
  `Registry.contribute` (`liveRegistry.ts:60-64`) for each of the plugin's
  maps, under one scope. Closing the scope unplugs the plugin. In-flight
  calls finish on the generation they were offered from, and its layers
  drain with the last pin. That is today's built-in switch path
  (`liveTools.ts:195-235`), exposed.
- **Hooks.** Hooks stay the out-of-process protocol, which a plugin ships as
  data (dropped above).
- **Plugin state.** Declared as `arms` and written as `plugin.fact` through
  the one publisher (storage design §6).
- **Provide ports.** Use `processLayer` and `sessionLayer` for a plugin's own
  services, and `AgentPlatform` for the harness ports.

This narrows the 2026-09-30 ruling that "`PluginModule` and `Plugin.load`
are not built" (core-concepts, "Decided 2026-09-30"). The named consumer is
TeXRA itself as an app on the harness. The value is first-party only: the
embedder owns the process. Third-party plugins stay data, MCP and hooks, and
no third-party code loads in process (ruling Q1).

### Round mode, the documents plugin, package names

Round mode and `src/agent/output/` become the app's `documents` plugin
(violation 4). Workflow agents are TeXRA's, and a harness without the
documents plugin has only tool-use agents.

Proposed names, still open (Q5):

- `@texra-ai/agent` is renamed `@texra-ai/harness`. Nothing is published,
  so the rename is free.
- `@texra-ai/llm` stays as it is.
- The app plugins move to `packages/theorist` (`@texra-ai/theorist`).
- The hosts stay where they are.

The physical move waits until violations 1–7 are cleared. Until then, the
boundary is the import graph.

## Conformance

The specification is the tests, not 4,600 lines of prose.

**What exists:**

- The golden 1.0 store, written by a real CLI E2E (`goldenStore.vitest.ts`;
  `golden-1.0.sql`; `packages/cli/scripts/generate-golden-store.mjs`). Every
  row decodes, the folds equal their pinned values, a parked run resumes
  with the recorded request byte for byte, and projections rebuilt from zero
  match the stored ones.
- The per-kind row-version freeze test (`rowVersions.vitest.ts:27-37`).
- The blocking, refusal and two-process suites (#13582).
- `stepBoundaryRatchet` and the #13364 tests for hot-plug.

**What is missing** is the durability contract itself: "a crash at any commit
point resumes to the same outcome, and no attempt is billed twice." One
`@effect/vitest` suite covers it:

- **Script.** A scripted model, the validation model the golden store
  already uses, drives one run that has a parallel tool batch, an approval,
  a retry permit, an awaited child, a fork and a compaction.
- **Crash points.** The suite enumerates the run's commit points from the
  ledger of a clean run. For each point N, it runs again with a
  `SessionEvents` layer that interrupts the process scope after commit N. It
  then reopens and resumes, answering requests from a script.
- **Assertions.** The final `RunState` equals the clean run's, modulo
  attempt ids. Each recorded attempt is billed once. No child run is left
  non-terminal or orphaned (gap 1).
- **Parameter.** The suite takes the plugin set as a `Layer`, so the app's
  plugins and an embedder's run the same contract. It does not take the
  storage backend as a parameter (dropped above).

The golden store gains rows for a fork, a view edit and an owned child, and
is regenerated once after H2. A `./testing` subpath export waits for a named
external consumer, the same rule as npm publication.

## Pre-freeze row decisions

| #   | Decision                               | Options                                                                                                     | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Effect class replacing `replay`        | (a) keep `replay` + `parallelSafe`; (b) `effect: read \| write \| external`                                 | **(a)**. pi is binary too; (b) deletes no stored field                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D2  | View edits                             | (a) add a `targets` range to `model.compaction`; (b) one kind, `context.edit`, replacing `model.compaction` | **(b)**: `{ cause: 'compaction' \| 'reset' \| 'handoff' \| 'fork', trigger, base: seq \| null, range: { from, to }, messages, usage }`, where `trigger` keeps the causes `model.compaction` records (`context-limit \| context-window \| model-switch`) plus `user` for `/compact`, null for the other causes (GUI review G-F1). `range` replaces `keepPrefix`, and `base` is the stale check (gap 4). It replaces a kind and adds none. Reset, handoff, fork, and later undo (#13546) need no further kind |
| D3  | `run.start.provenance`                 | (a) none; (b) a tagged union                                                                                | **(b)**: `provenance: { kind: 'fork', from: { id, uid }, at: seq } \| null` (not `origin`: the row envelope's `origin` is the writing process), where null means a fresh run. Resume is not an origin, since it is the same run. Later arms widen the union under the per-kind version rule. PRD #13354's origin and wake time are a deferred consumer and are not designed here                                                                                                                            |
| D4  | Ownership of an awaited child          | (a) derive it from the parent's ledger; (b) `run.start.parent.callId`                                       | **(b)**, nullable. The session view routes Resume without reading another aggregate's ledger                                                                                                                                                                                                                                                                                                                                                                                                                |
| D5  | Blocked reason                         | (a) a row; (b) the projection                                                                               | **(b)**. It is a fact about this build and its catalog, not about the run                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D6  | `run.start.checkpointId`, `workflow.*` | (unchanged)                                                                                                 | Deleted in codemode lane 7 (#13626)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

D2 is ruled (Q3); D3 follows from the fork ruling (Q4) and D4 from Q6.
D2–D4 are unreleased shape changes. Under the codemode doc's "the freeze
waits" ruling, they land in their version-1 shape with no upcaster.

## Lanes

Sequenced against the codemode lanes, of which 1–7 have merged.

| Lane | Work                                                                                                                                                                                                                                                 | Effort | Depends on                         | Freeze                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------- | --------------------- |
| H1   | Owned children: `parent.callId`; the derived id reattaches on resume; `agent` is replay-safe by id; Resume on an owned child resumes its parent; the fold refuses `run.end` over an open owned call; the orphan path is deleted                      | M      | none (codemode lane 3 merged)      | before                |
| H2   | Row shapes: `context.edit` replaces `model.compaction` (compaction writes the new shape, `range` replaces `keepPrefix`); `run.start.provenance` with the `fork` arm; regenerate the golden store                                                     | S      | none; must merge before the freeze | before                |
| H3   | The boundary: the table becomes a platform input (violation 5); round mode becomes a documents-plugin contribution (4); `@latex` edges leave `src/agent` (1); `bibPath` (6); the setting moves onto the binding (3); then the kernel/app ESLint zone | M–L    | none                               | no                    |
| H4   | SDK extend: the `Plugin` value, `Sessions.layer({ plugins })`, `Plugins.contribute` in a `Scope`, `Session.resume`; `ChildProcessSpawner` moves onto the run layer                                                                                   | M      | H3's table half                    | no                    |
| H5   | Fork, reset and handoff over `context.edit`; auto-continue on open with the host policy and blocked-until-installed; background compaction                                                                                                           | M      | H1, H2                             | no (shapes from H2)   |
| H6   | The crash-point conformance suite, parameterised by plugin `Layer`; golden-store rows for fork, view edit and owned child                                                                                                                            | S–M    | H1, H2 (the fork case after H5)    | the H1/H2 half before |

H2 and H1 are the lanes on the freeze's critical path, in that order: H2
lands the shapes, `run.start.parent.callId` included, and H1 enforces
ownership over them. Everything else follows the freeze.

## Owner rulings

Ruled by the owner on 2026-10-02 (PR #13612).

1. **First-party plugins as code: yes.** The 2026-09-30 `PluginModule`
   ruling is narrowed for first-party plugins. A `Plugin` value of today's
   table shape is passed to the harness or contributed in a `Scope`, with
   TeXRA as the named consumer. Third-party plugins stay data, MCP and
   hooks.
2. **Auto-continue defaults.** `off` for headless `texra run` and the SDK;
   `ask` for the TUI, desktop and the extension, as one prompt listing the
   interrupted runs; `auto` available as a setting.
3. **One `context.edit` kind replaces `model.compaction` (D2): yes.** It
   covers compaction, reset, handoff and the fork seed, and leaves room for
   undo.
4. **Fork only at a settled position: yes.** A cut anywhere else is refused,
   so a fork never contains a result nobody produced.
5. **Package names: open.** The proposal is `@texra-ai/harness` (renamed
   from `@texra-ai/agent`), `@texra-ai/llm` and `@texra-ai/theorist`, with
   the physical split after the freeze.
6. **Resuming an owned child goes through its parent (D4, gap 1): yes.** A
   user can no longer resume an awaited child on its own; a detached child
   keeps independent resume.

## Verified

- Started from `origin/main` at `f78a5501ff`. Read `liveRegistry.ts`, the
  `LiveTools` layer and `pinSwitched`, `toolTable.ts`, `registry.ts`
  (`PLUGIN_TOOLS`, `TOOL_TABLE`), the manifest, `packages/agent/src/{index,effect/sessions}.ts`
  and `package.json`, and `toolUse.ts`'s round branch.
- Re-read the evidence for the three code questions:
  `sessionFold.ts:568-591`, `approvedWrite.ts:36-46`,
  `workflowScriptAgentRunner.ts:415-425` and `run/tools.ts:136-146`. The
  other anchors come from two read-only sweeps over the same tree.
- Read pi-durable 1.0.0's spec (§§1, 3.6–3.7, 5.4–5.5, 6, 7.1, 8.7), its
  env and conformance sources, and the study's summary.
- Read the codemode doc (`943a69d7e2`), the core-concepts note, and the
  storage design §§6 and 11.
- Not run: any prototype, any live model, or the suites.
