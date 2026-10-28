# The ten most costly tech debts, 2026-10-27

Date: 2026-10-27
Status: proposed — survey only; no code change in this note.
Baseline: `main` at `d8a4f66`.

How this was made: five read-only lanes (agent runtime, session and storage,
hosts, `packages/llm`, tests and the harness boundary), each asked for its
three or four costliest structural debts with file and line evidence. Their
main claims were spot-checked against the tree. Candidates were ranked by
three questions: does it cause open bugs today, does every new feature pay
for it again, and does it get more expensive once the storage format freezes
(#13736). Line numbers point into `d8a4f66`.

The design for each item, Effect-native and with one mechanism per
concern, is in
[the target designs note](../architecture/2026-10-27-tech-debt-target-designs.md).
It corrects this survey in places; the corrections are marked below.

The first four share one cause. A run's identity, liveness, parent and end
each have several owners. Correction: only item 2's shape cleanups change
stored bytes. An activation is already identified by the commit number of
its opening row, so items 1, 3 and 4 are refactors that need not wait for,
or block, the freeze.

## 1. A run's activations have no identity, and "is it live" has many answers

- `RunEntry` in `packages/harness/src/agent/runtime/runRegistry.ts:117-135`
  counts a run as live if any of five slots is set or its launch counter is
  nonzero. Three private predicates read it, plus `LiveRun.live`, the view's
  `isLiveRun`, `session.log.owns`, and "a handle exists" in
  `packages/harness/src/tools/ExecutionsTool.ts:422,448`.
- One process-liveness check
  (`packages/harness/src/agent/storage/leaseOwnerLiveness.ts`) is run and
  cached separately in five places (the design pass found
  `prepareRunRemoval`, `Database.ts:905-910`). The others are the claim read in
  `packages/harness/src/controllers/session/Database.ts:198-202`, the
  write-time proof in `packages/harness/src/controllers/session/storeAside.ts:89-110`,
  the 5-second checker in `packages/harness/src/controllers/session/ownerLiveness.ts`
  (which feeds the view's `interrupted` group), and a cold-read probe. Auto-resume
  (`packages/harness/src/tools/interruptedTasks.ts`) reads the claim. The
  notice list (`packages/texra/src/ui/copy/interruptedTasks.ts`) reads the
  view. The two can disagree for up to 5 seconds.
- Nothing names an activation. `stopReason` is cleared by the next one, and
  `handOver` in `packages/harness/src/effect/runHandle.ts:233-235` returns on
  the first `durableOutcome` it sees. That can be the previous activation's
  outcome (#13994).

Fix direction: `handOver` and the registry wait on the activation's
commit number, which the rows already carry. `lostResultId` already uses
it that way (`runLifecycle.ts:364-365`). Use one session-scoped
owner-liveness map, filled by the checker and read by the claim and the
write proof. No row changes.

## 2. Code outside the owners reads rows: 88 entries in 45 files

`config/ratchets/row-readers-baseline.json` lists 23 durable row types that
are read outside their reducers: 88 file entries across 45 distinct files.
`run.start` alone has 20 readers and `run.removed` has 10. The biggest is
`packages/harness/src/agent/storage/runRecords.ts`, which reads six types;
others include `resumability.ts`, `runListing.ts`, `runLifecycle.ts`,
`sweepLeftoverRuns.ts` and `Database.ts`.

Once the format is frozen, each stored-shape change means a migration plus
an audit of up to 20 readers that each derive the row's meaning themselves.
Several pre-freeze shape cleanups are still open:

- `run.start.parentCard` and `run.start.parent.callId` both name the
  launching call, written together by every launcher. The card is not
  redundant (a provider may reuse a call id, never a card), so the fix is
  one field holding both
  (`packages/harness/src/shared/schemas/sessionEvent.ts`; 21 references
  in 11 files). See item 1 of
  [the durable-harness residue note](./2026-10-03-durable-harness-residue.md).
  Correction to that note: `descriptionBy` does have a reader,
  `forkRun.ts:205`.
- Pasted media is referenced by workspace path, not by blob digest (#13874,
  #14258).
- The golden store, the freeze's "every later build must read this" check,
  regenerates differently each time (#14260). That makes a real format
  change hard to see in review. The cause is the guest script the generator
  drives, not the generator. `GOLDEN_SCRIPT_SOURCE`
  (`packages/harness/src/agent/runtime/run/validationModel.ts:62`) runs two
  tools in a `Promise.all`, so their rows commit in finishing order.

Fix direction: move the `agent/storage/*` readers and `sweepLeftoverRuns`
onto `packages/harness/src/shared/session/runFacts.ts` or `RunView` until
the baseline holds mostly the store's own structural checks. Make the
pending shape changes in one storage-version change, and make the golden
generator's output the same on every run.

## 3. Two systems stop and end runs

Root runs end through `runWithLifecycle` and `finalizeRunTerminal` in
`packages/harness/src/agent/runtime/AgentRunLifecycle.ts`. Child loops end
through the `ChildLoop` class in
`packages/harness/src/agent/runtime/childRunLoop.ts:271-852`, which has its
own `AbortController` (line 272), ten mutable fields, and its own end steps.

- One row builder, `finalizeRun`, writes `run.end`. About seven call sites
  decide when to call it, across `AgentRunLifecycle.ts`, `runRegistry.ts`,
  `runLaunchGuard.ts` (`endRunOutsideLifecycle`), `childRunLoop.ts`,
  `childRun.ts` and `sessionLayer.ts`. A native child can reach two of them,
  and `keepExistingOutcome` decides which one wins.
- "A stop beats a failure" is computed again in four places. #14312 lists
  further `hasInterruptsOnly` checks that disagree with `outcomeFromCause`.
- Stop state lives in `RunEntry.stopReason`, `ChildLoop.userStopped`,
  `controller.signal`, `handOver`'s `cancelled` and
  `isCancellationRequested`. A stop reaches a run either through
  `activation.interrupt()` or through a fiber interrupt.
- #14003: in `packages/harness/src/agent/runtime/resumeRun.ts:312-339` only the root branch sets
  `rootCompletion`, so an SDK resume of a background child fails with "has no
  result of its own".

Fix direction: use one stop signal, the fiber interrupt, with process
children listening to it instead of an `AbortController`. Give each
activation one end step, and pass child-specific behaviour to it as a
policy, so a resume returns one completion for any kind of run.

## 4. A run's parent has five readers with different meanings

The parent is fixed at launch (`RunHandle.launchParent`), live
(`RunRegistry.parentOf`, `runRegistry.ts:300-308`, which falls back across
the view, an in-memory `unbornDetached` set and the activation), stored
(`persistedParentRunId` and `owningCall` in
`packages/harness/src/agent/storage/runRecords.ts`), or read raw from the
view (`packages/harness/src/tools/delegation/agentChild.ts:251`). `parentOf(` has 13 call sites in 6 files.

- `AgentRun.ts:211` computes `root` once, but `toolUse.ts:155` checks
  `isChild()` on every pass, so the two can differ after a detach.
- The header of `ExecutionsTool.ts` says it never resolves parentage a
  second time. Its own fallback at lines 455-457 does.
- Bugs caused by this: #14242 (`agent()` reuse uses the live link) and
  #14003. #14201 already patched two other call sites one at a time.

Fix direction: two named readers, `launchParent` (fixed at `run.start`) and
`attachedParent` (from the rows, with detach applied). Delete the registry's
fallback chain, so every call site has to say which one it means.

## 5. Each GUI host builds its window by hand, and the CLI skips the shared policy

The extension (`ProgressViewProvider.ts:240-470`, `extensionHostRequests.ts`)
and the desktop (`desktopProjectBindings.ts:240-390`, `desktopAgentRun.ts`,
`desktopHostRequests.ts`) both build the same eight pieces in the same
order: `SessionBridge.make`, the snapshot source, the tool-edit approval
controller, the local-or-service attach branch, the run actions, the file
actions, export, and the shared request bindings. That is about 45 port
verbs filled in twice. The two copies already differ:

- The API-key help link points to two pages:
  `extensionHostRequests.ts:609` versus `desktopHostRequests.ts:426`.
- Only the desktop refuses to export the transcript of a run that is no
  longer open.
- `showError` rejects the request on the desktop and shows a toast in the
  extension.
- latexdiff against a commit asks for math markup only in the extension.
- Pack and clean results use the shared message on the desktop and the
  extension's own on the extension.

The CLI imports none of `hostRunActions`, `sharedHostRequests` or
`ChatExportController`. Resume, `/resume all` and fork each have their own
refusal handling in `packages/cli/src/chat/chatSessionController.ts` and
`sessionCommands.ts`. Model-access route labels exist twice, worded
differently: `packages/cli/src/runtime/modelAccessRoute.ts` and
`packages/texra/src/ui/copy/modelAccess.ts`.

Fix direction: one GUI window builder in
`packages/texra/src/controllers/session/` that takes a small set of
capabilities from each host. Move the run-action policy (resume, fork,
refusal mapping) out of `HostRunActions` so the CLI calls it too, and keep
all route labels in `@ui/copy`.

## 6. Tool-edit approval staging is written three times (four, counting the service's)

The GUI uses `packages/texra/src/controllers/approval/ToolEditApprovalController.ts`
(679 lines). Each GUI host also keeps its own backing file. The CLI's
headless adapter (`packages/cli/src/runtime/approvalAdapter.ts:144-325`) and
its TUI (`subscribeApprovals.ts`, `approvalQueue.ts`) each repeat the same
work: track acted requests, cache previews, and prune to the live requests.

#14009, where a closing window drops a user's edit when the request moves to
another window, comes from the edited content living only in the host's
file. Today its fix has to land three times.

Fix direction: one host-neutral staging store keyed by request id. It prunes
against `view.requests` and writes edited content through to the session
or service. All three hosts read from it.

## 7. Most test suites import harness internals, and no ratchet limits it

182 of 282 `*.vitest.ts` suites import harness internals through path
aliases: 739 import lines and 199 distinct internal specifiers. Only 12
suites use the public `@texra-ai/harness` entries. 26 of the 40 support
modules do the same. The most imported are `@agent/runtime/SessionHandle`
(39), `runRegistry` (17) and `runApprovalQueue` (8).
`config/ratchets/harness-deep-import-baseline.json` covers only app and host
code, so the test suite is now the largest deep importer and nothing limits
its growth.

The [general-package design](../architecture/2026-10-21-harness-general-package-design.md)
moves about 136 files and changes about 1,500 import lines, and plans to stop
plugins taking `SessionHandle`. Every one of these suites adds conflicts to
those moves. That is the "tests on a seam that keeps changing" cost AGENTS.md
"Testing discipline" describes.

The full run is also slow. 50 suites import `defaultSessionTestSetup` or
`sessionGraphTestSetup`, whose import-time setup forces them into the
isolated tier. CI runs 2 shards of about 10 minutes each, and about 16 on
Windows. The fix in
[the shared module registry note](../testing/2026-09-10-shared-module-registry.md)
(an estimated 3.5 times faster) has not moved since 2026-09-10.

Fix direction: bring `src/test-kernel` under the deep-import baseline as a
shrink-only set. Move suites onto public entries as each design lane lands,
and delete suites that only test a seam being removed.

## 8. The harness still carries TeXRA's vocabulary

`packages/harness/src` (421 files, about 87k lines) has:

- 139 lines naming TeXRA, in 46 files.
- 41 `texra.*` state keys in `shared/state/stateKeys.ts`, including the
  onboarding keys.
- A settings catalog that hardcodes the `texra.` prefix
  (`shared/state/stateSettings.ts:483`).
- `AGENT_MODE_PRESETS`, exported through the public `/schemas` entry
  (#14321).
- TeX Live and MiKTeX paths in `utils/system/platformPaths.ts`.
- A LaTeX math instruction in `agent/prompt/PromptBuilder.ts:32`.
- About 160 strings of user-facing English (a heuristic count; #14179,
  which absorbed #13826).

`config/ratchets/core-quality/undocumented-exports.json` holds 306
undocumented exports in 130 files, 190 of them under `shared/`.

Each of these that sits in a public entry becomes a semver contract that the
0.x package will have to break. This is the owner's main open goal (#13724).

Fix direction: the design's approach of passing vocabulary in as data. Make
the settings prefix and the presets parameters of the catalog. Move the
presets, onboarding keys and TeX paths into `packages/texra` together with
their consumers, with no shim. Before the surface is published, document the
`shared/` exports or drop the ones only hosts use.

## 9. `packages/llm`: thin offline tests, background code per provider, and llm-zoo types in the public API

- Offline provider tests were cut to 8 cases in 1,485 lines (`a2608cc`
  removed 3,734 lines). `packages/llm/README.md:256` still says "about 9 700
  lines". The 12 live suites never exercise background submit, observe or
  cancel, uploads, the WebSocket transport, Google with server state off,
  or the subscription (OAuth) routes. They run only under a paid label. The
  per-provider event parsers, the riskiest code in the package, now have
  almost no offline protection.
- Background submit, observe and cancel are written separately for Google
  (`googleInteractions.ts:754-938`) and OpenAI Responses
  (`openaiResponses.ts:170-484`). The error-enrichment closures and deadline
  arithmetic are repeated, and the two already differ: Responses' `cancel`
  uses `enrichModelError` where every other path uses `fillModelError`.
  `prepareTurn` is written three times.
- `BindSpec.model` is llm-zoo's `ModelConfig` (`packages/llm/src/node.ts:38`),
  and llm-zoo is declared with a caret range (`^4.2.0`). The rule for when
  background mode is allowed is owned twice: `backgroundOn` in
  `packages/harness/src/agent/runtime/modelAccess/binding.ts:63-75` and
  `backgroundCapable` in llm.

Fix direction: one table-driven contract suite (fixture events in, turn
events or error kind out) run against every model factory. Add one
background-operation combinator in `transport.ts`. Have `bindModel` return
whether background mode is allowed. Pin or re-export llm-zoo's types so
consumers depend on `@texra-ai/llm` alone.

## 10. The response dispatcher is one 818-line function with a second dispatcher inside it

`dispatchPendingResponse` in
`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts:292-1109` holds
about 14 inner functions that share local state. The script path
(`:703-951`) is a complete second dispatcher inside it, with its own
scheduler, replay ordering and a shared-value map (the file's two
`type-assertions` entries). A call's terminal row is reached four ways: a
hand-called sweep, resume skips, the sandbox interrupting calls, and the
transcript marking open cards at read time. Correction: #14254 is fixed
(#14253). What stays open after an interrupt is open by design, for the
resume.

Fix direction: a module-level per-call program over an explicit call
record. The response path and the script path are two real callers, so
this is not a single-caller extraction. The script path then becomes its
own module.

## Also found, ranked lower

- **Ratchet bookkeeping.** `config/ratchets/` holds 34 baseline files and
  about 3,000 lines of checker scripts. `core-quality/file-size.json` changed
  in 16 of the last 50 commits, so parallel PRs conflict on it. Every rule
  except `file-size` fails a count that went down until `--update` runs.
  Eight baselines are empty. They could become plain lint errors, but the
  baseline check forbids deleting them.
- **No measurement exists.** Production code has zero `Metric` uses. The
  [runtime performance record](../process/2026-09-21-runtime-performance-measurement-record.md)
  still has no reading, and nothing would produce one (#12076).
- **Generated-file deletion contract** (#12139, risk high). `deletionCleanup.ts`
  still checks paths instead of confining removal to an open directory
  handle. A 1.0 requirement.
- **Untracked host-to-host edge.** The desktop renderer imports the
  extension's webview frontends through `@progressView/*` and
  `@settingsView/*` (7 imports). No ratchet records this.
- **Open issues that look already fixed.** #13704 (the code requires an
  interaction id only when `store` is on) and #14238 (`effect` is pinned at
  4.0.6 and `Database.ts:370-378` uses the new signature). Both can likely
  be closed after a check.
