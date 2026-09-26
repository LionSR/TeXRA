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
terminal. The process is a runtime plus about fifteen module slots. Each host
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

## Defects to fix first

These do not depend on any architectural decision. Each is one small PR.

| Defect                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop **Resume** on a halted workflow run turns it into a failed run _(confirmed)_        | `HostRunActions.resume` passes `{config, runId}` to the host's `runValidated` (`src/controllers/session/hostRunActions.ts:625-632`). The desktop always wraps it as `kind:'fresh'` (`packages/desktop/src/main/desktopAgentRun.ts:196`), so `runAgent` registers again, `loadRun` refuses with "already has ledger state" (`src/agent/runtime/loop/runProgram.ts:159-165`) and the lifecycle writes `run.end FAILED`. The defect is desktop-only: the extension maps the id to `kind:'resume'` (`extensionHostRequests.ts:215-222`) and resumes correctly. Its workflow resume still bypasses `resumeRun`, the route tool-use runs take, so it drops the persisted `modelCompatibilityKey` (`resumeRun.ts:260-266`) and refuses a run another process holds through the claim acquisition rather than `resumeRun`'s owned-elsewhere marking. | Send workflow runs through `AgentResume.tryResumeRun` too (tool-use runs already go there; `resumeRun` has the workflow branch). Then remove `runId` from `RunRequest`/`ValidatedRunRequest`, so `runValidated` is fresh-only on both hosts and the desktop's hard-coded `fresh` is correct by construction.                              |
| The SDK never runs `bootstrapHost` _(confirmed)_                                            | `packages/agent/src/effect/runtime.ts:228` calls `installProcessRuntime` directly. `bootstrapHost` (`src/controllers/hostBootstrap.ts:77-115`) installs the long-stream dispatcher, so embedders get undici's 300 s body timeout instead of 30 min and no proxy. The setting host defaults to `'vscode'` while the tool gate reads `undefined` and `PACKAGE_SETUP.host` throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Make `storageDir` explicit (today it defaults to the real `~/.texra`), derive the MCP config path from it, and give embedders the long-stream transport by default as a fetch bound to the model factories rather than a global dispatcher (`modelTransport: 'bound'`). The full fix is [move 4](#move-4-the-process-is-one-layer-graph). |
| `run.removed` bypasses the publisher _(confirmed)_                                          | `Database.removeRun` appends it inside its own transaction (`src/controllers/session/Database.ts:1048`). The publisher's `run.removed` arm (`src/agent/runtime/SessionEvents.ts:183`) never fires, so its open-work and follow-up entries for removed runs are never pruned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Widen the publisher job to `(ops: { append; removeRun })` and route removal through `exclusive`. The dependent-closure transaction stays in SQL. The tracker's `run.removed` arm must prune every id in `row.runIds` (the whole closed dependent set), not only `row.aggregateId` as it does today (`SessionEvents.ts:183-187`).          |
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
  (`AgentLaunchContext.ts:383-389`).
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
| [8. Model plane](#move-8-the-model-plane-is-a-layer)                                     | bindings retired only at run end, calls outside the invoker, a session-scoped retry gate, the global dispatcher, two error taxonomies                                | L      | the ModelCell ruling (its files are gone)                                            |
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
drops the `RunTrace` rename. Moves 8 to 13 are not yet reviewed one by one.

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
   `runAgent`'s double read.
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
3. `removeRun` through `exclusive`, pruning `runIds`.
4. The de-duplication cuts on one format bump.

### Rulings

- **Keep** the `SESSION_EVENT_FORMAT` bump ruling: PR 4 is the bump, and 1.0
  starts from a clean state.
- **Keep** `RT-corrupt-record-tag`: `decodeEvent` stays the one decode site.
- **Keep** the single-owner liveness note: the DB claim is the only liveness
  authority.

## Move 2: plugins are typed Layers at the existing lifetimes

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

`documents` is already a manifest plugin (`pluginManifest.ts:154-167`,
hidden, `continuation: true`) that contributes `roundsContinuation` through
`PLUGIN_CONTINUATIONS` (`continuationPolicy.ts:88-95`). What leaks is
`RunView` being discriminated on `AgentCategory` (`sessionView.ts:199-212`).

### Target: one table per seam

There is no plugin object. Each seam has one fixed table, keyed by plugin id,
living in the layer that owns the seam, checked with `satisfies` against the
manifest flag that declares the contribution. That keeps "the manifest imports
no tool implementation" true, which dashboards and webviews rely on, and adds
no `@tools` to `@agent` edges.

| Table                    | Seam and owner                       | Contributors                                                                                                              |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `PLUGIN_TOOLS`           | tools (exists)                       | every tool plugin                                                                                                         |
| `PLUGIN_CONTINUATIONS`   | the run loop's continuation (exists) | `documents` (rounds), `plan` (goal)                                                                                       |
| `PLUGIN_LAYERS`          | process services (exists, empty)     | GitHub subscriptions, Lean (needs `HostPorts` in `R`, or stays core as ruled on 09-23), `InquiryRecords`, `SetupPlatform` |
| `PLUGIN_SESSION_LAYERS`  | the session entry                    | Codex and Claude handle registries (two real contributors of one shape)                                                   |
| `PLUGIN_DRIVERS`         | child-run drivers                    | `codex`, `claude-agent`, `workflow-script`; `native` stays core                                                           |
| `PLUGIN_EVENT_ARMS`      | the one closed event schema          | goal, inquiry, workflow checkpoints, documents (`output.produced`)                                                        |
| `PLUGIN_PROMPT_SECTIONS` | prompt assembly                      | `memory-workflow`, only in the PR that moves its blocks out of `PromptBuilder.ts`                                         |

- **Drivers are contributions, not task kinds.** The Codex, Claude and
  workflow-script drivers already live in their plugins
  (`agentCliShared.ts:532`, `workflowScriptStrategy.ts:157`). Resolve a driver
  from the run's pinned composition, and fail a resume loudly if its driver
  plugin is off. This also deletes `resumeRun`'s `@tools/delegation` import.
- **Documents stays a plugin.** Its workflow arm of `RunView` becomes the
  documents plugin's fold slice; the category is the fact that selects which
  continuation plugin a run gets.
- **Schema arms carry their tier and fold slice in the plugin module**, so a
  new stateful plugin touches one spread line in core. The union stays closed
  and composition-independent: rows always decode and fold whether or not the
  plugin is switched on. Loaded plugins own no durable state.
- **Prompt sections are `(ctx) => string` per plugin**, consulted only for
  plugins in the pinned composition. The first draft's
  `(plugins, ctx) => string[]` coupled plugins to each other.
- **The GitHub drain is a dependency edge, not a hook.** The GitHub plugin's
  process layer requires `Sessions` and drains deliveries in its finalizer, so
  Effect finalizes it before sessions close. No `beforeSessionsClose`, no drain
  layer.
- **The goal-grant WeakMap is deleted, not moved.** It saves, mutates and
  restores a bypass value. The effective bypass is computed from the
  approval-policy rows and the goal rows instead, so the bad state cannot
  exist (this also answers the two grant defects above).
- **Installed plugins join the one model instead of being renamed away.** The
  owner has ruled that a plugin is one on/off unit with one install record,
  qualified names and a `plugin:<id>/<name>` agent source, and that no new
  formats are invented. An installed Claude Code or Codex plugin becomes a
  `LoadedPlugin` like `mcp:<name>`, whose revision is its commit or tree hash;
  its `skills/`, `agents/`, `commands/` and `.mcp.json` become data-table
  entries; it enters `Composition.loaded`, so one switch hides everything it
  contributes. Third parties never write TypeScript.
- **The composition is recorded in the log.** The opening `flow.snapshot`
  records the composition value (plugin set, loaded revisions, preset id), not
  only `toolsetHash`, so behaviour can be attributed to a plugin revision.
- **Presets are stored compositions.** Today's switches become the preset
  `default`, an agent YAML may name a preset, and the session records the
  preset id. The plugin note already promised this.
- **Trust is per content digest.** Trust is keyed on a restart-stable,
  non-secret digest of the plugin's content (a SHA-256 of the server
  definition, or the commit or tree hash of an installed plugin): a changed
  digest is a new, untrusted revision. Today's MCP revision is an HMAC under a
  per-process random key (`mcpConfig.ts:70-74,201-203`), deliberately
  unguessable and different after every restart, so it stays the composition's
  revision and is not the trust key. This also answers the deferred project
  `.texra/mcp.json` trust prompt.
