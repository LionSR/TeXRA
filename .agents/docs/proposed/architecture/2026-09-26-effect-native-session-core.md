# Effect-native session core: moves after scope-owned lifetimes

Status: proposed

Origin: the owner asked, after #13340 (scope-owned lifetimes for runs,
sessions and shutdown), for a deep survey of what is core and what is a
plugin, which areas are leftovers from earlier generations, and how the
runtime, the session handle, the transcripts and the folds talk to each other,
before deciding what to make Effect-native and hot-pluggable. The owner also
said the SDK does not have to keep its synchronous design: an Effect-native
SDK is acceptable.

Pin: `main` at `3efffcc` (#13340). Thirteen read-only audits ran against that
commit: six area surveys (plugins and core, launch paths, the data plane,
process lifetimes, session handling, host transport), then seven
adversarial checks of the structural moves below. Each check was told to
refute its move against the code, the
[rulings ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md)
and `config/ratchets/refuted-candidates.json`. The claims marked _confirmed_
were re-read in the code by the author of this note.

A second survey then covered the areas the first did not reach: the model
layer, tools and approvals, follow-ups and wakes, workflow scripts and the
documents output, persistence and settings, agent definitions and accounts,
and the host shells. Its defects are listed under
[Defects from the second survey](#defects-from-the-second-survey) and its
structural findings became moves 8 to 13.

### Assumes #13359

The owner confirmed that #13359 ("retire seven dual systems and pass-through
layers") will be merged, so this programme treats it as landed. Where it
settles or shrinks a move:

- **Move 3, the child edge.** `ChildRunPort` is the one child-run handle
  contract, and `runLiveness.ts` is deleted, so the aggregate claim
  (`probeChild`, `claimStanding`) is the only liveness authority. The launch
  door builds on `ChildRunPort`, not on the old `ChildRun` or
  `registerChildRun` shapes.
- **Move 4, the process.**
  - The `getCliSecrets` singleton is deleted.
  - The extension serves `AgentDirectories` as a runtime layer.
  - `bootstrapHost` reads `host` and `secrets` from `SetupPlatform` and
    `Secrets`. It uses only `SetupPlatform.host` (`hostBootstrap.ts:77`), so
    move 4 reads the host from the core host identity instead. That keeps
    bootstrap independent of the optional Setup plugin.

  The module-slot inventory below is recounted on that basis.

- **Move 5, the wire.** The Tools and LaTeX settings pages have one shared
  body (`settingsToolCommands.ts`), so only the CLI still restates the
  plugin-toggle side effect.
- **Move 7, the trace.** `AgentTrace` keeps `emit` and its real producers; the
  six sugar emitters are gone, which leaves the dropped rename even less to do.
  PRs 1 to 3 are unchanged.
- **Move 8, the model.** `Model.generateTurn` is gone (one path,
  `completedTurn`). Subscription providers are data: one
  `SubscriptionOAuthError`, policies that carry the token endpoint, and one
  `subscriptionAccess.ts`. PR 9 builds on that data. Compaction and
  `helperModel` still bypass `ModelInvoker`, so PR 4 stands.
- **Move 13, output.** latexdiff has one `runDiff` entry, and the duplicate
  `mergeFiles`/`latexdiffFiles` host verbs are gone.
- **Decisions 7 and 8.** #13359 leaves "one approval-policy authority" and
  "CLI follow-ups to an interrupted run" for owner decisions. That is the
  evidence that no shared path exists yet.

Relation to the owners in [INDEX.md](../../INDEX.md): this note owns no topic.
Each move names the owning note it amends, and a move that lands updates that
owner rather than this note.

## The owner's review, and what it changed

The owner reviewed the note on the PR (three read-only passes against `main`:
a claim check, an architecture pass against reference harnesses and the
rulings, and an adversarial pass). The defect tables held. The rest of the
note now follows two standards from that review:

- **Everything that can be a plugin is one.** Plugins contribute typed entries
  to **fixed tables, one per seam**, keyed by plugin id and checked with
  `satisfies` against manifest flags, exactly like `PLUGIN_TOOLS`,
  `PLUGIN_LAYERS` and `PLUGIN_CONTINUATIONS` on `main`. No runtime hooks, no
  god-object per plugin. The log is the only truth and everything else is a
  fold. Runs pin their composition.
- **A move lands only where a PR deletes more than it adds.** Each move below
  now opens with its verdict after review, and its target and PR list are
  rewritten to match. The superseded first drafts are removed from the note;
  git history keeps them.

The review also corrected claims of the first draft. They are fixed in place,
and the corrections that change a move are repeated in its verdict.

## Thesis

Most of the redundancy in the session plane has one of five causes. There is
no single state that runtime decisions read. Plugin state and resources have
no owner of their own. Three run programs each own their own claim and
terminal. The process is a runtime plus about a dozen module slots. Each host
repeats decisions the core should make.

The first drafts of these moves were larger than the code supports. The
adversarial checks refuted five of their claims (listed under
[Withdrawn](#withdrawn)), and what remains below is the shape that survived.
Measured net deletions are modest, roughly 2k production lines across moves 1 to 7 of the
programme. The gain is ownership: one reader of state for runtime decisions,
typed plugin services at the lifetimes that already exist, one launch
surface, one process graph, one behaviour per user decision on every host,
and a trace whose stages, streams and cards close with their scope.

The second survey found the same five causes one ring further out: the model
binding, the approval policy, a run's input queue, the agent catalog, the
application state and the host windows each have more than one owner or an
owner outside any scope. Moves 8 to 13 apply the same rule to them.

Three boundaries hold across every move. They come from the owner's
[joint review](https://github.com/LionSR/TeXRA/pull/13360#issuecomment-5851137649)
of this note and the core-concepts note (#13360). That note is the target
vocabulary; this one is the bounded delivery plan, and its reviewed deferrals
stay explicit (no session kernel in move 1, no whole `ProcessLayer` in
move 4).

- **The durable run and a live activation have different contracts.** A run
  survives several activations. Its recorded definition, offered tools,
  inputs and decisions belong to the run. A fiber, a model binding and a
  composition resource hold belong to one activation, and each resume
  acquires them again. That needs no new service or class.
- **Each fact has one authority.**
  - Resumable execution facts live in the run history (the session's event
    table).
  - Application settings and the other accepted current-value families live
    in `CurrentValues` (move 12).
  - Transient observations such as streaming chunks live in the live trace.

  Each has its own consumers, so none is routed through another. Core owns
  approval policy, admission and the terminal commit. A host port may do
  fallible work whose result core needs before it commits (output
  publication, `openWorkflowOutput`), and core awaits it. Pure presentation
  subscribes afterwards (move 13).

- **Shutdown is one protocol, specified once in core.** Stop admission,
  drain accepted deliveries, settle runs, then release resources. It runs on
  explicit session close while the process continues, and on process
  disposal, and the drain is scoped to the thing closing. Process disposal
  drains the process-scoped plugin services, as `closeAll` does today
  (`sessionLayer.ts:1262`). Closing one session drains only the deliveries
  bound to that session. It never stops process polling that other open
  sessions still use: `PollingLifetime.drain` closes polling for good
  (`PollingSourceBase.ts:99-137`). Today there is one process-wide delivery
  `FiberSet`, so the per-session drain needs a new primitive first. Deliveries
  become one `FiberSet` per target session root, since one session can have
  several deliveries in flight and a `FiberMap` keeps one fiber per key. A
  session's close unbinds its subscriptions and awaits its own set, and the plugin
  entry's drain takes an optional session root for this. Until that
  primitive lands, closing one session leaves the process drain untouched,
  and admission to the closed session is refused. Hosts invoke it rather than repeating it (move 4). Plugin
  acquisition and release stay in their typed layers. For an SDK reader,
  closing its scope detaches the reader; the session's own ownership
  governs the run.

Each change that lands completes one ownership transfer and deletes the
competing mechanism in the same PR: one writer made exclusive, one run
activation isolated, or one shutdown path made scope-owned.

## Defects to fix first

These do not depend on any architectural decision. Each is one small PR.

| Defect                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop **Resume** on a halted workflow run turns it into a failed run _(confirmed)_        | `HostRunActions.resume` passes `{config, runId}` to the host's `runValidated` (`src/controllers/session/hostRunActions.ts:625-632`). The desktop always wraps it as `kind:'fresh'` (`packages/desktop/src/main/desktopAgentRun.ts:196`), so `runAgent` registers again, `loadRun` refuses with "already has ledger state" (`src/agent/runtime/loop/runProgram.ts:159-165`) and the lifecycle writes `run.end FAILED`. The defect is desktop-only: the extension maps the id to `kind:'resume'` (`extensionHostRequests.ts:215-222`) and resumes correctly. Its workflow resume still bypasses `resumeRun`, the route tool-use runs take, so it drops the persisted `modelCompatibilityKey` (`resumeRun.ts:260-266`) and refuses a run another process holds through the claim acquisition rather than `resumeRun`'s owned-elsewhere marking. | Send workflow runs through `AgentResume.tryResumeRun` too (tool-use runs already go there; `resumeRun` has the workflow branch). Then remove `runId` from `RunRequest`/`ValidatedRunRequest`, so `runValidated` is fresh-only on both hosts and the desktop's hard-coded `fresh` is correct by construction.                              |
| The SDK never runs `bootstrapHost` _(confirmed)_                                            | `packages/agent/src/effect/runtime.ts:228` calls `installProcessRuntime` directly. `bootstrapHost` (`src/controllers/hostBootstrap.ts:77-115`) installs the long-stream dispatcher, so embedders get undici's 300 s body timeout instead of 30 min and no proxy. The setting host defaults to `'vscode'` while the tool gate reads `undefined` and `PACKAGE_SETUP.host` throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Make `storageDir` explicit (today it defaults to the real `~/.texra`), derive the MCP config path from it, and give embedders the long-stream transport by default as a fetch bound to the model factories rather than a global dispatcher (`modelTransport: 'bound'`). The full fix is [move 4](#move-4-the-process-is-one-layer-graph). |
| `run.removed` bypasses the publisher _(confirmed; **fixed**: #13375)_                       | `Database.removeRun` appends it inside its own transaction (`src/controllers/session/Database.ts:1048`). The publisher's `run.removed` arm (`src/agent/runtime/SessionEvents.ts:183`) never fires, so its open-work and follow-up entries for removed runs are never pruned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Widen the publisher job to `(ops: { append; removeRun })` and route removal through `exclusive`. The dependent-closure transaction stays in SQL. The tracker's `run.removed` arm must prune every id in `row.runIds` (the whole closed dependent set), not only `row.aggregateId` as it does today (`SessionEvents.ts:183-187`).          |
| Tool cards opened by the Claude and Codex strategies are never swept on abort _(confirmed)_ | `toolLogRefs` in `src/tools/claudeAgent.ts:236` and Codex's item cards (`itemLogRefs`) have no finalizer; the Codex turn card is closed by an `ensuring` (`codex.ts:343`). `OpenWork` tracks stages, streams and workflow calls but not cards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Consume both SDKs' async iterators as Streams in a scope whose finalizer ends any open card (move 7, PR 1).                                                                                                                                                                                                                               |
| Seven dead imports in `SessionHandle.ts`, one of them from #13340 _(confirmed)_             | `AgentTrace`, `finalizeRun`, `interruptedWorkflowCall`, `RUN_OUTCOME`, `RunOutcome`, `toErrorMessage`, `heldSessions` each appear only on their import line. `no-unused-vars` is off (`eslint.config.mjs:615`). The dead import hid that `heldSessions` and `SessionOwner.held` are test-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Delete them. Consider re-enabling unused-import detection.                                                                                                                                                                                                                                                                                |
| Webview requests stay pending after close                                                   | `sessionTransport.ts:91,143-150,211-224`: the pending map is not keyed by session and `close`/`dispose` never settle it. Callers guard, so the effect is a leaked closure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Scope-owned `Deferred`s per session, interrupted on close (move 5, PR 1).                                                                                                                                                                                                                                                                 |

### Defects from the second survey

Also independent of any decision. _Confirmed_ items were re-read in the code
by the author of this note; the rest are traced by one audit and should get a
reproduction before their fix PR.

One security defect in this survey is reported to the owner separately and is
not described here.

Tools and approvals:

- **An approved edit can overwrite newer changes** _(confirmed)_. When the file
  changed while the approval waited and the three-way patch fails,
  `writeApprovedContent` writes the approved text over the newer file, with no
  log line and no word to the model (`src/tools/approval/toolEditApproval.ts:425-430`).
  Fix: refuse with a conflict error and write nothing.
- **Turning approve-all off clobbers other grants.**
  `setDelegatedWorkBypasses(runId, false)` writes an explicit `false`, which
  drops a bypass the user set, pins a child off its parent, and revokes a
  goal's command grant that the goal still believes it holds
  (`runApprovalQueue.ts:323-331`, `goalAutoApproval.ts:64`).
- **A goal's command grant is lost on resume** while the goal stays active: the
  goal row is durable, the grant lives only in a WeakMap
  (`AgentLaunchContext.ts:383-389`). **Settled:** #13376 restores a run's own
  grants on resume and, per the goal-mode ruling, leaves a goal's autonomous
  grant off until a human re-arms it (#13387).
- **Four tools declare `requiresApproval` but have no call-time gate**
  (`update_config`, `unset_api_key`, `invoke_command`,
  `install_vscode_extension`). The flag only filters what is offered, and only
  the CLI and the SDK set `approvalPromptsUnavailable`, so on the GUI hosts they
  run without a prompt (`agentToolResolution.ts:289`; the comment at
  `ToolTypes.ts:68` claims otherwise). The fix shape is move 9 PR 4; a
  stopgap guard is small.

Model layer:

- **Runs on the OpenAI WebSocket transport fail at about 55 minutes.** The
  socket invalidates itself at that age (`openaiResponsesWebSocket.ts:297,432`,
  _confirmed_), and automatic retries re-read the same dead binding; only a
  manual retry or a model switch rebinds (`ModelInvoker.ts:1152,1216,1239-1245`).
- **Compaction's summary call is billed but never priced, logged or gated**
  (`run/compaction.ts:259-295`).
- **The per-round usage-log row carries the run's cumulative response time**
  _(confirmed)_ (`UsageMonitor.ts:184-186`).
- **A failed rebind on a manual retry is downgraded to a warning** while the
  declined route is still committed, so the next attempt bills the route the
  user declined (`ModelInvoker.ts:1053-1068`).
- **Replaced model bindings live until the run ends**, WebSocket and ping
  fiber included (`modelSwitch.ts:47-54`, `ModelInvoker.ts:909-910`).

Follow-ups and waits:

- **Poll subscriptions outlive their run and their session.** Bindings are
  released only on a terminal release, and a failed delivery status is
  discarded with `Effect.asVoid` (`RunSubscriptionRegistry.ts:154-164,250-262`,
  `ToolUseFollowUp.ts:313-318`).
- **`/compact` on a round-mode run is dropped silently** _(confirmed)_: the
  registry answers `requested`, and the loop compacts only when
  `rounds === null` (`toolUse.ts:533-536`).
- **`executions wait` can miss the follow-up it waits for**: it subscribes to
  an occurrence after several yields instead of reading the pending set
  (`ExecutionsTool.ts:131-147`).
- **A crash between a native child's `waiting` batch and its delivery can lose
  the turn result** (inference; `toolUse.ts:694-715`, `childRunLoop.ts:603-608`).

Workflow scripts and documents:

- **Skip or retry on an interrupted `agent()` call reports success**: the
  in-flight entry is removed only on normal settlement
  (`runWorkflowScript.ts:630,658-660,750`).
- **A failed media extraction is logged at `debug`**, hidden by default,
  against the comment above it (`documentRounds.ts:247,261-266`).

Agent definitions and accounts:

- **The CLI ignores the custom agents directory** _(confirmed)_: it passes
  `customDirectoryStore: { get: () => Effect.succeed(undefined) }`
  (`cliProcessRuntime.ts:224`) while the extension stores the setting in the
  shared global state.
- **The built-in `creator` agent is broken off VS Code**: only the extension
  registers the agent and doc directories as external roots, so on desktop, the
  CLI and the SDK its path variables render as `''` (`frontend/setup.ts:33-90`,
  `userVars.ts:283-292`).
- **SDK embedders get no skills at all**, a second consequence of skipping
  `bootstrapHost` (`runtimeSkills.ts:48-52`).
- **A failed remote-agent fetch is recorded as success**, so it is never
  retried and a failed refresh wipes the agents that had loaded
  (`remoteAgentList.ts:87-94`, `agentRegistry.ts:189-200`).

Persistence:

- **Every format bump silently resets user settings.** It moves aside the
  global database with the session vocabulary, re-runs
  `seedDisabledToolDefaults`, tells users only about "session history" on the
  extension and the CLI, and says nothing on desktop (`storeFormat.ts:51`,
  `toolAvailability.ts:84-100`, `ui/copy/sessionStore.ts:10-15`).
- **Moved-aside copies accumulate unreported**, one full copy per format per
  root (`storeFormat.ts:54-88`). They may be a user's only copy of old settings
  and history, so the fix reports their location and size; it does not delete
  them (AGENTS.md: "leave old state untouched").

Hosts:

- **The desktop renderer can boot to a blank window** _(confirmed)_: its
  `localStorage` store calls `JSON.parse` unguarded at module load, before any
  error handler exists (`renderer/main.ts:145-160`).
- **`texra.refreshApiKeyStatus` is registered and never invoked**
  (`extension.ts:850-854`).

## The programme

| Move                                                                                     | Replaces                                                                                                                                                             | Effort | Rulings to amend                                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| [1. Session kernel](#move-1-a-session-kernel-beside-the-run-fold)                        | after review: the cold whole-session lineage fold, the unchecked `listingTypeOf`, `removeRun` outside the publisher, duplicated facts                                | S–M    | none                                                                                 |
| [2. Plugins as typed Layers](#move-2-plugins-are-typed-layers-at-the-existing-lifetimes) | plugin resources in `ProcessServices` and module WeakMaps; plugin schema arms in core modules; no SDK opt-out                                                        | L      | plugin note "no durable state", "prompt sections are core"; one-run-program line 366 |
| [3. One launch surface](#move-3-one-launch-surface)                                      | after review: two workflow resume routes and the `executeWorkflow` port, the terminal blocks outside `runWithLaunchGuard`                                            | M      | none                                                                                 |
| [4. Process Layer graph](#move-4-the-process-is-one-layer-graph)                         | after review: the SDK skipping `bootstrapHost`, host identity in three homes, `AppSignals` without a finalizer, detached process fibers, indistinguishable owner ids | M      | archived service-scope ledger D5; synchronous facades "one process is one host"      |
| [5. Wire realignment](#move-5-realign-the-wire-to-the-ratified-protocol)                 | host detours for decisions, per-host copies, Promise webview transport                                                                                               | M      | none (returns to PRD one-fold §8)                                                    |
| [6. Session surface split](#move-6-split-the-session-handle-by-audience)                 | after review: dead surface, two subscription doors, per-host session lookups for resume, the default-session machinery                                               | S–M    | none (respects `SCOPE-held-sessions-as-effects`)                                     |
| [7. Effect-native trace and SDK](#move-7-effect-native-trace-and-sdk)                    | after review: split stage ownership, unswept cards and streams, the SDK trace tap, approvals without an SDK surface                                                  | M      | none (the SDK-is-Effect ruling already requires it)                                  |
| [8. Model plane](#move-8-the-model-plane-stays-inside-the-invoker)                       | bindings retired only at run end, calls outside the invoker, a session-scoped retry gate, the global dispatcher, two error taxonomies                                | L      | the ModelCell ruling (its files are gone)                                            |
| [9. Approval plane](#move-9-one-approval-authority-per-session)                          | the policy decided in core for two request kinds and in the CLI for the rest, seven bypass writers, grants without owners, MCP calls approved as shell               | M–L    | the `defineTool` freeze amendment (guard kinds)                                      |
| [10. Run input and wakes](#move-10-a-runs-input-belongs-to-its-run-entry)                | the 729-line follow-up queue as a second in-process owner, 31 manual lease hand-offs, host resume ports for wakes, resume's cancellation predicates                  | L      | none                                                                                 |
| [11. Agent catalog](#move-11-the-agent-catalog-is-a-process-service-that-runs-pin)       | module-slot catalog with 22 defensive loads, two loaders for one format, an extension-only watcher, live re-reads on resume                                          | M–L    | the plugin note's agent-source line if definitions are pinned                        |
| [12. Application state](#move-12-one-application-state-plane)                            | the unlanded current-value decision, three homes for one setting, silent resets on every format bump                                                                 | L      | none (lands the accepted decision as written)                                        |
| [13. Hosts as scoped programs](#move-13-hosts-are-scoped-programs-that-react-to-facts)   | the 1,380-line desktop window closure with unawaited teardown, two static singletons, the CLI's root-run slot machine, output presentation inside runs               | L      | the one-run-program parity table (presentation)                                      |

Verdicts after the owner's review: move 1 shrinks to the lineage read, an
exhaustive `listingTypeOf` and the de-duplication cuts; move 2 is rewritten as
one table per seam; move 3 shrinks to routing workflow resume through the
tool-use path and consolidating terminals onto `runWithLaunchGuard`; move 4
shrinks to the SDK bootstrap, `AppSignals`, `forkScoped` and an owner-id nonce;
move 5 keeps PRs 1, 2, 6 and 7, reshaped; move 6 drops `SessionPlane`; move 7
drops the `RunTrace` rename. The owner's second review accepted moves 8 to 13
with two reshapes: move 8 stays inside `ModelInvoker`, and move 10's inbox is
not a context tag.

Dependencies: 1 before the tag half of 6. 4 before 7's `TexraAgent.layer`. 3 is
easier after 1 (lineage reads). 2, 5 and the first half of 7 are independent.
8's transport half lands with 4. 10 needs 3. 11 and 12 sit in 4's graph. 13's
CLI half needs 3; its desktop half is independent.

## Move 1: a session kernel beside the run fold

### Current state

One event table feeds three folds and one tracker, all sharing
`applyRunRow` (`src/shared/session/runRows.ts:171-289`):

- `foldRunState` (`runStateFold.ts:783`): strict, per run, the resume
  authority.
- `sessionFold.fold` (`sessionFold.ts:126`): the display fold. It contains an
  unnamed session kernel, `SessionIndexes` (`:277-296`: `listed`, `ended`,
  `byOwner`, `claims`, `rows`, `latest`, `local`, `head`).
- The publisher's `track` (`src/agent/runtime/SessionEvents.ts:167-224`) and
  `hydrateFollowUps` (`:360-384`): a third copy of open work and pending
  follow-ups, for aggregates this process claims.
- The transcript reducer is a sub-reducer of the display fold and is already a
  projection; export reuses it.

Runtime decisions read the display view: follow-up admission reads
`substate === RESUMING` (`runRegistry.ts:376-395`), `stopFolded` (`:447`),
`FollowUps.ts:201`, `childRunOutput.ts:45`, `SessionRequests.ts:218`,
`sweepLeftoverRuns.ts:16`, `waitCoordination.ts:29`,
`turnAttribution.ts:58`. Lineage is read twice with two answers:
`childRunOutput` reads the live view's `parentId`, while
`persistedParentRunId` (`runRecords.ts:105-117`) folds the whole session
listing cold on a fixed-id relaunch and on every resume, and `runAgent` reads it
twice there (`runAgent.ts:146,206`; also `resumeRun.ts:418`,
`executeAgent.ts:541`). Fresh launches never read it.

Of the lists that classify event types, about four are unchecked. The one that
matters is `listingTypeOf` (`sessionEvent.ts:643-692`, "Not compiler-enforced"),
which has an unchecked `default`. `LISTING_TYPES` and `inputTypes` are derived
from the schema, `SHARED_RUN_ROW_TYPES` is `satisfies`-checked, and
`IGNORED_ROW_TYPES` is a total `Record`. The fourteen SQL literals, the arms of
`track` and the chunk-drop list in `sessionLayer.ts:660-680` are the others.

### Verdict after review: shrink

Drop the `SessionKernel` service for now. There are 13 runtime view reads, all
O(1) lookups, and nothing here shows a wrong decision caused by the tolerant
view. The measurable win needs no kernel:

1. Replace `persistedParentRunId` with a single-run read and collapse
   `runAgent`'s double read. The read folds that run's `run.start` and any
   later `run.detach`, since lineage is `run.start.parent` severed by a detach
   (`runRecords.ts:100-116`). A child promoted to a root is never reattached
   on resume.
2. Make `listingTypeOf` exhaustive.
3. Land the de-duplication cuts (usage ×4, output ×3, `run.config` on every
   activation) now, on a plain format bump: 1.0 starts from a clean state, so a
   bump costs nothing.

If a kernel is ever justified, it lives inside `SessionEvents`, with the
publisher as its one writer and foreign rows arriving as jobs on the inbox;
never two writers. The `EVENT_TIER` record below is kept as the shape to use if
the unchecked lists grow; it is not scheduled.

### Target

- **Lineage from the run itself.** `persistedParentRunId` reads the run's own
  `run.start` aggregate instead of folding the whole session listing, and
  `runAgent` reads it once, not twice.
- **An exhaustive `listingTypeOf`**, so a new event type cannot fall through
  its `default`.
- **`removeRun` through the publisher** (the defect above), pruning every id in
  `run.removed.runIds`.
- **The de-duplication cuts** (usage ×4, output ×3, `run.config` on every
  activation) on one plain format bump.
- **No kernel service.** If one is ever justified by a PR that deletes more
  than it adds, it lives inside `SessionEvents`, with the publisher as its one
  writer and foreign rows arriving as jobs on the inbox; never two writers.

### PRs

1. The single-run lineage read; collapse the double read.
2. Exhaustive `listingTypeOf`.
3. `removeRun` through `exclusive`, pruning `runIds`. Done (#13375).
4. The de-duplication cuts on one format bump. Done (#13386).

### Rulings

- **Keep** the `SESSION_EVENT_FORMAT` bump ruling: PR 4 is the bump, and 1.0
  starts from a clean state.
- **Keep** `RT-corrupt-record-tag`: `decodeEvent` stays the one decode site.
- **Keep** the single-owner liveness note: the DB claim is the only liveness
  authority.

## Move 2: plugins are typed Layers at the existing lifetimes

**Status (re-checked 2026-09-28 against `4b521aa462`).** Mostly landed; the
text below is the plan as reviewed. On `main`: `PLUGIN_PROCESS_LAYERS`
(GitHub only, its drain a step of the shutdown protocol), `PLUGIN_SESSION_LAYERS`
(Codex and Claude registries; the WeakMaps are gone), `PLUGIN_PROMPT_SECTIONS`
(`memory-workflow`), `PLUGIN_CONTINUATIONS`, and `PLUGIN_EVENT_ARMS` as typed
`plugin.fact` arms (goal), with `GitHubSubscriptions`, `CodexThreads` and
`ClaudeAgentSessions` out of `ProcessServices` (`PluginServices`); the goal
grant is core approval state (#13420). `PACKAGE_SETUP` is deleted with this
note: `setup` defaults to `{}` and the package composes none. The plugin-note,
one-run-program and ledger amendments are recorded in the ledger entry
"Plugins own typed tables at their seams". Not moved, with the reasons in that
entry: `run.fact` todos and plan (core loop state, not one plugin's), inquiry
and workflow-checkpoint rows (core aggregate kinds), the `documents` fold slice
(PR 5's `RunView` half). Deferred: the SDK's plugin set
(`TexraProcessOptions.plugins`) waits on move 4, and PR 7 needs owner decisions.

### Current state

`PLUGIN_LAYERS` is empty by design and `PluginLayer` is `Layer<never>`
(`src/tools/registry.ts:191-195`). Resource-owning plugins sit in the
23-member `ProcessServices` union (`src/platform/processRuntime.ts:64-87`):
GitHub subscriptions, Lean, `InquiryRecords`, `SetupPlatform`. That is the
right lifetime (each has consumers outside any run) but the wrong owner. The
Claude/Codex session registries (`src/tools/agentCliSessionStores.ts:14`) and
goal grants (`src/tools/goal/goalAutoApproval.ts:25`) are session state held
in module WeakMaps. The SDK cannot opt out: `installProcessRuntime` always
merges `toolRegistryLayer`, and the package hand-builds a refusing
`SetupPlatform`.

About nine of ~50 session-event arms are plugin-owned (goal, inquiry,
workflow checkpoints, `run.fact` todos and plan), and `RunView` carries their
fields, so the plugin note's "plugins own no durable state" is already false
in the tree. "Plugin" names six different things: the tool-plugin table, CLI
installed Claude/Codex plugins, MCP servers, slash-command `pluginId`, model
provider plugins and skill sources.

The composition hash reads the availability probe's module cache and falls
back to `?? []` before the first probe (`src/tools/toolAvailability.ts:347`,
`agentToolResolution.ts:236-242`), so the same switches hash differently
before and after it: two runs with the same switches get different keys,
different offered toolsets and a different prompt-cache prefix, and a run
before the first probe is offered tools that are not installed. The CLI
practically never probes. It is not a resource leak today, because
`PLUGIN_LAYERS` is empty. VS Code LM tools bypass compositions.

Since #13387 a workflow run's rounds are chosen by its category for the
run's whole life, so the hidden, tool-less `documents` manifest entry and
`continuationPolicy.ts` are gone, and goal mode is the one continuation on the
Registry. What still leaks is `RunView` being discriminated on
`AgentCategory` (`sessionView.ts`).

### Target: one table per seam

There is no plugin object. Each seam has one fixed table, keyed by plugin id,
living in the layer that owns the seam, checked with `satisfies` against the
manifest flag that declares the contribution. That keeps "the manifest imports
no tool implementation" true, which dashboards and webviews rely on, and adds
no `@tools` to `@agent` edges.

| Table                    | Seam and owner                         | Contributors                                                                          |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `PLUGIN_TOOLS`           | tools (on the Registry, #13364)        | every tool plugin                                                                     |
| `PLUGIN_CONTINUATIONS`   | continuation (on the Registry, #13387) | `plan` (goal); rounds are chosen by category, not contributed                         |
| `PLUGIN_LAYERS`          | plugin resources (exists, empty)       | none yet: one `RcMap` entry per plugin, held by the generations that hold it (#13364) |
| `PLUGIN_PROCESS_LAYERS`  | process services                       | GitHub subscriptions only (Lean, `SetupPlatform` and `InquiryRecords` stay core)      |
| `PLUGIN_SESSION_LAYERS`  | the session entry                      | Codex and Claude handle registries (two real contributors of one shape)               |
| `PLUGIN_EVENT_ARMS`      | the one closed event schema            | goal, inquiry, workflow checkpoints, documents (`output.produced`)                    |
| `PLUGIN_PROMPT_SECTIONS` | prompt assembly                        | `memory-workflow`, only in the PR that moves its blocks out of `PromptBuilder.ts`     |

- **Process services get their own table.** `PLUGIN_LAYERS` is built in the
  plugin's own `RcMap` entry scope (`liveTools.ts`), shared by the Registry
  generations that hold the plugin, and its resources close with the last
  of them (#13364 deleted `Compositions`). GitHub subscriptions have
  consumers outside any run (settings, the session), so they go in
  `PLUGIN_PROCESS_LAYERS`. Three services that looked like candidates stay
  core and unconditional:
  - Lean's layer needs `HostPorts` in `R`, which `TexraProcess.layer`'s input
    channel does not carry, so it stays core as ruled on 09-23.
  - `SetupPlatform` is read by the shared availability probe
    (`toolProbes.ts:68-82`, `pluginAvailability.ts:101-112`) in every graph,
    so only the Setup plugin's tools are optional.
  - `InquiryRecords`, for the reasons below.

  `InquiryRecords` stays core and unconditional. The
  session graph reads it (`sessionLayer.ts:284`), core `SessionRequests`
  needs it to decide and record inquiry answers (`SessionRequests.ts:83-109`),
  and inquiry rows must stay decidable while the plugin is off. The process composes that table once,
  selected by its plugin set (`TexraProcessOptions.plugins`, move 4), and
  there is no second instance per run.

- **There is no driver table (decided 2026-09-27).** `PLUGIN_DRIVERS` and
  `DriverUnavailable` are dropped, and the native driver moves into core.
  A workflow-script, Codex or Claude child is a tool call of its plugin
  (`workflowScriptStrategy.ts`, `agentCliShared.ts`). Ctrl-C or a parent stop
  pauses such a child instead of cancelling it. On resume the model is told
  the child is paused at N of M calls, and calling the tool again replays the
  child's journal and skips finished calls, as Claude Code's Workflow tool
  does with `resumeFromRunId`. A child is never resumed on its own. If the
  child's plugin is disabled, its tool is unavailable at the step, the step
  records that, and a call settles as `tool_unavailable`. So "blocked, not
  failed" is the step's tool check and needs no driver-specific state. This
  also deletes `resumeRun`'s `@tools/delegation` import.
- **Documents keeps its output plugin, not a continuation.** Its workflow arm
  of `RunView` becomes the documents plugin's fold slice. The category selects
  round mode for the run's life (#13387).
- **Schema arms carry their tier and fold slice in the plugin module**, so a
  new stateful plugin touches one spread line in core. The union stays closed
  and composition-independent: rows always decode and fold whether or not the
  plugin is switched on. From 1.0, each row kind, a plugin-owned kind
  included, carries its own schema version and migrates lazily at the read
  boundary (decided 2026-09-27, below).
- **Prompt sections are `(ctx) => string` per plugin**, consulted only for
  plugins in the pinned composition. The first draft's
  `(plugins, ctx) => string[]` coupled plugins to each other.
- **The GitHub drain is a step of the shutdown protocol, not a hook.** The
  edge runs from `Sessions` to the plugin, not back. `Sessions` already
  consumes `GitHubSubscriptions` (`sessionLayer.ts:1262`), so a GitHub layer
  that also required `Sessions` would form a Layer cycle that neither side
  can acquire. The first draft of this bullet proposed exactly that edge.
  Because the plugin layer is provided into `Sessions`, Effect acquires it
  first and releases it last. The core shutdown protocol's "drain accepted
  deliveries" step (see the Thesis) therefore calls `drainDeliveries` on a
  service that is still alive, with no `beforeSessionsClose` hook and no drain
  layer. Today the hosts close sessions before they dispose the process
  runtime, so the same PR moves those callers onto that one protocol.
- **The drain is the plugin's typed contribution, so a core-only process has
  none.** Each `PLUGIN_PROCESS_LAYERS` entry is `{ layer, drain? }`, and the
  protocol runs the drains of the plugins the process selected. Today
  `Sessions` reads `GitHubSubscriptions` unconditionally (`sessionLayer.ts:1262`).
  So before GitHub leaves `ProcessServices`, its session-side uses (run and
  settings operations) must read it only through the selected entry. A
  core-only `TexraProcess.layer` then builds `Sessions` with no GitHub service
  and no drain. Until that lands, GitHub stays unconditional.
- **The goal-grant WeakMap is deleted, not moved.** It saves, mutates and
  restores a bypass value. The effective bypass is computed from the
  approval-policy rows and the goal rows instead, so the bad state cannot
  exist (this also answers the two grant defects above). Goal mode itself
  does not carry across a resume: it starts paused and runs on only after a
  human re-arms it, as in deepseek-harness. **Done in #13387:** a resumed
  root's first step pauses a goal that was active and revokes its grant, and
  approving a plan re-arms it. **Done in #13420:** `GoalGrants` and its
  session layer are gone. Core approval state holds a run's goal grant
  beside its human values (`SessionApprovals.setGoalGrant`, the snapshot's
  `goal`); a human write on a kind ends that kind's grant, ending the goal
  writes nothing back, and a step with no continuation ends the grant.
- **Installed plugins join the one model instead of being renamed away.** The
  owner has ruled that a plugin is one on/off unit with one install record,
  qualified names and a `plugin:<id>/<name>` agent source, and that no new
  formats are invented. An installed Claude Code or Codex plugin becomes a
  `LoadedPlugin` like `mcp:<name>`, whose revision is a digest of the files
  it actually contributes (trust, below);
  its `skills/`, `agents/`, `commands/` and `.mcp.json` become data-table
  entries; it is one plugin on the Registry, so one switch hides everything
  it contributes. That is a data plugin. The other third-party kind is a code
  plugin, which runs out of process behind the typed RPC boundary with
  granted capabilities. No third-party code loads in process (decided
  2026-09-27).
- **The offered surface is recorded per step (#13364).** Each step writes a
  `tools.offered` row before its model request when the offered set or the
  continuation changed: each tool's name, identity digest, `shown` digest,
  plugin id and plugin revision, and the continuation's plugin. That row, not
  `run.activate`, owns the record; `run.activate` carries only the category
  and remoteness. Work after a resume is attributed to the plugin revisions
  that ran it. On resume the existing rule stands, with an identity check:
  a resumed activation's first step offers only recorded tools whose
  identity still matches, and a call to a changed or missing tool settles as
  `tool_unavailable`. So a plugin disabled, replaced or unavailable since the
  run started narrows the resumed run instead of failing it. Exact
  historical replay of a plugin revision would need revision retention,
  trust and missing-resource rules, and is not proposed. Pinning the agent
  definition is decided separately (decision 10). A child records its own
  narrower offered set.
- **Still to record: the rendered system prompt.** The step's row records
  tools, not the prompt text. The target is a prompt digest on the same
  step record, with the content stored once, and a runtime check in
  `ModelInvoker` that what it sends matches the recorded digests; a mismatch
  is a typed defect, never a silent drift.
- **Replay safety is declared on the tool contract**, separately from
  `parallelSafe`: `parallelSafe` says a call may run beside others, and
  `replaySafe` says a call may run again after a crash. Resume re-executes
  only replay-safe calls whose result was not committed, and asks for the
  rest.
- **Presets are stored compositions.** Today's switches become the preset
  `default`, an agent YAML may name a preset, and the session records the
  preset id. A preset describes the user's selection; host availability is
  resolved when resources are acquired. A run's preset is bounded by the
  process's plugin set (`TexraProcessOptions.plugins`): process-scoped
  services are composed once at process start. A run whose preset names a
  process plugin the process did not compose fails to open with a typed
  `PluginNotComposed`, and nothing is dropped silently. Tools and the
  continuation switch at the next step (#13364, #13387). A preset stores
  switches, nothing else (decided 2026-09-27). The plugin note already
  promised this.
- **Trust is per content digest.** Trust is keyed on a restart-stable digest
  of the plugin's content: a changed digest is a new, untrusted revision. For
  an installed plugin it is a digest of the files TeXRA consumes (`skills/`,
  `agents/`, `commands/`, `.mcp.json`), read from the checkout at load. It is
  not the recorded commit. The installer records a commit and a writable path
  (`packages/cli/src/runtime/plugins.ts:183-190`) and rereads the path
  (`:342-346`), so an in-place edit under the same commit would otherwise keep
  the old trust. The `.mcp.json` part uses the keyed digest below, because it
  can carry secrets. **Landed in #13364:** an MCP server's revision is
  `sha256({spec, envHmac})`, where `envHmac` is an HMAC of its env values
  under a per-install random key. The key is created once (create-if-absent
  through `AppState.modify`), resolved once per process and never recorded.
  The same env records the same revision across restarts, an edited env
  records a change, and no env value can be read back or guessed offline from
  a row. A built-in plugin's revision is the constant `builtin`; each tool's
  identity covers its own schema, so rewording one tool does not change its
  siblings. That is the **config revision**, used only for tool identity and
  stale-call checks. It does not identify the executable a server runs.
- **The trust revision is separate (decided 2026-09-27).** Trust is keyed per
  plugin revision, and a code plugin's or a stdio MCP server's trust revision
  includes a content digest of what actually runs: the resolved executable or
  package files. A change to that content asks again, even when the config
  revision is unchanged. This also answers the deferred project
  `.texra/mcp.json` trust prompt.
- **Third-party code runs out of process (decided 2026-09-27).** A
  third-party code plugin runs in a worker or child process and speaks one
  typed Effect RPC schema; its capabilities are the `R` its RPC surface is
  granted. No third-party code loads in process; in-process loading is only
  for built-in plugins. The loader's security review covers the process
  boundary and the granted capability set. The core-concepts note holds the
  ruling under Trust.
- **Self-improvement goes through data.** An approval-gated tool in the
  `setup` plugin installs, enables, trusts and saves presets. A change to
  tools or the continuation takes effect at the next step and is recorded
  (#13364, #13387); enabling a process plugin takes effect at the next
  process start.

### Why not the alternatives

- A plugin object with seven optional slots forces one module to import tools,
  runtime policies, prompt code, layers and schema arms, breaks the
  manifest's no-implementation rule, and inverts dependency edges. Reference
  harnesses have no single plugin shape either (separate registries for tools,
  system prompt and model).
- A union built at composition time makes a store unreadable when a plugin is
  off (`decodeEvent` throws on an unknown arm, `Database.ts:229-233`), moves
  the format fingerprint with the plugin set, and loses `z.infer` totality.
- An untyped `plugin.fact` envelope needs a second decode site, against
  `RT-corrupt-record-tag`.

### Hot-plug semantics

Superseded by the owner's 2026-09-27 ruling and #13364: a change applies at
the next step boundary and is recorded as a `tools.offered` row, so only the
step where something changed pays a prompt-cache miss. A tool call is checked
against the identity (name, description-free schema, plugin id, plugin
revision) of the snapshot that offered it, which keeps SDK §8 ("hot
replacement must not advertise one implementation and execute another").
Plugin layers come up and go down by refcount, and a child may only narrow
its parent's step.

### Stays core

The native driver, which moves into core (decided 2026-09-27), the child-run
edge (`child.park`/`child.turn`, the session budget), and the approval
authority. UI renderers stay a static table
in `src/ui`, because webview frontends cannot import `@tools`.

### PRs

1. A deterministic availability input to the composition key; LM tools through
   a pin. First.
2. `PLUGIN_PROCESS_LAYERS` filled with GitHub (drained by the shutdown
   protocol, after its session-side reads go through the selected entry). The
   SDK passes its plugin set, and a real core `SetupPlatform` replaces
   `PACKAGE_SETUP`, whose `host` throws.
3. `PLUGIN_SESSION_LAYERS` for the Codex and Claude registries; the goal grant
   computed from rows, WeakMap deleted.
4. Dropped (2026-09-27): no `PLUGIN_DRIVERS`. Paused children replace it
   (in flight).
5. `PLUGIN_EVENT_ARMS` with tier and fold slice per module, gated on the
   format fingerprint staying byte-identical; the documents fold slice replaces
   the category discrimination in `RunView`.
6. `PLUGIN_PROMPT_SECTIONS` with the `memory-workflow` move.
7. Installed plugins as loaded data plugins; the prompt digest on the step
   record; presets; trust per trust revision; then the `setup` tool. Needs
   owner decisions.

### Rulings

- **Amend** the plugin note (`2026-09-24-plugin-architecture.md:211-236`):
  "Plugins own no durable state and no event channel" becomes "static in-tree
  plugins own arms, with tier and fold slice, in plugin modules of the one
  closed schema". "Prompt sections are core" becomes "a plugin in the pinned
  composition may contribute one section".
- **Keep** "no task kinds" in v1 as written: there is no driver table, and a
  plugin's child is a tool call (2026-09-27).
- **Amend** one-run-program line 366 for the continuation seam, which already
  moved to `PLUGIN_CONTINUATIONS`.
- **Keep** the run-pin ruling, the per-session `LayerMap` ruling (no new
  lifetime), the owner's installed-plugin ruling (one unit, one record, no new
  formats), and SDK §8 (every contribution point is a typed static table).

## Move 3: one launch surface

**Landed.** #13384 routes workflow resume through the one core path and
deletes the `executeWorkflow` ports. #13385 adds the one launch door
(`RunRegistry.launch`, forking on the session's context) and the one launch
terminal, `runWithLaunchGuard` in `runLaunchGuard.ts`, guarded by
`runLaunchDoorRatchet`. The text below is the plan as reviewed.

### Verdict after review: shrink

- Route workflow resume through the tool-use resume path now that one program
  remains. That deletes the dead category refusal and the `executeWorkflow`
  port on four hosts, and fixes the desktop Resume defect in the same PR.
- Consolidate terminals onto the existing `runWithLaunchGuard` rather than a
  new `RunSpec`, which would duplicate `RunAgentRequest` (`kind: 'fresh' |
'resume'`).
- Defer the `Run` handle to move 7, with a reconcile step: the SDK's `Run` has
  `view` and no `idle`.
- #13348 (open) moves the follow-up lease into `runToolUse`'s own scope, so
  each run claims its own queue. It is evidence for this move, and whatever
  lands here must not own that lease again.
- Real test churn is about 48 `runAgent` hits in 5 files; the first draft's
  158 counted the unrelated `WorkflowAgentRunner.runAgent` field.

### Current state

Native fresh, resumed and child runs already share `runWithLifecycle` →
`runToolUse`. Three wrappers each own a claim and a terminal: `runAgent`
(`runAgent.ts:177-311`), `resumeToolUse` with `resumeToolUseWithOwnedLease`
(`executeAgent.ts:527-666`), and `runWithLaunchGuard` plus the child-loop
tail (`childRunLoop.ts:715-762,1290-1320`). The resume builder skips
`ensureRunDirUnder`, description generation, the progress reveal and the
start hooks. Three hooks overlap: `onRunClaimed`, `onRunResolved`, `onRun`.
`onIdle` is dead on the fresh branch. The one-run-program note's PR 5 promised
workflow resume through `resumeToolUseFromResumeData`. #13336 landed the rest of
that PR (the reflection program, its family and phases, `continuationIndex`,
format 18) but not the resume widening, and `executeAgent.ts:567-573` still
refuses a non-tool-use resume _(confirmed)_.

There are twenty entry routes, fourteen of them starting at a host. `run.end`
has one writing function, `finalizeRun`, with eight callers: five inside a
run, three outside (ownerless stop, session close, CLI SIGINT drain).

### Target

- **Workflow resume through the tool-use resume path.**
  `resumeToolUseFromResumeData` accepts workflow runs, the category refusal at
  `executeAgent.ts:567-573` goes, and so does the `executeWorkflow` port on
  four hosts. The host's `openWorkflowOutput` stays a pre-terminal,
  verdict-bearing hook: the resume path takes it as a required argument for a
  host-launched root workflow run, and refuses such a resume without it once
  the run's
  category is loaded, so a finalization failure can never persist as success.
  Child workflow runs resumed by the native driver (`nativeSubagentStrategy`) take no
  host hook; their presentation comes from durable facts (move 13).
- **`runId` leaves `RunRequest`/`ValidatedRunRequest`**, so `runValidated` is
  fresh-only on every host and the desktop's hard-coded `fresh` is correct by
  construction (the desktop defect).
- **Terminals consolidate onto `runWithLaunchGuard`.** `runAgent`'s and
  `resumeToolUse`'s own claim-and-terminal blocks become calls to it. The
  floor stays one writing function (`finalizeRun`) with two callers: the run's
  own terminal and the ownerless stop or close past budget.
- **The resume launch context matches the fresh one** where it should
  (`ensureRunDirUnder`, the progress reveal, the start hooks). Description
  generation stays fresh-only: it is a helper-model call that appends another
  `run.description`, so repeating it on every resume would cost a model call
  and could replace the user's label.
- **The follow-up lease is not owned here.** #13348 moves it into
  `runToolUse`'s own scope; nothing in this move takes it back.
- **The child edge is `ChildRunPort`** (#13359). `runWithLaunchGuard` and the
  child-loop tail build on it, and liveness is read from the aggregate claim
  (`probeChild`, `claimStanding`) alone.
- There is no driver table (move 2, 2026-09-27). The `Run` handle is move 7's.

### PRs

1. Workflow resume through the tool-use path with the desktop fix; delete
   `executeWorkflow` and `runId` from `RunRequest`.
2. Delete the dead fresh `onIdle` branch; fix the `withInactiveRunStep` doc.
3. The resume launch context matches the fresh one, except the description.
4. Terminals onto `runWithLaunchGuard`, rebased after #13348.

Estimated net: about −250 production lines; test churn is about 48 `runAgent`
hits in 5 files.

## Move 4: the process is one Layer graph

### Verdict after review: shrink

- Keep: the SDK calling `bootstrapHost` with an explicit `storageDir` and
  `modelTransport`; `AppSignals` with a finalizer; process `forkDetach` calls
  becoming `forkScoped`.
- For "one graph per process", add an **owner-id nonce** so leases can tell
  graphs apart (the format bump is free). The nonce alone does not isolate the
  module slots `bootstrapHost` still writes (setting host, account probes,
  skill and plugin directories, dispatcher), so a second graph is refused until
  those are graph-owned; coexistence is allowed only then.
- The Lean process layer needs `HostPorts` in `R`, which the SDK layer's
  input channel does not carry, so Lean stays core, as ruled on 09-23.
- Measure the bare-run count before the CLI PR (`RT-install-cli-process-runtime`).
- `ProcessLayer` as a whole waits until a PR shows it deletes more than it
  adds.

### Re-check against main (2026-09-28)

Most of the shrunk move had already landed or does not pay.

- **Host identity is done.** It is `WorkspaceRoots.host` with an `sdk` member;
  `SetupPlatform.host`, `installedHost` in production, `initProcessSettingHost`
  and `processToolHost` no longer exist.
- **The SDK already has the bound transport** (`modelBinding` hands every model
  `longRunningModelFetch`) and runs the first-install seed itself. The rest of
  `bootstrapHost` is a global dispatcher an embedder must not set, account
  probes the SDK deliberately answers signed-out, and bundled skills it has no
  resources for. Routing the SDK through it would add three switches to save
  one call.
- **Process fibers**: the reprobe and the app-signal listeners are already
  `forkScoped`; the extension's welcome and the desktop's unopened-projects
  dialog were the startup-time `forkDetach` calls and moved onto the
  activation and process scopes. The watcher fibers are owned by their VS Code
  disposables and stay. Two desktop `forkDetach` calls remain on purpose, each
  started by one user action: the setup run in `desktopOnboardingIpc.ts`
  (it outlives the card action, and its run stops when the sessions close at
  shutdown) and the browser sign-in attempt in `desktopSupabaseAuth.ts`.
  Moving them onto `processScope` means threading that scope, which only the
  startup program holds, through both factories' options for a fiber the
  process exit ends anyway. The per-command `forkDetach` calls under
  `packages/extension/src/commands` and `frontend` are the same class.
- **`AppSignals` finalizer: not done.** The desktop and CLI secret stores emit
  inside `Effect.ensuring`, so they could take a hub from the context. The
  other emitters cannot: the VS Code callbacks and command handlers in
  `extension.ts` and the settings view, and the plain synchronous code in
  `src/tools` (`AcceptRunFilesTool`, `ApplyTeamTool`, `PollingSourceBase`,
  `RunSubscriptionRegistry`) and `desktopProgressFileActions.ts` hold no
  Effect context, and `emitAppSignal` stays synchronous for them. A service
  hub would sit beside the module reference for those callers, not replace
  it, and the hub holds nothing once its subscribers are interrupted.
- **Owner-id nonce: deferred.** The second-graph guard stays, so nothing
  consumes the nonce yet. Adding it now would also strand a disposed graph's
  leases as `alive` in a live process, where today the same id reclaims them.

### State at plan time (superseded where the re-check above says so)

Five composition roots install the process runtime (extension, desktop, CLI
`cliProcessRuntime.ts`, the SDK, and the test harness that 79 suites import).
`bootstrapHost` is a separate step the SDK skips. After #13359 deletes
`cliSecrets` and serves the extension's `AgentDirectories` as a layer, about
twelve Node-side module slots live outside the runtime: the `SessionOwner`,
the `AppSignals` hub (never shut down), the setting host
(`initProcessSettingHost`), two account probes, skill contributions, plugin
agent directories, the agent catalog, the `agentDirectories` watcher
singleton, rate limiters, external roots (two writers) and the CLI log
runtime. Process-lifetime `forkDetach` fibers outlive `runtime.dispose` (the
reprobe at `hostBootstrap.ts:112`, the extension's remote catalog and
welcome, and the watcher's `forkDetach` in `AgentDirectoryManager.ts`). Four
hand-registered shutdown chains repeat "close sessions first, runtime last".

### Target

The SDK gets the same bootstrap as the hosts, with explicit options instead of
ambient defaults:

```ts
export interface TexraProcessOptions {
  readonly agentsDir: string;
  // bundled skills and plugin agents (hostBootstrap.ts:101 reads
  // resourcesPath); the agent package ships only dist, so an embedder passes
  // the resources it has. Omitted: no bundled skills or plugin agents, with
  // one warn logged. Packaging them with the SDK waits on publication.
  readonly resourcesPath?: string;
  readonly projectDir?: string; // "project", per AGENTS.md terminology
  readonly storageDir: string; // required: no silent ~/.texra
  readonly mcpConfig?: string | false; // default: `mcp.json` under storageDir; false disables MCP
  readonly modelTransport?: 'bound' | 'process-global'; // default 'bound': the long-stream fetch, not global
  readonly diagnostics?: Layer.Layer<never>;
  // Which plugins the process composes: a preset id or an explicit set.
  // Default: core only, so an embedder opts in to GitHub and the plugin tools.
  readonly plugins?:
    { readonly preset: string } | { readonly ids: readonly PluginId[] };
  // The one approval authority for every session this process opens (move 7).
  readonly approvals?: ApprovalMode; // default 'denyAll'
}
export const TexraProcess: {
  // PlatformConflict: a second graph refused while the module slots are
  // still process-global (the existing SDK already types it, sessions.ts:144-149).
  layer(o: TexraProcessOptions): Layer.Layer<
    Sessions,
    // bootstrapHost seeds first-install state through StateStore
    // (seedDisabledToolDefaults, hostBootstrap.ts:108)
    | DatabaseOpenFailed
    | PlatformConflict
    | StateReadFailed
    | StateWriteFailed
    // an unknown preset id, or a stored preset naming an invalid composition
    | PresetInvalid
  >;
};
```

- **The SDK calls `bootstrapHost`** with these options, so it gets the
  long-stream transport (as a bound `fetch` unless `'process-global'`), the
  host identity, skills and plugin agent directories.
- **The host identity is data** on `SettingsStores`/`WorkspaceRoots`, not a
  slot or a tag. It is core and always present, and `bootstrapHost` reads the
  host from it rather than from `SetupPlatform.host`. `SettingHost` is today
  the closed union `vscode | cli | desktop` (`stateSettings.ts:106-107`), and
  an embedder is none of those. So it gains an `sdk` member with its own
  routing: setting slots under `storageDir`, no host-only setup steps. The SDK
  never masquerades as a product host. `SetupPlatform` stays a
  core service, because the availability probe reads it in every graph (move
  2). The optional part of Setup is its tools.
- **`AppSignals` is a service with a shutdown finalizer**, and process-lifetime
  `forkDetach` calls become `forkScoped` on the runtime's scope.
- **One shutdown protocol in core replaces the four hand-registered chains.**
  Stop admission, drain accepted deliveries, settle runs, then release
  resources, in that order. It is the finalizer of the session entry (explicit
  close while the process lives) and of the process scope (disposal). Hosts
  call it and no longer order "sessions first, runtime last" themselves.
- **The owner id gains a per-graph nonce**, so two graphs in one process are
  distinguishable by the lease; the durable-format change rides a free bump.
  Until the module slots `bootstrapHost` writes are graph-owned, the SDK still
  refuses a second graph, because two graphs with different roots would
  overwrite each other's setting host, probes, skills and dispatcher.
- **Stays process-global:** the fetch dispatcher for hosts
  (`'process-global'`), and a plain log writer before and after the runtime.
- **Not scheduled:** the full `ProcessLayer` graph and the slot-by-slot
  conversions, until a PR shows each deletes more than it adds. The one
  shutdown protocol is scheduled (PR 6), because move 2 PR 2 depends on it.

### PRs

1. The SDK: explicit `storageDir`, `bootstrapHost`, the bound transport, the
   plugin set and the approval mode.
2. Host identity as data; delete `installedHost`, `initProcessSettingHost`,
   `processToolHost`.
3. `AppSignals` as a service with a finalizer; process `forkDetach` becomes
   `forkScoped`.
4. The owner-id nonce, on a format bump; the second-graph guard stays until
   the slots it protects are graph-owned.
5. The CLI only after measuring its bare-run count
   (`RT-install-cli-process-runtime`).
6. The core shutdown protocol (stop admission, drain, settle, release) as
   the session-entry and process-scope finalizer. The four hand-registered
   host chains call it and are deleted. Move 2 PR 2, which makes GitHub
   optional and gives it a typed drain, lands after this PR, so the drain
   always has its caller.

### Rulings

- **Argue against** the archived service-scope ledger's D5 ("`SessionOwner`
  global onto a tag: `installedProcessRuntime()` must answer synchronously for
  `composeProcess`"). Its precondition is `composeProcess`'s synchronous join,
  which this move deletes with the SDK's join.
- **Argue against** synchronous facades' "one process is one host": it is
  false for the SDK today (three answers disagree). The fix adds no tag.
- **Record** that `RT-install-cli-process-runtime`'s precondition is stale
  (ten bare-run sites in nine files; citty actions go through
  `defineCliCommand`). This move does not contradict it:
  `ManagedRuntime.make` is synchronous.
- **Record** that `SCOPE-external-roots-standalone-service`'s "one writer" has
  drifted to two. Its conversion is still deferred.
- **Keep** "no temporary adapters": each slot is deleted in the PR that
  introduces its service.

## Move 5: realign the wire to the ratified protocol

### Verdict after review: keep PRs 1, 2, 6 and 7, reshaped

- Instead of new `run.compileFixer`, `draft.polish` and `run.setup` arms, one
  `run.new {agent, preset, inputs}`: those features are agents, and presets
  are data.
- The edited content travels in the `request.decide` payload instead of a
  `StagedEdits` port, so it lands in the log.
- PRs 4 and 5 are product decisions (4 and 5 below): the own-key retry stays
  pending as the durable request, and approve-all decides requests already
  pending, on every host, inside `SessionRequests`.
- On the RPC rejection: the ledger requires a ruling row for a sixth
  `unstable/*` family rather than banning it. The bundle-size and Effect
  Schema arguments still carry the rejection.

### Current state

The PRD one-fold §8 protocol (six messages, three each way) is in place, and
29 of 37 host requests go through one shared body. The rest has drifted:

- **Tool-edit approve and reject** go through a `host.request toolEdit`
  detour on the GUI hosts (`ToolEditRequestPanel.ts:62-81`) because approve
  carries the content the user edited in the diff view. The TUI decides
  directly.
- **Own-key retry** has two implementations with opposite semantics: with no
  key entered, the GUI leaves the retry pending
  (`ProgressApiKeyRetryController.ts:62-71`), and the TUI denies it
  (`subscribeApprovals.ts:162-220`).
- **"Approve all delegated"** cascades onto pending requests only in the TUI
  (`approvalQueue.ts:446-476`); `policy.set` only flips the flag.
- **`HostRunActions.sendFollowUp`** bypasses `SessionRequests`.
- About sixty lines of tool-edit wiring are copied between
  `ProgressViewProvider.ts` and `desktopAgentRun.ts`.
- **The webview request side is Promise-based.** `SessionFrames` holds
  mutable state, and the pending map leaks (above).
- **The desktop routes by heuristic.** Session and `desktop:*` messages share
  one IPC channel, told apart by `'kind' in m && !('command' in m)`.

### Target

- `RuntimeRequest` gains `run.resume`, one `run.new {agent, preset, inputs}`
  (the compile fixer, polish and setup are agents, and presets are data), and
  `media.store`.
- `request.decide` covers tool-edit approve and reject on every host, and
  carries the edited content in its payload, so the approved text lands in the
  log. There is no `StagedEdits` port.
- `policy.set` enabling approve-all also decides that run's pending requests
  of the kinds the bypass covers (`toolEdit`, `bash`, `proposal`, the keys of
  `BYPASS_OF_KIND` in `approvalDecision.ts:66-72`), on every host, inside
  `SessionRequests` (decision 5). Questions, inquiries, retries and plan
  approvals stay pending: they need an answer or carry their own credential
  semantics, which is the filter the TUI applies today
  (`approvalQueue.ts:457-477`). The policy change and its decisions commit in
  one `exclusive` publisher job, which reads the durable pending set inside
  the job rather than from the folded view. A request whose opening job
  committed just before is therefore decided too, and none opened after can
  miss the new policy.
- `HostRequest` shrinks from 37 to about 28 genuinely host-only arms, plus
  `storeApiKey` and the desktop file I/O that travels on `desktop:*` today
  (PRD 8.3 already names it a host request). After this move `desktop:*`
  carries only process resources such as terminals and the browser.
- `attachSessionHost(session, controller, extras): Effect<void, never, Scope>`
  builds the one `interactions.use()` record and drains `events.all` into the
  host controller.
- The webview transport keeps its pending requests as scope-owned
  `Deferred`s per session, consumes frames through one fiber, and holds
  `SessionFrames` state in a `SubscriptionRef`.
- The desktop gives the session protocol its own IPC channel.
- `launch` stays a host arm: `prepareSurfaceLaunch` needs host dialogs
  mid-way.

### Rejected here

- **An RPC library in this move.** `effect/unstable/rpc` requires Effect
  Schema: +231 KB minified, +71 KB gzipped per webview (measured). PRD §7.6
  rules out Effect Schema, a sixth `unstable/*` family would need its own
  ledger ruling row, and SDK §5 says "do not create an SDK command bus". The
  2026-09-27 ruling that out-of-process plugins speak a typed Effect RPC
  schema, the same wire the hosts use, reopens this: the PR that adds the
  plugin loader carries the ledger row, and moving the host wire onto it has
  to answer the webview bundle cost measured here.
- **Merging the settings protocol.** It would add a second dispatcher (ledger
  2026-09-22).
- **Changing NDJSON.** It is frozen by PRD decision 8.

### PRs

1. Transport lifetimes.
2. `attachSessionHost`.
3. Tool-edit decisions through `request.decide`, with the edited content in the
   payload.
4. Own-key retry: stays pending on every host (decision 4).
5. Approve-all decides pending requests on every host (decision 5).
6. `run.resume`, `run.new {agent, preset, inputs}` and `media.store`.
7. Desktop: file I/O moves off `desktop:*` onto `host.request`, and the
   session protocol gets its own IPC channel.

## Move 6: split the session handle by audience

### Verdict after review: hygiene and ownership only; no split

Each of the seven provision sites provides only `Runs`, so `SessionPlane`
would swap one provision for another. The open question is instead whether the
`Runs` tag is needed at all, since the run program already holds
`options.session`. Six members, not seven, are used only by `sessionLayer.ts`:
`decideRequest` is also used by `SessionRequests.ts`.

### Current state

`SessionHandle` has 52 public members: 17 synchronous values or objects, 11
synchronous functions, 22 Effect-returning, 2 Stream-bearing, 1 callback
registration. Six are used only by `sessionLayer.ts` (`closeDoors`,
`receiveFoldedEvent`, `folded`, `publishApprovalPolicy`, `openWork`,
`borrowRunClaim`); `decideRequest` is also used by `SessionRequests.ts`. About 22 are run-program plumbing, and
about 10 are what a host or the SDK needs. There are doubled doors
(`approvals` and `requests.approvals`; `setTranscriptSubscriptions` and raw
`subscriptions.set`, which bypasses the disposal guard) and fifteen host sites
of `SubscriptionRef.getUnsafe(session.view)`.

There are thirteen ways to acquire a session. The resume port is
process-scoped, so each host finds the session again in its own way (extension
`tryDefaultSession`, a desktop scan over every project, a CLI module
handler), and `hostRunActions.ts:628` holds the session yet asks the process
port.

### Target

No new type. The refuted candidate `SCOPE-held-sessions-as-effects` measured a
`Session` context tag at "+1 export and 0 deletions", and a `SessionPlane`
would swap one provision for another, since each of the seven sites
(`executeAgent.ts:500,680`, `resumeRun.ts:129,164`,
`SessionRequests.ts:110,132`, `registerLanguageModelTools.ts:116`) provides
only `Runs`. What remains:

- **Hygiene:** the dead imports; delete `heldSessions`/`SessionOwner.held`,
  `teardownDefaultSession`, `SessionHandleInit.interactions`,
  `FileLister.refresh` and `requests.approvals`; fix the finalizer-order
  comment at `sessionLayer.ts:594-600`.
- **One scoped subscription door** instead of `setTranscriptSubscriptions`
  beside raw `subscriptions.set`.
- **Session-bound resume:** `AgentResumePort` becomes per-session, which
  deletes the desktop scan and the extension's default lookup.
- **Default-session retirement:** `testDefaultSession` reads
  `owner.current(installedTestRoots.storage)` (one support file, not 351 call
  sites), and hosts hold the handle they opened.
- **Open question:** whether the `Runs` tag is needed at all, since the run
  program already holds `options.session`. A PR that removes it must show a
  net deletion.

`open` stays a borrow and `close` stays explicit, per #11893.

### PRs

1. Hygiene.
2. One scoped subscription door.
3. Session-bound resume.
4. Default-session retirement.

## Move 7: Effect-native trace and SDK

### Verdict after review: keep PRs 1–3, 5 and 6; drop PR 4

PRs 1–3 are real lifecycle leaks, and PRs 5–6 deliver the SDK's events and
approvals. PR 4, the `RunTrace` rename, is dropped: `TraceEmitter` is referenced
in five production files, and the rename deletes nothing but test fakes. The
SDK's scoped `start` and the `Run` reconcile from move 3 land here.

### Current state

There are 223 production trace call sites: 174 already inside Effect, 26 in
synchronous owned helpers, 23 reached from foreign callbacks (Claude, Codex,
workflow script). Delivery is already a queue (`SessionEvents.detach`) and
sinks are fixed at construction, so the delivery half of observability-plane
step 4 has landed. Lifecycles have not:

- **The root stage has two owners.** It is ended on failure in
  `AgentLaunchContext.ts:409-424` and on the verdict in `finalizeRunTerminal`.
- **The child session stage** is ended through `unwindSetup` or
  `childRun.finalize`. The trace closes through a `closeTrace` callback.
- **`ModelInvoker` streams** finalize only inside `finishAttempt`, so an
  external interrupt leaves them open.
- **Claude and Codex cards** have no sweep (above).

### Target

The run keeps its `TraceEmitter`. What changes is who ends what: stages,
streams and tool cards become scoped handles over the existing emitter, so
their scope closes them.

```ts
// helpers over the run's existing emitter, taken from `AgentRun`
export const Trace: {
  stage<A>(
    label: string,
    o: StageOptions & { outcome?: (a: A) => RunOutcome },
  ): <E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | AgentRun>;
  openStage(
    label: string,
    o?: StageOptions,
  ): Effect.Effect<StageHandle, never, AgentRun | Scope.Scope>;
  stream(
    kind: StreamKind,
    o?: StreamOptions,
  ): Effect.Effect<StreamHandle, never, AgentRun | Scope.Scope>;
  card(
    toolName: string,
    input: unknown,
  ): Effect.Effect<CardHandle, never, AgentRun | Scope.Scope>;
};
```

The root stage wraps the run body, so it ends before `finalizeRunTerminal`'s
settle; that removes its second owner. Foreign loops become Streams
(`Stream.fromAsyncIterable`) inside a scope that also aborts the SDK's
controller and ends any open card. `ModelInvoker`'s streams live in a
per-attempt scope.

For the SDK, the 2026-09-21 ruling already makes the root an Effect surface
with no Promise entry. The changes:

- `run.events` is the run's trace events, read from its `TraceEmitter`
  through a sink added at construction and ended by the run's exit: it fails with
  the run's `RunFailure` when the run fails, as the SDK's stream does today
  (`sessionPrograms.ts:263-265`), so it keeps the `Stream<AgentEvent,
RunFailure>` contract of the SDK's `Run`. The trace itself stays infallible,
  because a trace has no verdict of its own. The `onTraceEvent`
  tap and its `tapping` flag go.
- The handoff stays bounded. The subscription is taken at admission, so a
  reader that attaches late misses nothing, but until a reader attaches it
  fills a buffer capped at `TRACE_HANDOVER_EVENTS` (512 today,
  `sessionPrograms.ts:87`). Past the cap the trace detaches with the same
  warning as today, and a run nobody reads retains nothing once it settles.
  A caller that awaits only `run.result` therefore costs at most the cap.
- `start` returns `Effect<Run, LaunchError | RunFailure, Scope>`, where
  `LaunchError` gains `PluginNotComposed` (move 2) beside `AgentNotFound` and
  `ToolsRefused`, so the SDK can branch on it without reading an untyped
  cause. `start` keeps `RunFailure` as
  `session.start` does today (`sessionPrograms.ts:172`): a failed agent scan,
  launch schema or pre-admission run stays a typed `RunFailure`. The scope bounds only
  the caller's event subscription: closing it detaches that reader, and the
  run keeps going. The run fiber belongs to the session scope, and only
  `run.interrupt` or closing the session stops it. The core `Run` handle is
  reconciled with the SDK's (which has `view` and no `idle`) in this move.
- Approvals as data: `session.requests: Stream<PendingRequest>`, which
  first replays every request pending in the session's fold, then follows new
  ones, so a consumer forked after `start` cannot miss a request a fast run
  opened in the gap. Under `manual` that replay is what keeps a run from
  parking forever. A `toolEdit` request carries its preview (original and
  proposed content) on the SDK's `PendingRequest`, taken from the live
  `ToolEditApprovalRequest`. The durable permission row holds only path and
  line counts (`prompts.ts:29-36`). The live preview is held until the
  request settles, so a request opened before the consumer subscribed is
  replayed with its content. A pending `toolEdit` is decided `cancelled`
  only when its preview is provably gone: its run's claim is acquirable,
  because the owning activation died. A process that merely lacks the preview
  while another process holds the claim leaves the request pending for its
  owner. The cancellation is a recorded row, and nothing is replayed without
  its content.
- `session.decide(req, decision)`, and exactly one approval authority per
  session, chosen when the process is built (`TexraProcessOptions.approvals`,
  move 4): `denyAll` (the default, today's behaviour), `handler(f)`, or
  `manual`, which decides nothing on its own and leaves every request to the
  embedder's `decide` calls. Because the mode is an input to the layer that
  builds the sessions, a manual consumer cannot race an automatic denial.
  This closes Tier-1 manifest item §7.1.
- `TexraAgent.layer` and `NodePlatform.layer` replace the `AgentPlatform`
  record, closing manifest §7.4. Waits for move 4.

```ts
const program = Effect.gen(function* () {
  const session = yield* Sessions.open();
  const run = yield* session.start({
    agent: 'proofreader',
    instruction: 'Fix typos in main.tex',
  });
  yield* run.events.pipe(
    Stream.filter((e) => e.type === 'stream.chunk'),
    Stream.runForEach((e) => Effect.sync(() => process.stdout.write(e.text))),
    Effect.forkScoped,
  );
  yield* session.requests.pipe(
    Stream.filter((r) => r.runId === run.runId),
    Stream.runForEach((r) =>
      session.decide(r, { action: 'deny', reason: 'headless' }),
    ),
    Effect.forkScoped,
  );
  return yield* run.result;
}).pipe(Effect.scoped);
// built with TexraProcess.layer({ ..., approvals: 'manual' }): one authority, the loop above
```

### PRs

1. Foreign loops to Streams, with a card sweep.
2. Scoped stages (root, child session, workflow phases) over today's emitter.
3. `ModelInvoker` streams in a per-attempt scope.
4. ~~`RunTrace` replaces `TraceEmitter`~~: dropped after review (it deletes
   nothing but test fakes).
5. SDK events from the existing emitter: `run.events` reads the run's
   `TraceEmitter` through a sink added at construction, ended by the run's
   exit, with the bounded handoff above; the `onTraceEvent` tap goes.
6. Approvals stream, `decide`, the `Approvals` layer.
7. `TexraAgent.layer`, after move 4.

Estimated net: about −200 production lines plus four test fakes collapsed into
one layer. PRs 1–3 fix real lifecycle bugs before any API change.

## Move 8: the model plane stays inside the invoker

Moves 8 to 13 came from the second survey. The owner's second review accepted
their direction and reshaped two of them (this move, and move 10); each PR that
is not a defect fix still lands only if it deletes more than it adds.

### Current state

`bindModel` (`run/modelBinding.ts:987`) binds into the caller's scope; a switch
or retry binds into `run.scope`, so every retired binding (a WebSocket with its
30 s ping fiber, an editor model) lives until the run ends, against the ModelCell
ruling's "disposes the distinct handler it retires". Two call paths skip
`ModelInvoker`: compaction (`compaction.ts:208,261,279`) and the helper path
(`helperModel.ts`, three callers), so neither is gated or priced, and helpers
carry a third retry owner. `ModelRetryGate` is session-scoped while credential
limits are account-wide. The package emits a typed `ModelError`, but the runtime
reads three of its kinds and re-derives the rest from about 1.5k lines of cause
heuristics (`src/common/errors/sdkError/`). The llm factories accept an
injectable `fetch` that no production caller passes, so the global undici
dispatcher is the only transport, and the WebSocket ignores the proxy.
`LanguageModel` and `EditorModel` are two services for one editor bridge, with
two conventions for "absent". The CI validation model lives in production
routing and in a persisted enum.

### Target

No new service. `ModelInvoker` stays the one service that calls the
`packages/llm` `Model` (CLAUDE.md), and the goals land inside it and the
existing run binding:

- **Auxiliary calls through `ModelInvoker`.** Compaction and in-run helper
  calls take the same path as a turn, with a `purpose` field
  (`'turn' | 'compaction' | 'helper'`), so they are gated by the retry gate,
  priced, and recorded like any other call. That removes the two call paths
  that bypass the invoker today and the helpers' third retry owner.
- **Helpers with no run.** Draft polish runs before any run exists
  (`hostDraftRequests.ts:104-112`), and `invoke` requires `AgentRun` and a
  `RunCell`. So the invoker keeps a second operation, `helper`, that needs no
  run. It takes the same process-scoped retry gate and pricing. With no run
  ledger to append to, a runless call's priced usage goes only to the
  process usage log (`UsageMonitor`), as helper usage does today. It
  writes no session fact, and no synthetic run is invented.
- **Binding lifetime inside `run/modelBinding.ts`.** Each binding gets
  `Scope.fork(run.scope)`, and a swap closes the retired binding's scope.
- **WebSocket reacquisition.** A transport failure on a WebSocket origin
  rebinds through the same swap before the next automatic attempt.
- **One transport.** `ModelTransport` (move 4) supplies `fetch` and a proxy
  agent to every factory. Once every host uses the bound transport,
  `setGlobalDispatcher` and the `'process-global'` option go together; until
  then `'process-global'` keeps installing the global dispatcher.
- **The retry gate at process scope, keyed by wire route**, because the
  credential is its real owner.
- **Classification from `ModelError` first**, keeping `sdkError` only for
  provider evidence the package cannot know. This is the largest deletion,
  about 1.5k lines of cause heuristics.
- **`EditorModel` merges into `LanguageModel`**; the validation model becomes a
  CLI test Layer.

A new service is added only if a PR shows it deletes more than it adds.

### PRs

1. The usage-row and manual-rebind defects.
2. Per-binding scopes in `run/modelBinding.ts`, with the ModelCell ruling
   rewritten in the same PR.
3. WebSocket reacquisition through the swap.
4. Compaction and helper calls through `ModelInvoker` with a `purpose`: gated,
   priced and recorded (the usage field rides a format bump).
5. `ModelTransport` for every host; then delete `setGlobalDispatcher` and the
   `'process-global'` option in the same PR.
6. The retry gate moves to process scope, keyed by route.
7. `EditorModel` merged; validation model as a Layer.
8. Classify from `ModelError`.
9. Extend `MODEL_PROVIDER_PLUGINS` (`src/shared/constants/modelProviderPlugins.ts`)
   with the Node-side binding quirks, price tiers and detection (provider names
   appear in 14 to 23 files each), rather than starting a second table. It
   builds on the subscription-provider data #13359 lands (the policies and
   `subscriptionAccess.ts`), not the per-provider modules it deletes.

Estimated net: −300 to −800 lines, most of it from PR 8.

### Rulings

**Rewrite** the ModelCell ruling (#9547): the files it cites are deleted.
**Keep** `EFF-ADOPT-retry-gate-schedule` and `EFF-ADOPT-jitter-helper-stays`:
PR 6 moves the gate's lifetime, not its algorithm. **Argue** the process-scoped
gate against the lifetimes ruling's "no process-global lookup": it is a service
with a real process owner, the credential.

## Move 9: one approval authority per session

### Current state

Core applies the approval policy to shell commands and file edits
(`bashApproval.ts:81`, `toolEditApproval.ts:265`). Plan, proposal, retry and
question requests are opened unconditionally and get the policy only in the CLI
(`cli/runtime/approval/settleApprovals.ts:86-153`), so `yolo` and `never` mean
different things on the GUI hosts; the authority ratchet allowlists the CLI as
an evaluator. Bypasses are written from seven production sites across four
layers, grants have no owners (hence the two grant defects above), and MCP,
Codex, Claude and Wolfram calls are approved as `bash`. The policy is read at
enqueue and the bypass at dispatch. `SessionApprovals` is a synchronous
mutable island with a quadratic descendant walk.

### Target

```ts
class Approvals extends Context.Service<
  Approvals,
  {
    readonly state: SubscriptionRef.SubscriptionRef<ApprovalState>; // bypass by kind, parent edges, owned grants
    readonly decide: (
      runId: RunId,
      payload: PermissionPayload,
    ) => RequestDecision | 'present'; // pure: session and run state plus the payload, no ToolCall
    // Scoped: the grant lasts as long as its owner's scope (a host launch, a
    // plan approval), and closing the scope removes exactly this owner's grant.
    readonly grant: (
      owner: GrantOwner,
      runId: RunId,
      kinds: readonly BypassKind[],
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()('@texra/session/Approvals') {}
```

`decide` is a pure function of the approval state and the payload, evaluated
inside the same publisher job that appends `request.opened`, so the request and
its automatic decision commit atomically and every host only presents. Both
doors call it there: `openRequest`, and `ModelInvoker.manualRetry`, which
already appends its request and retry binding in one transaction and already
records its own automatic decision in it (`ModelInvoker.ts:985-1011`). A grant is
acquired in its owner's scope and released when that scope closes; the goal's
command grant is not held at all but computed from the goal and policy rows
(move 2), so it cannot outlive the goal; goal mode starts paused on resume
until re-armed (decision 14). `ToolGuard`
gains `confirm` and `external` kinds beside `bash`, `requiresApproval` goes
back to filtering only what is offered, and a `toolCall` request kind replaces
approving MCP calls as shell. `approval.policy` rows record only the
policy the user set. Scoped grants never enter a durable row: they live in
`ApprovalState` alone, so a crash that skips their finalizer leaves nothing
for recovery to restore, and the cold view never advertises a bypass core
would not honour. It lives
in the existing session entry (no new lifetime) and keeps `withPerKeyLane`.

### PRs

1. The approval defects above, plus reading the policy inside the lane.
2. The policy decided for every request kind at `openRequest`; delete the
   CLI's evaluators and narrow the ratchet. Needs decision 7.
3. Extend the ratchet to bypass writes; the host launch and the goal grant
   through `grant`.
4. One action × resource ruleset instead of one guard kind per tool family
   (#13360's comparison), with delegated children defaulting to `never`, and
   the `toolCall` request kind. Needs an owner ruling under the `defineTool`
   freeze amendment. A separate PR (`fix/approval-gates`, in progress) fixes
   the two approval security defects with the smallest change, and will say
   whether it pre-empts decision 9.
5. `ApprovalState` as a `SubscriptionRef` in the existing session entry.
6. Edited content in the `request.decide` payload (move 5's verdict), with
   each preview request's lifetime as a scope.

## Move 10: a run's input belongs to its run entry

### Current state

The rows decide a run's state; what the process holds decides only which
fiber is running it. Beside `RunRegistry`'s entry, the follow-up queue
(`ToolUseFollowUpQueueManager.ts`, 729 lines) keeps its own lease kinds
(flow, child, recovery), an adopted claim, pending releases and observer sets:
a second in-process owner of the same question, with 31 manual lease hand-offs
across 6 files. Wakes go through the host `AgentResume` port, which the SDK
and the non-chat CLI answer `false`, so an automatic wake there always fails.
Resume is wholly uninterruptible, so cancellation is a hand-polled predicate
at 33 sites in 10 files. The CLI keeps follow-ups typed after Ctrl-C in host
memory and auto-resumes; the GUI refuses the same input.

### Target

```ts
interface RunEntry {
  // existing fields…
  readonly inbox?: RunInbox; // exists iff the generation's fiber or activation does
}
// A plain value on the run's own entry, handed explicitly to the one program
// that owns the run. Not a Context.Service: a run never reads another run's
// input from context (#13348).
interface RunInbox {
  readonly take: Effect.Effect<FollowUpBatch | null>;
  readonly hasQueued: Effect.Effect<boolean>;
  readonly consume: (s: RunState, b: FollowUpBatch) => Effect.Effect<ConsumedFollowUps, Error>;
}

// on Runs
deliver(runId: RunId, items: readonly FollowUpQueueInput[], o: { wake: 'auto' | 'deferred' }):
  Effect.Effect<Delivery, RunAdmissionClosed | HeldElsewhere | DatabaseWriteFailed>; // WakeToken when deferred
wake(token: WakeToken): Effect.Effect<void, DatabaseWriteFailed>; // appends followup.released for that delivery
```

The inbox is deliberately not a context tag. A run that read its input from
context is how a workflow child cancelled its parent: `runToolUse` read
`FollowUps` with `Effect.serviceOption`, a workflow child inherited its
parent's `FollowUps` from the delegating fiber, and the child's `settleRun`
released the parent's lease. #13348 removes that tag, so each conversation run
claims its own queue in its own scope (`claimFollowUps(run, ledger)`); this move
builds on that.

`deliver` appends `followup.queued` through the publisher. Under `'auto'`,
`Runs` chooses the wake inside the run's lane, atomically with the append: a
live entry is notified, and a resumable one is woken by the session-bound
resume (move 6), which launches through the path move 3 selects
(`runWithLaunchGuard`), forked into the session scope, with no host port. A
root workflow run is the exception: its resume needs the host's
`openWorkflowOutput` (move 3). Only a host-launched root needs it. Whether
the run was launched with a host hook is a birth fact: a `hostHooked` field on
`run.start`, committed in `commitRegistration`'s batch
(`SessionHandle.ts:862`). It does not go on a snapshot, because resume reads
only the latest snapshot and the loop replaces it at every turn and wait. A root
launched through the SDK has none, presents from facts, and resumes without
one, so an embedder's workflow input is woken like any other. For a
host-launched root, the automatic wake takes the hook from the session's
attached host (`attachSessionHost`, move 5), and with no host
attached it leaves the run pending. `attachSessionHost` then runs the
pending-input scan again for the runs that were waiting on a host. Recovery
after a restart runs while the session is still opening, before any host can
attach, so without that second scan crash-recovered workflow input would need
a manual resume. The row stays durable either way, so nothing is stranded or
finalized without its output. The caller never chooses, so a run that turns live or idle while the
delivery is prepared cannot leave the row unwoken. The in-memory wake cannot
commit with the append, so a crash between them is recovered from the log:
pending input is a fold (queued, minus consumed, minus deferred and not
released). When a session opens, it wakes each resumable run that has
pending input and no live claim, through the same session-bound resume. The
same scan runs again on two later events. One is a foreign `followup.queued`
or `followup.released` row arriving through the session's tail. The other is
a claim held by another process becoming acquirable. Claim liveness is
probed, not timed (`leaseOwnerLiveness.ts` compares nothing to a clock), so
no event marks a foreign owner's death. While pending input is blocked by a
foreign claim, the session keeps a retry scheduled: an `Effect.repeat` on an
exponential, capped `Schedule`, forked into the session scope. It probes the
claim and wakes the run once the claim is acquirable, and it stops when the
input is consumed or the session closes. The probe proves death only for an
owner on the same host: `proveOwnerLiveness` answers `unprovable` for another
hostname (`leaseOwnerLiveness.ts:44-49`). A project database shared across
machines therefore needs a cross-host takeover policy, listed under
[Open for the implementing PR](#open-for-the-implementing-pr).
So input that another process queued before it crashed does not wait on a
session that was already open. User, GitHub and released child input
therefore never waits for a manual resume. `'deferred'` admits the row
durably, wakes nobody, and stays invisible to consumption until `wake`: the
run entry holds its delivery ids in a deferred set that `take` skips, as the
manager's `deferred` set does today (`ToolUseFollowUpQueueManager.ts:53-58,287`),
so an unrelated resume of the parent cannot consume the child's row before the
child finalizes. The deferral is durable, not inferred: `followup.queued`
gains a `deferred` flag, and the release is a `followup.released
{followUpIds}` row on the producing child's own aggregate (one format bump).
A child's aggregate is not collected while its parent still holds an
unconsumed follow-up that child produced. Collection deletes an aggregate's
events, the release included, which would leave the parent's row deferred
forever. Removing the parent removes both together, as the removal closure
already does. Removing the child alone, while such a delivery is still
unreleased (the child crashed before settling it), is refused with a typed
`RunHasPendingDelivery`. The user resumes the child, which releases it, or
removes the parent. Its listing key includes the release's delivery id, so a child that
releases several turns keeps every release row after a restart. The cold
listing otherwise keeps only the latest row per aggregate and type.
The child owns that aggregate, so the release never needs the parent's
claim. `Database.appendAll` refuses any aggregate another owner holds, and
the parent may be claimed elsewhere when the child settles. The parent's
pending-input fold reads the whole session, so it sees the release all the
same. Today neither `followup.queued` (`sessionEvent.ts:375-378`)
nor `child.turn` (`sessionEvent.ts:460-464`) records the mode, so after a
crash a non-finalizing child turn and a finalizing result look alike. With
the flag, hydration rebuilds the deferred set as "deferred and not released",
and nothing reads `run.end` to guess. No crash window is left between the
child's end and its release. A finalizing delivery (the child's last turn)
is released only in the same publisher job as the child's `run.end`, never
with `child.turn` `settled`: `deliverTurn` commits `settled` before the child
finalizes (`childRunLoop.ts:631-637`), and waking the parent there is the
#8093 self-stall that `childRunLoop.ts:482-489` warns about. A
non-finalizing delivery, where the child continues to another turn, is
released with its `settled` row. A child that crashes before that job leaves
no terminal row either, so its resume performs the release. A native child uses it for its turn result, and never calls `wake` as a
separate step. It hands its delivery's `WakeToken` to the job that settles
the delivery. For a non-finalizing turn that is the `child.turn` `settled`
job, and for its last turn the `run.end` job. So a crash between settling
and releasing is impossible. That job reads the durable parent edge first. If
`run.detach` has severed it, the job settles the delivery as unanswered,
with the reason "parent detached" (move 10's settlement), instead of
releasing it. A stopped parent is then never resumed by a child it detached,
matching today's recheck in `submitPendingDelivery`
(`childRunLoop.ts:654-665`). `wake(token)` stays for a producer with no
settling row of its own. Either way a
parent with several deferred children releases only that child's rows, as `deliverTurn` and
`submitPendingDelivery` do today (`childRunLoop.ts:601-607,654`): the durable
row survives a crash, and the parent never sees the child as still running
when it wakes (#8093). Resume becomes interruptible
with `acquireRelease` on its recovery lease; when PR 5 deletes that lease, the
same `acquireRelease` moves to the resume's run claim (`holdRunClaim`), so an
interrupted resume still releases what it acquired. The inbox is keyed on the fiber,
not the claim (liveness note §2.5).

### PRs

1. The follow-up defects above, and the stale "wait node" wording.
2. Re-offer an unsettled native-child turn on resume.
3. Interruptible resume; delete the cancellation predicates (after move 3 PR 3).
4. The inbox in the generation's scope; delete the flow and child lease kinds.
5. `Runs.deliver` and core wakes; move the resume's scoped release onto its
   run claim, then delete the recovery lease, the adopted claim and the wake
   half of `AgentResume` (after move 3 PR 4 and move 6 PR 3).
6. After decision 8: follow-ups to a stopped run admitted in core; delete the
   CLI buffer. Admission gets the shape all three reference harnesses share
   (#13360):
   - steer and queue lanes: a steer reaches the running turn, a queued input
     waits for the next;
   - settlement: every input ends answered, or unanswered with a recorded
     reason, and can be withdrawn while unsettled;
   - idempotent admission by caller id, so a retried delivery never
     duplicates.

   This gives decision 8 its shape.

7. `onRelease` and `onSent` become scoped subscriptions over the publisher's
   pending follow-up state, which move 1 keeps.

Estimated: the manager drops to about 300 lines (inference).

## Move 11: the agent catalog is a process service that runs pin

### Current state

The catalog is a set of module variables (`agentRegistry.ts:63-90`) with
synchronous readers at 19 sites and 22 defensive `loadAgents` calls.
Invalidation is ad hoc per host, and only the extension watches the agent
directories, although the published docs promise live rescan
(`custom-agents.md:244`). The scanner validates a partial schema and does its
own inheritance, the launch loader re-reads and re-resolves the YAML, and a
third parse serves the creator wizard, so an agent can appear in the dropdown
and fail at launch. Resume re-reads the definition live while the composition
is pinned. `AgentDirectories` is built three ways; #13359 makes the extension
serve it as a runtime layer, as the desktop already does.

### Target

The catalog is a fixed, ordered table of sources, not a service wrapped around
today's module state:

```ts
// ordered by lookup priority: on a name clash the earlier source wins, as
// LOOKUP_PRIORITY does today (agentRegistry.ts:50-55): the user's agent
// shadows a bundled one, and bundled outranks remote
const AGENT_SOURCES = [
  userAgents, // the custom directory, from AgentDirectories
  bundledAgents, // BundledResources
  remoteAgents, // signed-in only; carries a RemoteStatus
  installedPluginAgents, // `plugin:<id>/<name>` from installed plugins (move 2)
] as const satisfies readonly AgentSource[];

interface AgentSource {
  readonly id: string;
  // a pure function of the source's last read
  readonly read: Effect.Effect<SourceRead, AgentSourceError>;
}
// the catalog is rebuilt from empty on every refresh
declare const buildCatalog: (reads: readonly SourceRead[]) => Catalog;
```

- **Rebuilt from empty, latest wins.** Each refresh folds the sources' reads
  into a fresh catalog. Refreshes run through one `FiberHandle` in the
  catalog's scope, and a new refresh interrupts the in-flight one before it
  can publish. That replaces the epoch check (`agentRegistry.ts:76-90,185`)
  with interruption, so a stale read from a watcher, auth change or remote
  retry cannot publish over a newer one. It also deletes the carry-over and
  "re-remove" special cases rather than wrapping them in a service.
- **A remote status.** The remote source records `NotLoaded`, `SignedOut`,
  `Loaded` or `Failed`, so a failed fetch keeps the previous rows instead of
  being recorded as success. A `Failed` source is retried by its own
  `Effect.retry` on an exponential `Schedule` while the user stays signed in,
  forked into the catalog's scope. It needs no auth transition and none of
  the 22 defensive loads, which PR 4 deletes, so the retry lands with or
  before that deletion.
- **One validating loader.** The scanner produces the fully resolved
  definition (setting and prompt, with inheritance) or an issue; the launch
  loader reads it from the catalog.
- **A watcher on every host.** A `DirectoryWatch` host port (VS Code watcher,
  or `FileSystem.watch`) triggers a refresh.
- **Refresh reaches runs only at run open.** Runs record the full resolved
  definition (setting and prompt, with its digest) once, in a dedicated
  run-level `run.definition` row, and resume reads it next to the latest
  snapshot. That row is committed in the same `commitRegistration` batch as
  `run.start` (`SessionHandle.ts:862`), so no crash can leave a run that
  exists without its pinned definition. It does not go on `run.snapshot`: resume reads only the latest
  snapshot (`AgentRun.ts:263`), and the loop replaces that at every turn and
  wait (`toolUse.ts:405,695`). A pin there would be lost or copied into
  every checkpoint. The definition is materialized before it is recorded.
  The instruction files an agent names through `requiredFilesInternal` are
  read relative to the agent's path on every activation today
  (`userVars.ts:114`). Their contents and digests go into `run.definition`,
  so moving, deleting or editing them cannot change a pinned run. Resume then
  runs from the recorded definition, so an edit between a halt and its resume changes neither the
  settings nor the instructions.
- Post-auth invalidation stays per host, as ruled.

### PRs

1. The agent defects above.
2. Remote status in the existing state, with the scheduled retry of a
   `Failed` source; no API change.
3. One validating loader; delete the launch loader's inheritance walk.
4. The ordered source table, rebuilt from empty; delete the epoch,
   carry-over and re-remove cases, the 22 defensive loads, the extension's
   manager and the plugin-directory slot; watchers on every host.
5. Pin the definition in one `run.definition` row. Needs decision 10.
6. Retire the creator wizard in favour of the cross-host `creator` agent.
   Needs decision 11.

## Move 12: one application-state plane

### Current state

The accepted current-value decision (2026-09-22) has landed no code: there
are zero hits for `current_value`, the `state.value.set` arm and
`borrowsClaim` remain, and eight format bumps since then did not carry it.
Project app-state writes therefore still append to the session's own event
table through `Database.appendAll`, outside the publisher
(`appStateStore.ts:56-62`), and every session-vocabulary bump resets global
settings (the defect above). One catalog row can have three homes: the ten
`WORKTREE_SHARED_KEYS` go to the global database on the extension, the
Electron profile database on desktop, and the project database on the CLI; the
26 `globalState` rows split desktop from the other hosts. The global databases
run a 250 ms poll nobody reads, and the desktop project lists write two rows
non-atomically. There are 21 raw `get<T>` casts of persisted state.

### Target

```ts
// deletion is for app-state and presentation only (the current-value
// decision, amended by move 13). Two overloads, not a
// conditional type: a conditional distributes over a `Family` union and would
// admit undefined for a retained family. A caller holding a bare `Family`
// matches neither overload and must narrow first.
type DeletableFamily = 'app-state' | 'presentation';
type RetainedFamily = Exclude<Family, DeletableFamily>;
export class CurrentValues extends Context.Service<
  CurrentValues,
  {
    get<F extends Family>(
      f: F,
      key: string,
    ): Effect.Effect<Value<F> | undefined, DatabaseReadFailed>;
    // one BEGIN IMMEDIATE each; a malformed row rolls back
    modify<F extends DeletableFamily, A>(
      f: F,
      key: string,
      change: (v: Value<F> | undefined) => readonly [A, Value<F> | undefined],
    ): Effect.Effect<A, DatabaseReadFailed | DatabaseWriteFailed>;
    modify<F extends RetainedFamily, A>(
      f: F,
      key: string,
      change: (v: Value<F> | undefined) => readonly [A, Value<F>],
    ): Effect.Effect<A, DatabaseReadFailed | DatabaseWriteFailed>;
    // every live row of a family, latest write first (inquiry listing,
    // inquiryRecords.ts:241-265, keeps the decision's revision order)
    list<F extends Family>(
      f: F,
    ): Effect.Effect<
      readonly { key: string; value: Value<F> }[],
      DatabaseReadFailed
    >;
    readonly movedAside: StoreMovedAside | null; // reported by every host
  }
>()('@texra/session/CurrentValues') {}
```

The table follows the accepted decision as written: a format mismatch clears
the whole schema, current values included (the owner's review dropped the
first draft's separate stamp, since 1.0 starts clean). The silent part of that
reset is fixed by reporting it (PR 1). `SettingSlots` gains a `repoState` slot, so the catalog is the only router of a
key on every host. One global root for `AppState`.

### PRs

1. Every host reports every moved-aside store, with its location and size,
   and names settings. Nothing is deleted.
2. One write for the desktop lists; no poll on the global databases.
3. `CurrentValues` on its own format bump, taken now rather than waiting for
   another (eight bumps have gone by without it; 1.0 starts clean); retire
   `state.value.set` and `borrowsClaim`.
4. After decision 12: desktop `AppState` onto the global database, in the same
   bump.
5. The `repoState` slot replaces `WORKTREE_SHARED_KEYS`; the CLI goes through
   it.
6. Schema-checked reads for the raw casts.

### Rulings

**Keep** the current-value decision as accepted, shared stamp included.
**Keep** `EFF-ADOPT-config-provider` (settings stay synchronous) and
`RT-corrupt-record-tag` (values decode at the database boundary).
**Ask** for the call the archived global-database note left to the owner (two
global roots on desktop).

## Move 13: hosts are scoped programs that react to facts

### Current state

Move 4 gives the process a graph, but nothing owns the lifetimes inside a
host. The desktop's `createWindow` is one closure of about 1,380 lines
(`desktop/main/index.ts:243-1621`); its teardown is a synchronous
`DisposableStore` that forks `Scope.close` without awaiting it, and quit
resumes while those closes may still run. Per-window work runs as root
fibers no window owns (33 `runFork` calls in the package). The extension
reaches `ProgressViewProvider` through a static singleton from five sites,
one of which already holds the handle. The CLI chat keeps its own root-run
slot machine with flag objects and five unsafe `Deferred`s, re-implementing
what `Run` will own. Output presentation (opening files, the PDF, the
"missing outputs" dialog) runs inside every documents run, children
included, so a workflow-script fan-out can open files and dialogs on desktop
for each child (inference). The host-neutral controllers still carry
`mainView` and `progress` names.

### Target

- `openDesktopWindow(ports): Effect<void, E, Scope | ProcessServices>` and
  `bindProject(project): Effect<ProjectBinding, never, Scope>`; quit awaits the
  window scope.
- The extension builds its view provider in the activation scope and hands it
  to collaborators; both statics go.
- The CLI chat's slot becomes `SubscriptionRef<Option<Run>>`; cancel is
  `run.interrupt`.
- Presentation reacts to facts: a scoped `attachPresentation(session)` reads
  `output.produced` for root or focused runs and applies the host's policy;
  the documents plugin only commits facts. This covers only side effects that
  cannot change a verdict: opening outputs and PDFs for children, and the
  "missing outputs" dialog. Finalization that can fail or change the outcome,
  such as `openWorkflowOutput` (`executeAgent.ts:234-243`), stays a
  pre-terminal hook (move 3) that runs before `run.end` is committed.
  `output.produced` does not yet carry everything a host needs: the compiled
  artifact locations used to open a PDF and the per-round set of files to open
  exist only in the live pipeline. They are added to the fact first, on a
  format bump, so a host opens the right PDF and does not reopen earlier
  rounds' files.
- **Presentation is checkpointed, at least once.** After the host
  presents a round it records that round as presented. The checkpoint is a
  current value, not history: a `presentation` family in `CurrentValues`
  (move 12), keyed by run and presentation consumer, holding the set of
  presented `roundId`s, rather than an `output.presented` row. The consumer
  id must be stable across restarts and unique across concurrent host
  processes. The host kind is not unique, and the per-graph nonce is not
  stable, so choosing it is left to the implementing PR
  ([Open for the implementing PR](#open-for-the-implementing-pr)).
  A row on the run's aggregate needs the run's claim, and one on the
  session's aggregate needs the `borrowsClaim` path that move 12 retires
  (`Database.ts:623-735`). A `CurrentValues` write is one `BEGIN IMMEDIATE`
  with no aggregate claim, so a host that attaches after the run settled or
  after a restart can always write it, and never takes or releases a live
  run's claim. Adding the family amends the accepted current-value decision.
  It is deletable, like app-state. `removeRun` deletes every host's row of
  every run in `run.removed.runIds` (the whole removed closure, children included) in
  the same transaction, so checkpoints never outlive their run. An
  attaching host presents only rounds with no checkpoint, so a
  reattached window does not replay rounds already checkpointed and loses no
  outputs produced while no host was attached. A crash between the side
  effect and the checkpoint repeats that one round once. The effects are
  chosen to be idempotent: opening a file or PDF reveals the editor already
  showing it. Only the "missing outputs" dialog can appear twice, which is
  the accepted cost.

### PRs

1. The host defects above.
2. Delete the two singletons.
3. Desktop window and project binding as scopes; quit awaits them.
4. Split `createWindow` along its seams (auth, project navigation, bindings,
   settings attach, IPC routes) into scoped modules; lower the budget.
5. Add the presentation targets to `output.produced` (format bump); then
   presentation from facts for side effects only; verdict-affecting
   finalization stays pre-terminal. Argue against the one-run-program parity
   table's placement of presentation in `afterTurn`; root-run behaviour stays
   the same.
6. Controller renames into `controllers/session`, `launch` and `catalog`, with
   no shims (the VS Code ids stay).
7. After move 3 PR 4: the CLI slot on `Run`.

## Withdrawn

These were in the first draft and did not survive the checks:

- **One kernel fold for everything.** Resume needs a strict per-run fold with
  full history; the session kernel is tolerant and hydrated from a lossy
  listing. The SSOT survey already rejects tying resume correctness to display
  policy.
- **Every write is a command.** Claims, GC and the SQL write invariants stay
  in SQL. Only session-event appends must go through the publisher. Two paths
  do not: `removeRun` (fixed in the defects) and project app-state rows through
  `appendAll`, which the current-value table removes (move 12).
- **Documents as core.** Withdrawn after the owner's review: `documents` is
  already a plugin. The child-run edge and the native driver are core; the
  Codex, Claude and workflow-script children are tool calls of their plugins,
  with no driver table (move 2, 2026-09-27).
- **A plugin object with seven optional slots** (the first draft of move 2).
  Replaced by one table per seam.
- **Per-session hot-plug.** Mid-run change was later ruled in at step
  boundaries (2026-09-27, #13364); a per-session swap outside a step would
  lose per-run narrowing.
- **A single writer of `run.end`.** A stop with no live fiber and a close past
  its budget have no run scope. The floor is one writing function with two
  callers.
- **A caller-scoped run.** A run outlives the host request that started it.
- **An RPC library for the wire in move 5**, reopened for plugins by the
  2026-09-27 Trust ruling, and **a `Session` context tag now** (see moves 5
  and 6).

## Decisions for the owner

The owner's two reviews recommend answers to decisions 1 to 13, and the
alignment with #13360 adds decision 14. Decision 14 is decided and done (see
[Decided 2026-09-27](#decided-2026-09-27)); the rest stay open until the
owner confirms them:

| Decision                                                      | Review recommendation                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Plugins owning schema arms                                 | Yes, with tier and fold slice in the plugin module.                                                                                                           |
| 2. Kernel-only runtime reads                                  | Not as a new service now; the single-run lineage read first. A future kernel lives inside `SessionEvents` with one writer.                                    |
| 3. D5 and "one process is one host"                           | Re-rule them, with an owner-id nonce; the second-graph guard stays until the module slots are graph-owned.                                                    |
| 4. Own-key retry with no key                                  | Leave it pending on every host.                                                                                                                               |
| 5. Approve-all                                                | Also decide requests already pending, on every host, as recorded rows.                                                                                        |
| 6. The plugin drain                                           | Neither a hook nor a drain layer. As corrected: the edge stays `Sessions` → plugin, and the selected plugin's typed drain runs in the core shutdown protocol. |
| 7. `yolo`/`never` for plans, proposals, retries and questions | One answer, decided in core when the request opens, the same on every host.                                                                                   |
| 8. A follow-up typed into a stopped run                       | Admit it as a durable row that resumes the run, on every host; the CLI's in-memory buffer goes.                                                               |
| 9. Guard kinds on the `defineTool` contract                   | Allow.                                                                                                                                                        |
| 10. Pin the agent definition in the run's record              | Yes: the log records what the model saw, and resume uses the recorded definition.                                                                             |
| 11. The creator wizard                                        | Retire it in favour of the cross-host `creator` agent.                                                                                                        |
| 12. One global app-state root on desktop                      | Yes.                                                                                                                                                          |
| 13. Presentation out of the run                               | Yes, for side effects only.                                                                                                                                   |
| 14. Goal mode on resume                                       | Decided: starts paused until a human re-arms it. Done in #13387.                                                                                              |

1. May static in-tree plugins own durable state as arms of the one closed
   schema? Move 2 assumes yes.
2. Confirm move 1's reviewed target: no `SessionKernel` service; the
   single-run lineage read and an exhaustive `listingTypeOf` now, and any
   future kernel inside `SessionEvents` with one writer.
3. Re-rule D5 and "one process is one host" for move 4, confirming the
   reviewed target: an owner-id nonce, plus the typed second-graph refusal
   until the module slots are graph-owned.
4. Own-key retry with no key entered: leave the retry pending (GUI today) or
   deny it (TUI today)?
5. Should "approve all delegated" also decide requests already pending, on
   every host? Only the kinds the bypass covers would cascade (`toolEdit`,
   `bash`, `proposal`, the keys of `BYPASS_OF_KIND`). Questions, inquiries,
   retries and plan approvals stay pending.
6. Confirm the plugin drain as a step of the core shutdown protocol, with no
   `beforeSessionsClose` hook and no drain layer. The recommended edge
   (GitHub requires `Sessions`) is a Layer cycle, because `Sessions` already
   consumes `GitHubSubscriptions` (`sessionLayer.ts:1262`). The edge stays
   `Sessions` → plugin, and the protocol drains the plugin while it is still
   acquired.
7. What do `yolo` and `never` do for plan, proposal, retry and question
   requests, on every host? Move 9 PR 2 applies the answer in core. #13359
   left "one approval-policy authority" open for this decision, which shows
   that no shared path exists yet.
8. May a follow-up typed into a stopped, resumable run be admitted and resume
   it on every host (the CLI does this today in host memory), or refused
   everywhere? #13359 left "CLI follow-ups to an interrupted run" open for
   this decision: core refuses a follow-up to a cancelled run
   (`getToolUseFollowUpTarget`), so there is no shared path to converge on.
9. An action × resource ruleset on the tool contract (move 9 PR 4), in place
   of per-family guard kinds, touches the frozen `defineTool` contract:
   allowed? `fix/approval-gates` may pre-empt part of it.
10. Does a run pin its agent definition (setting and prompt) the way it pins
    its composition, so resume uses the recorded definition?
11. Does the creator wizard give way to the cross-host `creator` agent?
12. One global root for application state on desktop, instead of the Electron
    profile database?
13. Does output presentation move out of the run and into the hosts
    (move 13 PR 5)?
14. Does goal mode start paused on resume, continuing only after a human
    re-arms it (#13360's recommendation, as in deepseek-harness), rather than
    surviving resume? Decided yes; done in #13387.

### Decided 2026-09-27

The owner delegated these calls and asked for the long-term option each time.

- **A stopped child pauses, and the model continues it.** Ctrl-C or a parent
  stop pauses a workflow-script, Codex or Claude child instead of cancelling
  it. On resume the model is told the child is paused at N of M. Calling it
  again replays the child's journal and skips finished calls, as Claude
  Code's Workflow tool does with `resumeFromRunId`. A child is never resumed
  on its own. A disabled plugin shows up as an unavailable tool, which the
  step records. This deletes `PLUGIN_DRIVERS` and `DriverUnavailable` from
  the plan (move 2): "blocked, not failed" is the step's tool check. The
  native driver moves into core.
- **Third-party code plugins run out of process by default.** They run in a
  worker or child process and speak one typed Effect RPC schema, the same
  wire the hosts use. Capabilities are the `R` the plugin's RPC surface is
  granted. There are two kinds of third-party plugin: data plugins (the
  Claude Code / Codex layout) load as data, and code plugins run out of
  process. No third-party code loads in process; in-process loading is only
  for built-in plugins. Trust keys on a trust revision that includes a
  content digest of what runs; the config revision stays for tool identity
  only. This scopes the loader's
  security review to the process boundary and the granted capability set,
  and reopens the RPC rejection in move 5 for this boundary.
- **Format policy after 1.0: a version per row kind, migrated lazily at the
  read boundary.** Each row kind, plugin-owned kinds included, carries its own
  schema version, and its migrations are registered with its schema. The
  whole-store stamp (`SESSION_EVENT_FORMAT`, 25 today) stays only until 1.0,
  and format bumps stay free until then. This is required once plugins own
  row kinds: one plugin's schema change must not reset everyone's history.
- **Goal mode after resume** (decision 14): paused until the user re-arms it.
  Done in #13387.
- **Presets store switches.** A preset is the user's saved selection of
  switches; availability is resolved when resources are acquired.
- **Descriptions are not part of tool identity.** Identity is name, input
  schema with descriptions stripped, plugin id and plugin revision; a
  description change is recorded through the offered snapshot's `shown`
  digest and rejects no call. Done in #13364.

## Suggested order

Deletion earliest, least churn (the owner's review):

1. Defects and hygiene: the `SessionHandle` dead imports, `heldSessions` and
   `teardownDefaultSession`; `removeRun` through the publisher (done, #13375); the SDK calling
   `bootstrapHost`; `forkScoped` and the `AppSignals` finalizer; an exhaustive
   `listingTypeOf`; the single-run lineage read. The security fix reported
   separately, and the second survey's defects, run alongside.
2. The de-duplication cuts on one format bump.
3. Workflow resume through the tool-use path, with the desktop Resume fix;
   delete `executeWorkflow` and `runId` from `RunRequest`. Done (#13384).
4. Terminal consolidation onto `runWithLaunchGuard`, rebased after #13348.
   Done (#13385).
5. Trace and transport lifecycle fixes (move 7 PRs 1–3, move 5 PR 1), and the
   model binding fixes (move 8 PRs 1–3).
6. The per-seam contributions on the Registry: tools (#13364) and the
   continuation (#13387) are done. Next are plugin services
   (`PLUGIN_PROCESS_LAYERS`, `PLUGIN_SESSION_LAYERS`) and plugin-owned row
   kinds with fold slices and per-kind versions. Paused children replace the
   dropped driver table, and the native driver moves into core.
7. Installed plugins as loaded data plugins, the prompt digest on the step
   record, presets and trust, then the `setup` tool. Needs owner decisions.
8. Anything else (`SessionKernel`, `ProcessLayer`, `SessionPlane`, `RunTrace`,
   and the structural halves of moves 9 to 13) only when a PR shows it deletes
   more than it adds.

## What is open

Landed on `main` since this note merged:

- #13384: workflow runs resume through the one core path; the
  `executeWorkflow` ports are deleted (move 3).
- #13385: one launch door, `RunRegistry.launch` on the session's context, and
  one launch terminal, `runLaunchGuard` (move 3; rule R2 of the
  core-concepts note).
- #13386: format 23. Each fact is stored once (usage on `model.message`,
  files only in `output.produced`, `run.config` replacing `run.record`); rows
  have a durable identity `(uid, seq)`, and the writing process is
  `origin`.
- #13364: Registry and Step for tools. Each step pins a generation and writes
  `tools.offered` when the offered set changes. Tool identity is name,
  description-free schema, plugin id and revision; a built-in revision is the
  constant `builtin` and an MCP revision is `sha256({spec, envHmac})` under a
  per-install key. Tool instructions are rendered per step. Format 24.
- #13387: the continuation lives on the Registry and each step pins and
  records it; goal mode pauses on resume. Format 25.

In flight:

- paused children (the 2026-09-27 ruling);
- the defects in step 1 of the suggested order;
- plugin services (`PLUGIN_PROCESS_LAYERS`, `PLUGIN_SESSION_LAYERS`);
- plugin-owned row kinds.

Also on the baseline: #13375 (move 1 PR 3, `removeRun` through the
publisher), and the defect fixes #13376 (approval bypasses lost on resume;
headless proposals decided without rows), #13372 (hosts deciding a run's
outcome) and #13373 (external skill roots scoped to their project). With
#13386, move 1 PRs 3 and 4 are done; PRs 1 and 2 remain. Moves 4 to 13 and
the rest of move 2 have not started.

### Open for the implementing PR

Review of this note kept finding implementation mechanics that belong with
code rather than in a proposal. The invariants stay here and the mechanism
is chosen in the PR that implements the move:

- **Presentation consumer id** (move 13). It must be stable across restarts
  and unique across concurrent host processes on one project.
- **Cross-host claim takeover** (move 10). Claim liveness is a local PID
  probe, so an owner on another machine is never provably dead. A shared
  project database needs a lease or heartbeat, or an explicit takeover
  policy, before automatic wakes can recover input across hosts.
- **Mechanics below the stated invariants** in moves 10 to 13: lock
  recovery, retry schedules, listing keys. The invariant each states is the
  contract, and the PR proves it against the code.
