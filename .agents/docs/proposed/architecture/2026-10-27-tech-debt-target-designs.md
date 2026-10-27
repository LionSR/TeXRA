# Target designs for the ten costliest tech debts

Date: 2026-10-27
Status: proposed — designs and PR slices; owner decisions listed below are open.
Baseline: `main` at `d8a4f66`; `60967d2` adds only dependency bumps.
Survey: [the ten costliest tech debts](../simplification/2026-10-27-top-ten-tech-debts.md).

Seven read-only design passes, one per root cause, each checked against
the rulings ledger. Each target meets the two owner rules below. Line
numbers point into `d8a4f66`.

1. **Effect-native.** Every owner is an Effect primitive: `Fiber`,
   `Scope`, `Deferred`, `FiberMap`, `SubscriptionRef`, `Stream`, `Layer`
   and `Context`. No hand-made flag, mutable map, `AbortController` or
   Promise wiring.
2. **No dual systems.** There is exactly one mechanism per concern. Each
   slice deletes what it replaces in the same PR. Where a slice must keep
   two for a moment, it names the next slice, which removes the old one.

## Owner decisions this work needs

| #   | Decision                                                                                                                                                                                                                                                    | Needed by                     | Recommendation                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| D1  | Take `childRunLoop.ts` off the `AbortController` residents ([ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md), "The permanent `AbortController` residents")                                                                | Run lifecycle, slice L3       | Yes. The ruling's own reason holds without the controller (§1).                                                          |
| D2  | Optional, not blocking: on a Stop, should an in-flight call get a terminal "stopped" row instead of leaving its rows for resume (`ScriptTool.ts:274-277`; the durable-harness note's "Interrupted calls")? T5 keeps today's rule either way                 | Only if wanted, after T5      | Keep today's rule. A terminal row would stop a resume after a Stop from re-running replay-safe calls, `script` included. |
| D3  | A child detached mid-run keeps child behaviour until its next activation (the attached parent is read once per activation).                                                                                                                                 | Run lifecycle, slice L5       | Accept. Cite the one-run model §3.2.                                                                                     |
| D4  | Pasted media stored by blob digest rather than workspace path (#13874; also `run.config.mediaFiles`), and blob lifetime under reachability collection                                                                                                       | **Before the storage freeze** | Digest, shared with `storedTurn`'s `MediaAddress`.                                                                       |
| D5  | Rename the one key outside the namespace, `polishModel`, to `helperModel`                                                                                                                                                                                   | **Before the storage freeze** | Rename once, with a changelog line. The cost is one reset of the helper-model choice.                                    |
| D6  | Ratchets: allow deleting a baseline that was empty at the base when its rule is on an exported zero-rules list. Separately, measure counts against the merge base instead of committing them (`check-ratchet-baselines.mjs:17-18` makes both an owner call) | Ratchets, slices R1 and R4    | Zero-rules list now. Base-relative counts as a follow-up ruling.                                                         |
| D7  | Drop the extension's per-run latexdiff math-markup prompt in favour of the setting ("one home per action")                                                                                                                                                  | Hosts, slice H4               | Drop it.                                                                                                                 |
| D8  | Background mode for Responses: drop `backgroundOn`'s `modelName.startsWith('gpt')` check (`binding.ts:63-75`), or move it into `responsesConfiguration.ts`                                                                                                  | llm, slice M2                 | Move it to the route configuration if it is intended.                                                                    |
| D9  | The row-reader baseline: exempt the store layer (`Database`, `rowCodec`, `rowReader`, `SessionEvents`) by name                                                                                                                                              | Storage, after slice S6       | Yes. It re-scopes the baseline; it does not widen it.                                                                    |
| D10 | #13826: revisit the 2026-10-06 ruling, so that picker hints, coding plans and account labels become copy keys now                                                                                                                                           | Harness surface, slice V4     | Yes, using the script-stage key pattern.                                                                                 |

Only D4 and D5, plus the `run.start` shape change (§2), change stored
bytes. The run-lifecycle redesign does not: an activation already has a
durable id (§1).

## 1. Run lifecycle: one owner each for activation, liveness, stop, end and parent

Survey items 1, 3 and 4.

**Correction to the survey.** No activation id is needed on the rows. The
commit number of a run's `run.start` or `run.activate` row already
identifies the activation durably. `lostResultId(runId, since?.commit)`
already uses it that way (`agent/storage/runLifecycle.ts:364-365`). A new
id field would duplicate a derived fact (rule R1) and would be a row
change gated on the freeze.

| Concern                    | Single owner                                                                                                                                                                                                                                                                                                                               | Deletes                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which activation           | In process, the run's `Fiber`. Stored, the commit number of the row that opened the activation. `onAdmitted` fires after that row commits and passes its commit number. `handOver` skips view updates until `cursor ≥ commit`, then joins the fiber.                                                                                       | `handOver`'s `cancelled` and `isCancellationRequested`. `resumeRun` becomes interruptible outside its atomic steps.                                                                                                                                                          |
| Liveness, in process       | One record per run in `RunRegistry`: `{ fiber, kind: 'run' \| 'hold', launchParent, detached, stop?, controls? }`                                                                                                                                                                                                                          | The `handle`, `activation` and `unbornDetached` slots, and handle-presence liveness checks (`ExecutionsTool.ts:422,448`)                                                                                                                                                     |
| Liveness, across processes | One session `Layer` serving `SubscriptionRef<ReadonlyMap<OwnerId, OwnerLiveness>>`. A `dead` answer is final. `alive` and `unprovable` are checked again on each proof.                                                                                                                                                                    | Five separate probes: claim read `Database.ts:843-856`, write proof `storeAside.ts:89-113`, the 5-second checker's own cache `ownerLiveness.ts:58-96`, `prepareRunRemoval` `Database.ts:905-910`. Only the sessionless cold read (`readSessionView.ts:120`) probes directly. |
| Stop                       | `Fiber.interrupt` on the run fiber, for every kind of run. The stop reason is data on the activation record, not a second signal. Foreign SDKs get a signal derived from interruption via `Effect.tryPromise({ try: (signal) => … })`. `claudeAgent.ts` links its controller to that signal.                                               | `ChildLoop.controller`, `userStopped`, each strategy's `signal` parameter, the `onAbort` race, and `entry.stopReason` being cleared by the next activation                                                                                                                   |
| End                        | One exit handler per run fiber: `uninterruptibleMask` → `Effect.exit(restore(body))` → `endActivation(exit, stop, policy)` → `finalizeRun`. Child behaviour (budget permit, `finishTurn`, last turn, stop notice, pause, owned process ids) is a policy value. An end with no fiber here runs the same `endActivation` over an empty step. | `ChildRunActivation`, `reserveChildActivation`, `interruptActive`, `endNative`, `endRunOutsideLifecycle`, the activation-level `keepExistingOutcome`, `finalizeChildRun`'s separate terminal, and `deliverOne`'s direct `endIn` call                                         |
| Parent                     | Two named readers. `launchParent` is fixed, from `run.start.parent`, and exposed as a derived `launchParentId` on the view. `attachedParent` is `view.parentId`, or `parentEdgeOf` inside a writing job. The loop captures the attached parent once per activation on `AgentRun`.                                                          | `RunRegistry.parentOf` and its fallback chain (13 call sites in 7 files), and `LiveRun.parent`                                                                                                                                                                               |

**The `AbortController` ruling (D1).** The ruling keeps the controller
because the loop's stop must not interrupt its fiber: the turn's
settlement, parent delivery and finalization run after it. That holds
under fiber interruption today:

- `endChildLoop` is `Effect.onExit` plus `uninterruptible`
  (`childRunLoop.ts:800-889`).
- Native children already rely on it: `ChildLoop.interrupt` aborts the
  controller and also interrupts the run fiber (`:308-313`), which is a
  live dual system.
- The only interrupted turn whose value matters is background bash
  (`deliverAfterInterrupt`, `bash.ts:283`). It already buffers its own
  output, so an `interruptedTurn()` on the strategy rebuilds the result.

The derived per-promise signal is not the "second cancellation tree" the
ruling forbids, because its only source is the fiber interrupt. Root runs
already stop this way (`AgentRunLifecycle.ts:435-460`), so roots and
children converge.

| Slice | Change                                                                                                     | Net LoC | Closes                                  |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------- |
| L1    | `handOver` waits on the activation's commit; a resumed child returns `Fiber.join`                          | +10     | #13994, #14003                          |
| L2    | Session owner-liveness service                                                                             | +5      | the 5-second disagreement               |
| L3    | Stop is the fiber interrupt. The ledger amendment and the ESLint residents list change in the same PR (D1) | −90     | —                                       |
| L4    | One end step, with `ChildLoop` passed to it as a policy                                                    | −300    | the `childRunLoop.ts:809` use in #14312 |
| L5    | Two parent readers (D3)                                                                                    | −60     | #14242                                  |

The gate for L3 and L4 is the crash-point conformance suite. Still
unconfirmed on Effect 4.0.6: that `tryPromise`'s signal aborts on
interruption, that `executeCommand` tears down the process group under
interruption, and that `transact` returns the commit number `onAdmitted`
needs.

## 2. Storage: one owner per stored run fact, and the shape changes before the freeze

Survey item 2.

**Owner.** The pure reducer in `shared/session/runRows.ts`
(`applyRunRow` / `runRowsFrom`) owns lifecycle and record facts, extended
with `lifecycle`, `parent`, `grants`, `heldParks`, `latest` and
`childTurn`. `RunState` owns facts that come from history rows: call
issuer, script calls and reuse keys. `RunView` copies from both. The
store's columns (`closed_by`, `start_commit`, `parent_id`) remain the one
owner of "open", "exists" and "collected with", as the storage design
rules.

Access is one `SessionLog.facts(runId)`, typed as
`Effect<RunRows | null, DatabaseReadFailed>`. It replaces
`SessionLog.records`, which is deleted in the same PR. Live readers use
the `SubscriptionRef` in `SessionViewService`, and commit triggers use
`Stream.filter`.

**Rejected alternatives.**

- SQL views or generated columns over `event.data`: rejected by the
  storage design's "nothing below the codec reads a payload field"
  (`storedShapeBoundary.vitest.ts`), and blob references are unreadable in
  SQL. The hosts need the reducer anyway, so this would be a second
  system.
- A projected `run_facts` table: a cache of the reducer; reopen it only
  if a cold listing measurably exceeds its budget.
- `RunView` as the owner: it puts loop-only facts on the host wire.

**Dual systems removed.**

- The "current activation ended" rule is decided in seven places:
  `runFacts.ts:195-252`, `Inbox.ts`, `runLaunchGuard.ts`,
  `sweepLeftoverRuns.ts`, `runLifecycle.ts`, the view, and the history
  query's `runs` view (`historyQuery/views.ts:34-71`).
- Parent after detach is computed three times: `runRelation.ts`, the view,
  and a SQL `CASE`.
- "Closed" and "exists" come from columns in one place and from row types
  in another.
- The title rule is written three times: the view, `forkRun.ts`, and SQL.
- Model and usage are computed three ways.
- The grant rule (`runApprovalQueue.ts`, `approvalBypassKind.ts`) and the
  call-issuer mapping (`SelfTool.ts`, `PlanTool.ts`) are each written
  twice.
- `RunView.facts` exists, yet the app re-reads plugin-fact rows.
- The history query's `runs` view becomes a table filled from `RunView`.
  Its lifecycle, parent and title SQL is deleted.

**Stored shapes.** These land in one PR, as per-kind version bumps in
`rowVersions.ts`. Nothing is frozen yet (`config/storage/frozen/` does not
exist), so they need no upcaster.

- `run.start` v2: `parent: { id, uid, call: { callId, card } | null }`.
  The top-level `parentCard` is dropped. The card is not redundant with
  the call id, because providers may reuse a call id (`SelfTool.ts:95-99`).
  `RegisterRunOptions` takes one `parentCall`.
- If D4 is accepted: `followup.queued` v3 and `log` v3 store
  `media: { name, mimeType, digest }[]` in place of `mediaFiles` paths.
  #14258 found no row carrying base64, so it can close as not planned.

**Golden store (#14260).** The race is in the guest script, not the
generator. `GOLDEN_SCRIPT_SOURCE` (`run/validationModel.ts:62`) runs
`read_file` and `bash` in a `Promise.all`, so their rows commit in
finishing order. The normalizer numbers ids by first appearance, which
spreads the swap to every later reference. The fix:

- Run the two calls in sequence. `GOLDEN_CRASH_SOURCE` keeps its
  `Promise.all`, so concurrent commits stay covered.
- Number ids by (aggregate creation order, seq).
- Add a `--twice` check that generates twice and compares.

| Slice | Change                                                                                                                               | Before freeze         | Net LoC                | Baseline entries removed |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ---------------------- | ------------------------ |
| S0    | Golden determinism                                                                                                                   | yes                   | +35                    | 0                        |
| S1    | Lifecycle, parent and held parks into `runRows`; `runFacts` lifecycle helpers and `runRelation` merged                               | preferred             | −80                    | ~18                      |
| S2    | The stored-shape PR above, plus golden regeneration                                                                                  | **must**              | −15, or +60 with media | 0                        |
| S3    | `SessionLog.facts` replaces `records`; `runRecords`, `resumability`, `runListing`, `forkRun`, `SelfTool` and `AgentRun` move onto it | safe after the freeze | −90                    | ~18                      |
| S4    | Grants and request state into the reducer                                                                                            | safe after            | −30                    | 9                        |
| S5    | Call issuer, script calls and reuse keys onto `RunState`                                                                             | safe after            | −40                    | 8                        |
| S6    | "Closed" and "exists" from columns; the history query's `runs` becomes a table filled from `RunView`                                 | safe after            | −70                    | ~8                       |

End state: 88 entries in 45 files fall to about 29 in 20, or about 21
with D9.

## 3. Hosts: one way to attach a window, one approval store, one run-action policy

Survey items 5 and 6. The pass corrected the survey in three ways:

- Staging is built four times, not three. The service's `hostWindows.ts`
  keeps its own `staged` map.
- Only pack differs between the hosts, not clean.
- VS Code reads the diff editor's possibly-unsaved buffer, not a backing
  file.

**Dual systems found.**

- Two attach paths: a local session uses `attachSessionHost` and
  `editors.attach`, a service session uses `attachWindowHost`.
- Two routing rules for host calls: `SessionHostInteractions` picks the
  newest attachment (`HostInteractions.ts:297`), `HostWindows` the window
  focused last (`hostWindows.ts:162-172`).
- Four tool-edit staging stores, with two ways of detecting that a request
  is settled.
- Two reads of edited content: approve-all asks the host, the button reads
  the edit itself.
- Two preview sources.
- Run-action policy written for the GUIs and again for the CLI.
- Route labels written twice.
- Transcript-export input built twice.
- The onboarding refresh done two ways.
- Neither GUI implements `approvalDenied`, so a gate the policy closes is
  silent there.

**Target.**

- **One attach path.** `HostWindows` becomes a `Context.Service` built
  with `Layer.effect` on every process runtime, not only in `texra serve`.
  A local session is adopted in-process through a constant
  `SubscriptionRef` link, so every host attaches through
  `attachWindowHost(link, workspace, capabilities, focused)`, with one
  routing rule. `texra serve` cannot be the only path: it does not run on
  Windows (`client.ts:76`), and windows fall back to local.
- **One window builder.** `openGuiWindow(ports)` is an `Effect.fn` that
  needs `Scope`. It has two callers and real logic. The bridge gets a
  `Scope.fork` child whose close is detached, so the drain outlives the
  window. Export is built through `Effect.cachedWithTTL`, and the outage
  stream is consumed with `Stream.runForEach` plus `forkScoped`.
- **The settled router layout stays.** The 2026-09-17 refutation of "two
  host-request routers" still holds: both routers and their binding
  tables remain. The new evidence shows something else, policy filed
  under capabilities. That policy moves into the shared body: help and
  docs URLs into `@ui/copy`, the "no longer open" export refusal,
  `showError` rejecting everywhere, `fileOpResultMessage` for pack, and
  the preview `dispose` always awaited.
- **One approval store, transient.** The harness session holds a
  `SubscriptionRef<HashMap<requestId, { request, edited }>>`.
  - `toolEditApproval.ts` stages with `Effect.acquireUseRelease` around
    the request's lifetime, so there is no pruning and no `seen` flag.
  - `request.preview` answers from the store. A new `request.edit`
    request goes through the command door and is refused once the request
    is no longer pending.
  - An approval without content takes `edited ?? proposed`.
  - The durable fact stays `request.decided.decision.content`, so the
    event table keeps one publisher and the storage format does not
    change.
  - Hosts follow pending requests with one `followPendingRequests` helper
    over a `FiberMap` keyed by request id. Its four callers are the GUI
    controller, the headless adapter, the TUI and the foreground-approval
    announcer.
  - The window handoff in `hostWindows.ts:258-263` is deleted, because any
    window reads the same store. That closes #14009 by construction.
- **One run-action policy.** `controllers/session/runActionPolicy.ts`
  holds plain functions over a `Session`:
  - `resumeRun` returns a `Run`, `'waiting'` or a `RequestRefusal`.
  - `forkRun` returns a `RunId` or a `RequestRefusal`.

  `HostRunActions` and the CLI's resume, `/resume all` and `/fork` all
  call it. `usageRouteBadge` becomes the single source of route labels,
  and `formatCliModelAccessRoute` is deleted.

| Slice | Change                                                                                                                                                              | Net LoC | Closes                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------ |
| H1    | Approval store in the harness, `request.preview`, `request.edit` and `followPendingRequests`. The CLI and service staging move onto it. GUI staging stays until H2. | −250    | —                        |
| H2    | GUI tool-edit view over the store. Delete `attachSessionHost`, the three tool-edit verbs and the handoff, and bump `PROTOCOL_VERSION`                               | −600    | #14009, staging duals    |
| H3    | `HostWindows` in-process for local sessions                                                                                                                         | −120    | attach and routing duals |
| H4    | `openGuiWindow` plus the drift fixes (D7)                                                                                                                           | −300    | all listed drift         |
| H5    | `runActionPolicy` adopted by the CLI; route labels                                                                                                                  | −120    | policy and label duals   |

## 4. Tests and ratchets: one setup mechanism, one way into the harness, one budget scheme

Survey item 7, and the ratchet bookkeeping it listed as ranked lower.

**Dual systems found.**

- Five test-setup mechanisms:
  - the setup file's `beforeAll`;
  - `setupPlatform()` per test, used by 38 suites;
  - direct `installFakeHost`;
  - import-time side effects in `sessionGraphTestSetup.ts` (top-level
    await) and `defaultSessionTestSetup.ts` (`Effect.runSync`);
  - `it.layer`.

  On top of these, `testProcessRuntime.ts` is a module-global runtime slot
  with two writers.

- `no-explicit-any` is enforced by both an ESLint error and an empty
  core-quality baseline. So is `effect-run`.
- `host-agent-mock-baseline.json` has no consumer. It survives only
  because a baseline file may not be deleted.
- "Never widen" is checked twice: once by each checker against its own
  JSON, and again by `check-ratchet-baselines.mjs` against the merge base.

**How a test reaches the harness.** A published
`@texra-ai/harness/testing` entry is already ruled out until a named
external consumer exists. A private barrel would be a pass-through, a
second way in. Target: a suite imports public entries plus its own
subject, the module its path mirrors. Everything else comes as layers
from `@test/support`, which, as the test composition root, keeps its own
deep-import row.

- 295 of 590 named deep imports (50%) already ask only for names the
  public entries export. 65 of 182 deep-importing suites can switch with a
  codemod today.
- Most of the rest are seams the general-package design removes:
  `SessionHandle` (28), `humanGrant`, `registryOf`, `RunHistory`, `Runs`.

**Setup.** `support/testKernel.ts` holds three `Layer`s, built per
`describe` with `@effect/vitest`'s `layer(L)` / `it.layer(L)`:

- `FakeHost.layer` is `Layer.effect` over today's `installFakeHost`.
- `SessionGraph.layer` is `processLayer(...)`, with no `ManagedRuntime`
  and no slot.
- `TestSession.layer` acquires an ephemeral session with
  `Effect.acquireRelease` and returns the public `LocalSession`.

The four setup modules, the hooks and the `REACHES_A_HOST` support
patterns are then deleted. A lint rule forbids module-scope `await` and
`Effect.run*` in `src/test-kernel/support/**`, with no baseline.

**Ratchets.** The end state has one scheme and one never-widen authority:

- A finished rule is a lint error or a hard-coded zero, with no file.
- Named exceptions are committed shrink-only allowlists: refuted
  candidates, row readers, knip, deep imports.
- Numeric budgets are measured against the merge base.
- `file-size` caps are rounded up to the next 25 lines and never rise, so
  `--update` stops rewriting them. Today any `--update` run for any rule
  lowers every cap to the exact line count.

| Slice  | Change                                                                                               | Net LoC        | Effect                                                            |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| A1     | Codemod: 295 imports onto public entries                                                             | ~600 churn     | fewer conflicts with the package moves                            |
| A2     | `src/test-kernel` and `support` rows in the deep-import ratchet; support lint                        | +40, +190 data | growth is fenced                                                  |
| A3     | `testKernel.ts` layers; cli, controllers and desktop suites converted. Starts a dual that A5 removes | +100           | —                                                                 |
| A4     | tools and agent suites                                                                               | ~1,000 churn   | —                                                                 |
| A5     | Last suites; delete the four setup modules, the hooks and `REACHES_A_HOST` entries                   | −400           | dual removed                                                      |
| A6     | Shared registry for everything except DOM and `vi.mock` suites                                       | ~30 config     | isolated suites 172 → ~55; Linux shards ~10 → ~4-5 min (estimate) |
| R1     | Delete the empty and duplicated baselines; zero-rules list (D6)                                      | −150, 9 JSON   | —                                                                 |
| R2     | `file-size` caps rounded to 25 lines                                                                 | +20            | most `file-size` churn gone                                       |
| R3, R4 | Base-relative core-quality counts (D6); delete the count JSON, `--update` and `--move`               | −350           | no commit touches counts                                          |

Land A1 and A2 before the general-package moves. Run three shuffled runs
before A6.

## 5. The harness boundary: vocabulary as data, one way to supply each piece

Survey item 8. This pass validates and deepens the
[general-package design](./2026-10-21-harness-general-package-design.md);
it does not replace it.

**Stored bytes stay the same.** Config keys live in the user's
`.texra/config.json`. State keys are rows in `current_value`, version 101,
which is already the 1.0 baseline. Renaming a stored key silently resets
that user's setting, so no stored key's bytes change (except D5).

| Piece                      | The one way it is supplied                                                                                                                                                                                                                                                          | Effect primitive                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Setting rows and namespace | `settingsCatalog({ namespace, rows })`. The namespace is required and reaches the harness only through `ConfigProvider.catalog`. Keys in code are relative (`'memory.enabled'`). The namespace is added at exactly two places: the config providers and `appStateStore`'s `rowKey`. | The platform port given to `Sessions.layer`                        |
| Team presets               | `AgentDirectoriesPort.teams`                                                                                                                                                                                                                                                        | The existing `AgentDirectories` `Context.Service`, `Layer.succeed` |
| Prompt fragments           | `Plugin.prompt` on TeXRA's `core` plugin                                                                                                                                                                                                                                            | The plugin list                                                    |
| Copy                       | Typed keys in view rows, with the words in `@ui/copy`. Nothing injected                                                                                                                                                                                                             | —                                                                  |
| Command search directories | `AgentPlatform.commandDirs`, served as `CommandDirs`                                                                                                                                                                                                                                | `Layer.succeed`                                                    |
| Validation model           | A `ValidationModel` service that only the CLI provides, read with `Effect.serviceOption`. When absent, the route fails loudly                                                                                                                                                       | `Context.Service`                                                  |

**Dual systems removed.**

- The `texra.` prefix is written in three places: `configKeys.ts:7` and
  `stateSettings.ts:483,926`.
- Two spellings of one key are accepted, with or without the prefix
  (`stateSettings.ts:926`, `interfaces.ts:76`).
- Key constants restate their rows' keys.
- There are two default sources: the catalog default and the caller's
  `defaultValue`.
- There are three preset lists: `WorkspaceAgentsController.allPresets()`,
  `cliTeams.ts` and `TeamsTab.ts`.
- Host Effect code reads the `TEXRA_SETTINGS` constant beside
  `config.catalog`.
- `AppSignals`' `let hub` module global must become a process
  `Context.Service` before it goes public (#14313). Publishing it as it is
  would publish a global.

**Public surface (sampled).** Of the 306 undocumented exports:

- About 133 are internal. They are no contract and only need TSDoc.
- Of the public ones, about 56 have no consumer outside the harness and
  can leave the entries (check `forgotten-exports` first).
- 32 are host-only and belong on `./host`.
- 39 are app-only and move with their vocabulary.

That leaves about 60-80 to document before publishing 0.x.

| Slice | Change                                                                                                                                                                                                                     | LoC touched     | Closes                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------ |
| V1    | Namespace on the catalog; relative keys; delete `configKeys.ts` and `defaultValue`; hosts read `config.catalog`. One mechanical PR                                                                                         | ~700 (−100 net) | #14179 (persisted names) |
| V2    | Presets to `packages/texra` via `AgentDirectories.teams`; the onboarding keys move; `ONBOARDING_DEFAULT_TEAM_ID` member renamed `ACTIVE_TEAM_ID` with the same stored value; one preset list; the icon widened to `String` | ~350            | #14321                   |
| V3    | Math instruction to the `core` plugin's prompt; neutral model text (`validationModel.ts:116` changes in the same PR)                                                                                                       | ~50             | #14179 (prompts)         |
| V4    | Script-stage notes become copy keys (D10 extends this)                                                                                                                                                                     | ~60             | #14179                   |
| V5    | `CommandDirs`; TeX paths, `binaryResolver` and `probeTool` to the app; `./node` drops them                                                                                                                                 | ~450 moved      | —                        |
| V6    | Validation model to the CLI via `ValidationModel`                                                                                                                                                                          | ~600 moved      | —                        |
| V7    | `SettingsViewSnapshot` tab ids typed by the app                                                                                                                                                                            | ~40             | —                        |
| V8    | GitHub signals to the GitHub plugin's own service as a `Stream`; `AppSignals` becomes a `Context.Service`, then public                                                                                                     | ~200            | #14313                   |
| V9    | Surface pass                                                                                                                                                                                                               | ~300 TSDoc      | —                        |

Before publishing 0.x: V1, V2, V5, V8 and V9.

## 6. `packages/llm`: one lifecycle, one error path, one capability owner, one wire-test mechanism

Survey item 9.

**Dual systems found.**

- `enrichModelError` (overwrites fields) sits beside `fillModelError`
  (fills empty ones) in `errors.ts:213-238`, and three sites use the
  overwriting one.
- "Is background allowed" has six owners. They already disagree: Google
  exposes `background` with `store` off while `backgroundCapable` says no.
- Deadlines are handled three ways.
- A malformed `ResolvedTurnSchema` raises a defect in two providers and a
  typed error in the third.
- Offline wire tests use three mechanisms: a hand-built SSE stream, a
  scripted `ws` server, and the live matrix.
- llm-zoo is declared by four packages and imported directly by 22 files,
  next to `@texra-ai/llm`, whose public API already names `ModelConfig`
  21 times.

**Target.**

- **Background lifecycle.** One `backgroundLifecycle(wire)` in a new
  `api/background.ts` (`transport.ts` is near its 400-line cap):
  - `Ref` holds what the lifecycle learns.
  - `admitObservation` returns a `Duration` read once from `Clock`.
  - The deadline is one `Stream.interruptWhen(Effect.sleep(remaining) …)`.
  - Polling is `Effect.repeat` with `Schedule.spaced`.
  - Error filling is one `mapError` with `fillModelError`.
  - `Scope` owns the local request.

  Each provider supplies only `submit`, `observe` (`poll` or `stream`),
  `cancel` and `finalize`. A local interrupt must not cancel remote work:
  the README contract and the detach case depend on that.

- **Turn preparation.** `resolveTurn(...)` in `turnInput.ts` owns the
  decode, the refusals and a typed `ResolvedTurnSchema` decode for all
  three providers.
- **Background capability.** It has one owner: a factory attaches the
  `background` member exactly when `backgroundCapable(config)` holds.
  `Binding.background` is the member's presence, and the harness's
  `backgroundOn` keeps only the user's toggle (D8).
- **llm-zoo.** `@texra-ai/llm` re-exports the types and values its
  consumers use. llm-zoo is pinned exactly in `packages/llm` only, and a
  `no-restricted-imports` rule forbids it elsewhere.
- **Wire tests: the live matrix is the contract suite, replayed.**
  - `test-live/cassette.ts` records exchanges under `LLM_RECORD=1`.
  - One pure-tier `WireContract.vitest.ts` replays every live case.
  - Error and truncation cases are declared transforms over recorded
    bytes, one per protocol, never invented data.

  This respects #14315's deliberate cut ("remove useless and low valued
  tests aggressively"): the suite adds no happy-path assertions, only one
  row per failure mode (codec, usage, continuation, abort, 401, 429
  retry-after, truncated stream, background accept and complete, cancel
  confirmation, upload release).

| Slice | Change                                                                        | Net LoC                |
| ----- | ----------------------------------------------------------------------------- | ---------------------- |
| M1    | One error-fill path; README line count fixed                                  | −10                    |
| M2    | One background-capability owner (D8)                                          | −25                    |
| M3    | `api/background.ts` lifecycle                                                 | −190                   |
| M4    | `resolveTurn`                                                                 | −35                    |
| M5    | llm-zoo re-export, exact pin, lint rule                                       | −5 (22 imports change) |
| M6    | Cassettes, replay mode, new live cases for background, cancel, upload and 401 | +200 + cassettes       |
| M7    | Mutation rows; hand-built SSE helpers and cases deleted                       | −900                   |
| M8    | WebSocket relay recorder; scripted `ws` server deleted                        | −150                   |

Offline test code drops from 1,485 lines to about 450. Cassettes never
record request headers, an allowlist filters response headers, and a grep
gate fails on `sk-`, `Bearer` and `AIza`.

## 7. The tool dispatcher: one per-call program, terminal rows guaranteed by the program

Survey item 10.

**Dual systems found.**

- **Ordering, twice.** Replay ordering is a Deferred chain
  (`toolUseDispatch.ts:724-736, 910-915`), separate from the scheduler's
  own slots.
- **Stage rows, two paths.** Script stage start and end go out through
  `log.publish` (`:744, 759`), outside the batches that carry the cards.
  `runTrace.ts:125-141` closes leftover stages as a third closer. The
  "Tool-use turn" stage (`toolUse.ts:410`) also uses `publish`.
- **Terminal rows, four ways.** A call reaches its terminal row through:
  - the hand-called `settleAbandoned` sweep (`:916-946`, from
    `ScriptTool.ts:278-284`);
  - `resumeCall`'s skips;
  - the sandbox `FiberSet` interrupting calls without writing a row;
  - `moveBoundary` marking open cards failed at read time
    (`transcriptUpdate.ts:289-300`), which compensates for missing rows.
- **Captured context.** `Effect.context` plus `Effect.cached` plus three
  `provideContext` calls, so the script's finalizer runs after the
  script's own result.

**Target (shape A).**

- `loop/toolCall.ts` holds an explicit per-attempt record and
  module-level `Effect.fn`s: `executeCall`, `resumeCall`, `skipCall` and
  `endUnsettled`. They take `{ cell, step, responseId }` as data, with
  `AgentRun` and `ToolRegistry` from context.
- `loop/callScheduler.ts` is the one scheduler. It takes the replay list,
  so the response path passes `[]`.
- `loop/scriptCalls.ts` is the script's door: an
  `Effect<ScriptDoor, never, Scope>` built in the tool body's scope. It
  owns a `FiberMap<callId>` of the nested calls.
- One `Effect.addFinalizer((exit) => …)` on that scope ends what the
  script left. On any exit that is not an interrupt (the guest returned or
  threw, the deadline, a sandbox fault), it applies `endUnsettled` to
  every call it still holds, live or recorded by an earlier process, and
  then the `FiberMap` closes. On an interrupt it writes nothing and leaves
  the rows for the resume, as today. The scope guarantees the end; no
  caller has to remember a sweep.
- Stage rows ride the batches: `stage.start` with the script's intent
  batch, `stage.end` with its result batch.
- `shared` values get typed `Context` keys over `Deferred`s, which removes
  the two type assertions. This is to confirm on 4.0.6.

The two-caller requirement holds: `resumeCall` (`:863`, `:997`),
`skipCall` (`:690/696`, `:935`) and `makeScheduler` (`:737`, `:953`).

**#14254 is fixed, not open.** #14253 (`4c8dcfc`) settles a call the
script left running before the script's result commits.
`ToolUseDispatchParallel.vitest.ts:366` pins it. What stays without a
terminal row is the whole run being interrupted, and that is by design:
the rows stand for the resume, `ToolUseDispatchInterruption.vitest.ts`
pins it, and the transcript marks still-open cards as cut by the run's
end. So T5 is a structural change, a scope-owned end in place of a
hand-called sweep, and it preserves today's behaviour. Writing terminal
rows on interrupt too is the optional D2.

| Slice | Change                                                                                                                                                                                                        | Net LoC | Baselines                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| T1    | Shape A split, no behaviour change                                                                                                                                                                            | +40     | `file-size` entry for the 1109-line file goes; max-lines 4 → 1                           |
| T2    | One scheduler with the replay list                                                                                                                                                                            | −25     | ordering dual removed                                                                    |
| T3    | Stage rows in the batches; `log.publish` calls and the `stageOpened` Ref deleted                                                                                                                              | −20     | the script's stage dual removed                                                          |
| T4    | Typed shared keys                                                                                                                                                                                             | −10     | type-assertions 2 → 0                                                                    |
| T5    | Scope finalizer plus `FiberMap`; the sweep (`toolUseDispatch.ts:916-946`), `ScriptDoor.settleAbandoned` (`RunCall.ts:115-121`), `ScriptTool.ts:270-284` and the context capture deleted. Behaviour-preserving | −50     | terminal-row and context duals removed (`moveBoundary` stays for interrupts and crashes) |

## Order of work

1. **Before the storage freeze:** S0, then S2 (with D4 and D5 decided).
   S1 is preferred before S2, because it shrinks S2 to the reducer and the
   launchers.
2. **Live bugs, small and independent:** L1 (#13994, #14003), L5's
   #14242 fix (can land ahead of L5), and H1 + H2 (#14009).
3. **Before the general-package moves:** A1 and A2. They make the moves
   cheaper.
4. **Before publishing 0.x:** V1, V2, V5, V8, V9 and M5.
5. **Everything else** in the slice order of its section. Every slice
   removes what it replaces.

Every slice above is behaviour-preserving except L3, L4, H2 and H4. Each
of those changes behaviour named in its owner decision or in its section.