- **Self-improvement goes through data.** An approval-gated tool in the
  `setup` plugin installs, enables, trusts and saves presets. It takes effect
  at the next run open; in-flight runs keep their pin. Code tables change
  only by editing the code and restarting.

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

Choose at run open. A switch or preset applies to the next run, plugin
resources come up and go down by refcount at their own lifetime, and a child
joins its parent's pin. Swapping inside a running run would rewrite
`offeredTools`, change the toolset hash and the prompt cache, contradict the
run-pin ruling (2026-09-23), and contradict SDK §8 ("hot replacement must not
advertise one implementation and execute another").

### Stays core

The `native` driver and the child-run edge (`child.park`/`child.turn`, the
session budget), and the approval authority. UI renderers stay a static table
in `src/ui`, because webview frontends cannot import `@tools`.

### PRs

1. A deterministic availability input to the composition key; LM tools through
   a pin. First.
2. `PLUGIN_LAYERS` filled: GitHub (with the `Sessions` dependency edge),
   Inquiry and Setup; the SDK passes its plugin set and `PACKAGE_SETUP` goes.
3. `PLUGIN_SESSION_LAYERS` for the Codex and Claude registries; the goal grant
   computed from rows, WeakMap deleted.
4. `PLUGIN_DRIVERS`, resolved from the pinned composition.
5. `PLUGIN_EVENT_ARMS` with tier and fold slice per module, gated on the
   format fingerprint staying byte-identical; the documents fold slice replaces
   the category discrimination in `RunView`.
6. `PLUGIN_PROMPT_SECTIONS` with the `memory-workflow` move.
7. Installed plugins as loaded plugins; the composition on the snapshot;
   presets; trust per hash; then the `setup` tool. Needs owner decisions.

### Rulings

- **Amend** the plugin note (`2026-09-24-plugin-architecture.md:211-236`):
  "Plugins own no durable state and no event channel" becomes "static in-tree
  plugins own arms, with tier and fold slice, in plugin modules of the one
  closed schema". "Prompt sections are core" becomes "a plugin in the pinned
  composition may contribute one section".
- **Amend** "no task kinds" in v1 to say a driver for an existing child-run
  seam is a contribution, not a task kind.
- **Amend** one-run-program line 366 for the continuation seam, which already
  moved to `PLUGIN_CONTINUATIONS`.
- **Keep** the run-pin ruling, the per-session `LayerMap` ruling (no new
  lifetime), the owner's installed-plugin ruling (one unit, one record, no new
  formats), and SDK §8 (every contribution point is a typed static table).

## Move 3: one launch surface

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

Native fresh, resumed and child runs already share `runFlowWithLifecycle` →
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
  workflow run, and refuses a workflow resume without it once the run's
  category is loaded, so a finalization failure can never persist as success.
- **`runId` leaves `RunRequest`/`ValidatedRunRequest`**, so `runValidated` is
  fresh-only on every host and the desktop's hard-coded `fresh` is correct by
  construction (the desktop defect).
- **Terminals consolidate onto `runWithLaunchGuard`.** `runAgent`'s and
  `resumeToolUse`'s own claim-and-terminal blocks become calls to it. The
  floor stays one writing function (`finalizeRun`) with two callers: the run's
  own terminal and the ownerless stop or close past budget.
- **The resume launch context matches the fresh one** (`ensureRunDirUnder`,
  description, progress reveal, the start hooks).
- **The follow-up lease is not owned here.** #13348 moves it into
  `runToolUse`'s own scope; nothing in this move takes it back.
- Drivers are move 2's `PLUGIN_DRIVERS`. The `Run` handle is move 7's.

### PRs

1. Workflow resume through the tool-use path with the desktop fix; delete
   `executeWorkflow` and `runId` from `RunRequest`.
2. Delete the dead fresh `onIdle` branch; fix the `withInactiveRunStep` doc.
3. The resume launch context matches the fresh one.
4. Terminals onto `runWithLaunchGuard`, rebased after #13348.

Estimated net: about −250 production lines; test churn is about 48 `runAgent`
hits in 5 files.

## Move 4: the process is one Layer graph

### Verdict after review: shrink

- Keep: the SDK calling `bootstrapHost` with an explicit `storageDir` and
  `modelTransport`; `AppSignals` with a finalizer; process `forkDetach` calls
  becoming `forkScoped`.
- For "one graph per process", use an **owner-id nonce** rather than a latch:
  the nonce makes the bad state impossible, and the format bump is free.
- The Lean process layer needs `HostPorts` in `R`, or it stays core, as ruled
  on 09-23.
- Measure the bare-run count before the CLI PR (`RT-install-cli-process-runtime`).
- `ProcessLayer` as a whole waits until a PR shows it deletes more than it
  adds.

### Current state

Five composition roots install the process runtime (extension, desktop, CLI
`cliProcessRuntime.ts`, the SDK, and the test harness that 79 suites import).
`bootstrapHost` is a separate step the SDK skips. About fourteen Node-side
module slots live outside the runtime, including the `SessionOwner`, the
`AppSignals` hub (never shut down), the setting host, two account probes,
skill contributions, plugin agent directories, the agent catalog, rate
limiters, external roots (now two writers), `cliSecrets` (ignores later
roots) and the CLI log runtime. Process-lifetime `forkDetach` fibers outlive
`runtime.dispose` (the reprobe at `hostBootstrap.ts:112`, the extension's
remote catalog and welcome, `AgentDirectoryManager.ts:250`). Four
hand-registered shutdown chains repeat "close sessions first, runtime last".

### Target

The SDK gets the same bootstrap as the hosts, with explicit options instead of
ambient defaults:

```ts
export interface TexraProcessOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  readonly storageDir: string; // required: no silent ~/.texra
  readonly mcpConfig?: string | false; // default: `mcp.json` under storageDir; false disables MCP
  readonly modelTransport?: 'bound' | 'process-global'; // default 'bound': the long-stream fetch, not global
  readonly diagnostics?: Layer.Layer<never>;
  // Which plugins the process composes: a preset id or an explicit set.
  // Default: core only, so an embedder opts in to Setup, GitHub, Lean and the rest.
  readonly plugins?:
    { readonly preset: string } | { readonly ids: readonly PluginId[] };
  // The one approval authority for every session this process opens (move 7).
  readonly approvals?: ApprovalMode; // default 'denyAll'
}
export const TexraProcess: {
  layer(o: TexraProcessOptions): Layer.Layer<Sessions, DatabaseOpenFailed>;
};
```

- **The SDK calls `bootstrapHost`** with these options, so it gets the
  long-stream transport (as a bound `fetch` unless `'process-global'`), the
  host identity, skills and plugin agent directories.
- **The host identity is data** on `SettingsStores`/`WorkspaceRoots`, not a
  slot or a tag.
- **`AppSignals` is a service with a shutdown finalizer**, and process-lifetime
  `forkDetach` calls become `forkScoped` on the runtime's scope.
- **The owner id gains a per-graph nonce**, so two graphs in one process are
  distinguishable by the lease; the durable-format change rides a free bump.
- **Stays process-global:** the fetch dispatcher for hosts
  (`'process-global'`), and a plain log writer before and after the runtime.
- **Not scheduled:** the full `ProcessLayer` graph, the slot-by-slot
  conversions and a single shutdown chain, until a PR shows each deletes more
  than it adds.

### PRs

1. The SDK: explicit `storageDir`, `bootstrapHost`, the bound transport, the
   plugin set and the approval mode.
2. Host identity as data; delete `installedHost`, `initProcessSettingHost`,
   `processToolHost`.
3. `AppSignals` as a service with a finalizer; process `forkDetach` becomes
   `forkScoped`.
4. The owner-id nonce, on a format bump.
5. The CLI only after measuring its bare-run count
   (`RT-install-cli-process-runtime`).

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
- `policy.set` enabling approve-all also decides that run's pending requests,
  on every host, inside `SessionRequests` (decision 5).
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

- **An RPC library.** `effect/unstable/rpc` requires Effect Schema: +231 KB
  minified, +71 KB gzipped per webview (measured). PRD §7.6 rules out Effect
  Schema, a sixth `unstable/*` family would need its own ledger ruling row, and
  SDK §5 says "do not create an SDK command bus".
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
- `start` returns `Effect<Run, LaunchError, Scope>`. The scope bounds only
  the caller's event subscription: closing it detaches that reader, and the
  run keeps going. The run fiber belongs to the session scope, and only
  `run.interrupt` or closing the session stops it. The core `Run` handle is
  reconciled with the SDK's (which has `view` and no `idle`) in this move.
- Approvals as data: `session.requests: Stream<PendingRequest>`, which
  first replays every request pending in the session's fold, then follows new
  ones, so a consumer forked after `start` cannot miss a request a fast run
  opened in the gap. Under `manual` that replay is what keeps a run from
  parking forever.
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

## Move 8: the model plane is a Layer

Moves 8 to 13 came from the second survey. The owner's review did not rule on
them one by one; the same two standards apply, and each PR that is not a
defect fix lands only if it deletes more than it adds.

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

```ts
class ModelPlane extends Context.Service<
  ModelPlane,
  {
    readonly bind: (
      i: BindModelInput,
    ) => Effect.Effect<BoundModel, BindFailed, Scope.Scope>;
    readonly gate: ModelRetryGate; // process-scoped, keyed by wire route
  }
>()('@texra/model/ModelPlane') {}

class RunModel extends Context.Service<
  RunModel,
  {
    readonly current: Effect.Effect<BoundModel>;
    readonly swap: (i: BindModelInput) => Effect.Effect<BoundModel, BindFailed>; // closes the retired scope
    readonly auxiliary: (
      req: TurnRequest,
      purpose: 'compaction' | 'helper',
    ) => Effect.Effect<
      { turn: TurnResult; usage: NormalizedUsage | null },
      ModelFailure
    >;
  }
>()('@texra/agent/RunModel') {}
```

Each binding gets `Scope.fork(run.scope)` and a swap closes the old one. A
transport failure on a WebSocket origin reacquires through `swap` before the
next automatic attempt. `ModelTransport` (move 4) supplies `fetch` and a proxy
agent to every factory, and `setGlobalDispatcher` goes. Classification reads
`ModelError` first and keeps `sdkError` only for provider evidence the package
cannot know. `EditorModel` merges into `LanguageModel`; the validation model
becomes a CLI test Layer.

### PRs

1. The usage-row and manual-rebind defects.
2. Per-binding scopes, with the ModelCell ruling rewritten in the same PR.
3. WebSocket reacquisition through `swap`.
4. The `auxiliary` path: compaction gated, priced and recorded (the usage field
   rides an existing format bump).
5. `ModelTransport`, with move 4 PR 6.
6. The retry gate moves to process scope; helpers run under it.
7. `EditorModel` merged; validation model as a Layer.
8. Classify from `ModelError`.
9. A Node-side provider table keyed by plugin id for binding quirks, price
   tiers and detection (provider names appear in 14 to 23 files each).

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
    ) => Effect.Effect<RequestDecision | 'present', never, ToolCall>; // every request kind
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
(move 2), so it survives resume and cannot outlive the goal. `ToolGuard`
gains `confirm` and `external` kinds beside `bash`, `requiresApproval` goes
back to filtering only what is offered, and a `toolCall` request kind replaces
approving MCP calls as shell. `approval.policy` rows follow `state`. It lives
in the existing session entry (no new lifetime) and keeps `withPerKeyLane`.

### PRs

1. The approval defects above, plus reading the policy inside the lane.
2. The policy decided for every request kind at `openRequest`; delete the
   CLI's evaluators and narrow the ratchet. Needs decision 7.
3. Extend the ratchet to bypass writes; the host launch and the goal grant
   through `grant`.
4. Guard kinds and the `toolCall` request kind. Needs an owner ruling under
   the `defineTool` freeze amendment.
5. `ApprovalState` as a `SubscriptionRef`, with move 6's plane.
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
class RunInbox extends Context.Service<
  RunInbox,
  {
    readonly take: Effect.Effect<FollowUpBatch | null>;
    readonly hasQueued: Effect.Effect<boolean>;
    readonly consume: (s: RunState, b: FollowUpBatch) => Effect.Effect<ConsumedFollowUps, Error>;
  }
>()('@texra/session/RunInbox') {}

// on Runs
deliver(runId: RunId, items: readonly FollowUpQueueInput[], o: { wake: 'auto' | 'deferred' }):
  Effect.Effect<Delivery, RunAdmissionClosed | HeldElsewhere>;
wake(runId: RunId): Effect.Effect<void>; // the second phase of a deferred delivery
```

`deliver` appends `followup.queued` through the publisher. Under `'auto'`,
`Runs` chooses the wake inside the run's lane, atomically with the append: a
live entry is notified, and a resumable one is woken by
`Runs.run({ _tag: 'Resume' })` forked into the session scope, with no host
port. The caller never chooses, so a run that turns live or idle while the
delivery is prepared cannot leave the row unwoken. `'deferred'` admits the row
durably, wakes nobody, and stays invisible to consumption until `wake`: the
run entry holds its delivery ids in a deferred set that `take` skips, as the
manager's `deferred` set does today (`ToolUseFollowUpQueueManager.ts:53-58,287`),
so an unrelated resume of the parent cannot consume the child's row before the
child finalizes. After a crash, hydration releases a deferred row whose
producing child already has its `run.end`. A native child uses it for its turn result before it
finalizes and calls `wake` afterwards, as `deliverTurn` and
`submitPendingDelivery` do today (`childRunLoop.ts:601-607,654`): the durable
row survives a crash, and the parent never sees the child as still running
when it wakes (#8093). Resume becomes interruptible
with `acquireRelease` on its recovery lease. The inbox is keyed on the fiber,
not the claim (liveness note §2.5).

### PRs

1. The follow-up defects above, and the stale "wait node" wording.
2. Re-offer an unsettled native-child turn on resume.
3. Interruptible resume; delete the cancellation predicates (after move 3 PR 3).
4. The inbox in the generation's scope; delete the flow and child lease kinds.
5. `Runs.deliver` and core wakes; delete the recovery lease, the adopted
   claim and the wake half of `AgentResume` (after move 3 PR 4).
6. After decision 8: follow-ups to a stopped run admitted in core; delete the
   CLI buffer.
7. `onRelease` and `onSent` become scoped subscriptions over the kernel's
   pending set (after move 1).

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
is pinned. `AgentDirectories` is built three ways.

### Target

```ts
type RemoteStatus = Data.TaggedEnum<{
  NotLoaded: {};
  SignedOut: {};
  Loaded: { at: number };
  Failed: { cause: unknown };
}>;
interface ResolvedAgent {
  entry: AgentEntry;
  setting: AgentSetting;
  prompt: AgentPrompt;
  digest: string;
}
class AgentCatalog extends Context.Service<
  AgentCatalog,
  {
    readonly state: SubscriptionRef.SubscriptionRef<{
      agents: ReadonlyMap<AgentKey, ResolvedAgent>;
      issues: readonly AgentScanIssue[];
      remote: RemoteStatus;
    }>;
    readonly refresh: (o: {
      remote: 'keep' | 'fetch' | 'drop';
    }) => Effect.Effect<void, AgentCatalogLoadError>;
    readonly resolve: (
      req: AgentLaunchRef,
    ) => Effect.Effect<ResolvedAgent, AgentNotFound>;
  }
>()('@texra/agent/AgentCatalog') {}
```

A scoped layer in move 4's graph: an initial load, then a `DirectoryWatch` host
port (VS Code watcher or `FileSystem.watch`) debounced into `refresh`. The
scanner becomes the one validating loader. Runs record the full resolved
definition on the snapshot (setting and prompt, with its digest) and resume
from it, so an edit to the YAML between a halt and its resume changes neither
the settings nor the instructions. Post-auth invalidation stays per host, as
ruled.

### PRs

1. The agent defects above.
2. Remote status in the existing state, no API change.
3. One validating loader; delete the launch loader's inheritance walk.
4. `AgentCatalog` in the process graph; delete the 22 loads, the extension's
   manager and the plugin-directory slot; watchers on every host.
5. Pin the definition on the snapshot. Needs decision 10.
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
export class CurrentValues extends Context.Service<
  CurrentValues,
  {
    get<F extends Family>(
      f: F,
      key: string,
    ): Effect.Effect<Value<F> | undefined, DatabaseReadFailed>;
    modify<F extends Family, A>(
      f: F,
      key: string,
      change: (v: Value<F> | undefined) => readonly [A, Value<F> | undefined],
    ): Effect.Effect<A, DatabaseWriteFailed>; // one BEGIN IMMEDIATE
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
3. `CurrentValues` on the next format bump, as the accepted decision
   specifies; retire `state.value.set` and `borrowsClaim`.
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
  pre-terminal launch hook (move 3's `launch` on both arms) that runs before
  `run.end` is committed.

### PRs

1. The host defects above.
2. Delete the two singletons.
3. Desktop window and project binding as scopes; quit awaits them.
4. Split `createWindow` along its seams (auth, project navigation, bindings,
   settings attach, IPC routes) into scoped modules; lower the budget.
5. Presentation from facts for side effects only; verdict-affecting
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
- **Documents and child-run drivers as core.** Withdrawn in turn after the
  owner's review: `documents` is already a plugin, and the Codex, Claude and
  workflow-script drivers are contributions to an existing seam, not task
  kinds (move 2). The child-run edge and the `native` driver stay core.
- **A plugin object with seven optional slots** (the first draft of move 2).
  Replaced by one table per seam.
- **Mid-run or per-session hot-plug.** Contradicts the run-pin ruling and SDK
  §8, and would lose per-run narrowing.
- **A single writer of `run.end`.** A stop with no live fiber and a close past
  its budget have no run scope. The floor is one writing function with two
  callers.
- **A caller-scoped run.** A run outlives the host request that started it.
- **An RPC library for the wire**, and **a `Session` context tag now** (see
  moves 5 and 6).

## Decisions for the owner

The owner's review recommends answers to the first six; they stay open until
the owner confirms them:

| Decision                            | Review recommendation                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1. Plugins owning schema arms       | Yes, with tier and fold slice in the plugin module.                                                                        |
| 2. Kernel-only runtime reads        | Not as a new service now; the single-run lineage read first. A future kernel lives inside `SessionEvents` with one writer. |
| 3. D5 and "one process is one host" | Re-rule them, with an owner-id nonce rather than a latch.                                                                  |
| 4. Own-key retry with no key        | Leave it pending on every host.                                                                                            |
| 5. Approve-all                      | Also decide requests already pending, on every host, as recorded rows.                                                     |
| 6. The plugin drain                 | Neither a hook nor a drain layer: a layer dependency on `Sessions`.                                                        |

1. May static in-tree plugins own durable state as arms of the one closed
   schema? Move 2 assumes yes.
2. Is `SessionKernel` the only thing runtime decisions read, with
   `SessionView` display-only? Move 1 assumes yes, against one-run-model §3.8.
3. Re-rule D5 and "one process is one host" for move 4, and choose between a
   one-graph-per-process latch and an owner-id nonce.
4. Own-key retry with no key entered: leave the retry pending (GUI today) or
   deny it (TUI today)?
5. Should "approve all delegated" also decide requests already pending, on
   every host?
6. `beforeSessionsClose` as a named plugin hook, or a drain layer in the
   process graph that asks plugin services for their drains?
7. What do `yolo` and `never` do for plan, proposal, retry and question
   requests, on every host? Move 9 PR 2 applies the answer in core.
8. May a follow-up typed into a stopped, resumable run be admitted and resume
   it on every host (the CLI does this today in host memory), or refused
   everywhere?
9. Guard kinds on the tool contract (move 9 PR 4) touch the frozen
   `defineTool` contract: allowed?
10. Does a run pin its agent definition (setting and prompt) the way it pins
    its composition, so resume uses the recorded definition?
11. Does the creator wizard give way to the cross-host `creator` agent?
12. One global root for application state on desktop, instead of the Electron
    profile database?
13. Does output presentation move out of the run and into the hosts
    (move 13 PR 5)?

## Suggested order

Deletion earliest, least churn (the owner's review):

1. Defects and hygiene: the `SessionHandle` dead imports, `heldSessions` and
   `teardownDefaultSession`; `removeRun` through the publisher; the SDK calling
   `bootstrapHost`; `forkScoped` and the `AppSignals` finalizer; an exhaustive
   `listingTypeOf`; the single-run lineage read. The security fix reported
   separately, and the second survey's defects, run alongside.
2. The de-duplication cuts on one format bump.
3. Workflow resume through the tool-use path, with the desktop Resume fix;
   delete `executeWorkflow` and `runId` from `RunRequest`.
4. Terminal consolidation onto `runWithLaunchGuard`, rebased after #13348.
5. Trace and transport lifecycle fixes (move 7 PRs 1–3, move 5 PR 1), and the
   model binding fixes (move 8 PRs 1–3).
6. A deterministic composition input (move 2 PR 1), then the per-seam tables:
   `PLUGIN_LAYERS`, `PLUGIN_SESSION_LAYERS`, `PLUGIN_DRIVERS`, plugin-owned arms
   with fold slices.
7. Installed plugins as loaded plugins, the composition on the snapshot,
   presets and trust, then the `setup` tool. Needs owner decisions.
8. Anything else (`SessionKernel`, `ProcessLayer`, `SessionPlane`, `RunTrace`,
   and the structural halves of moves 9 to 13) only when a PR shows it deletes
   more than it adds.

## What is open

Everything in this note. No move has started.
