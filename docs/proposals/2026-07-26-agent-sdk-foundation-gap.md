# Agent-SDK foundation gap: measured against the Claude Agent SDK and the Codex SDK

> **Status:** Analysis. Written 2026-07-26 from five parallel studies at HEAD `0fc924d47` /
> `origin/main` `5fc03f9436`. Companion to the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md) and the
> element doctrine [`2026-07-07-fewer-elements.md`](./2026-07-07-fewer-elements.md).
>
> **Why a 23rd readiness doc.** The `-05-30` → `-07-23` chain asks _"what can we delete?"_
> and keeps answering "little" — the `-07-23` verdict is "no structural refactoring is
> warranted." That question takes the current decomposition as given. This doc asks a
> different one: **what should the surface be?** — grounded for the first time in the two
> reference SDKs the repo already depends on, read from their shipped `.d.ts` in
> `node_modules` and executed, not from documentation.
>
> **Landed since this was measured** (all merged 2026-07-26, so several baselines below have
> already moved): #9222 preset data-loss fix · #9224 the embedding guide · #9225 the
> unattached-interaction park made loud · #9226 status-bar phase mirror deleted · #9227 inert
> `HostInteractionOptions.timeoutMs` deleted (−298 LoC) · #9228 `ServerSideKeyService` lazy
> (one of the six ordered globals) · #9229 CLI shutdown handlers registered · #9234
> `SessionHandle` owns its snapshot store (acceptance row 1; 4 write-owners → 0) · #9236
> vendored PocketFlow cookbook deleted (−3,909) · #9238 `RoundPersistedFlow` moved out of the
> engine directory. Re-measure before quoting any figure here.

## 1. The measured gap

|                                        | Claude Agent SDK | Codex SDK | **TeXRA**                    |
| -------------------------------------- | ---------------- | --------- | ---------------------------- |
| Imports for one turn                   | 1                | 1         | **16**                       |
| Setup steps before the run call        | 0                | 0         | **14**                       |
| Ordered global singletons              | 0                | 0         | **6**                        |
| Required options                       | 0                | 0         | 1 (`runtimeHost`, throws)    |
| Interfaces to hand-implement           | 0                | 0         | **1 min / 3 to avoid hangs** |
| Config types on the launch path        | 1                | 3         | **13**                       |
| Channels a complete consumer must wire | 1 + callbacks    | 1         | **8** (of 12 in-process)     |
| Facts duplicated across ≥2 channels    | 0                | 0         | **14**                       |
| Published package                      | yes              | yes       | **none**                     |

Sources: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (7,104 lines, 236 exports);
`node_modules/@openai/codex-sdk/dist/index.d.ts` (278 lines, 33 exports); TeXRA measured
across `src/` + `packages/`.

The real TeXRA surface is not the 17-module three-host intersection usually quoted: hosts
reach **1,310 symbols across 344 modules** through 16 core aliases (`@shared` alone accounts
for 573 imported / 990 exported names).

**Export count is not the metric.** Anthropic ships 236 exports and 7,104 `.d.ts` lines and
is still trivially embeddable. Coherence of concepts beats their number — which means the
standing −12%-elements target was aimed at the wrong variable.

## 2. The organizing principle we lack

The Claude SDK's rule, stated as a line we can apply mechanically:

> **Anything the host merely _observes_ goes on the stream. Anything the run _blocks on_ is
> a callback returning a promise.**

One `AsyncGenerator<SDKMessage>` carries assistant output, token deltas, tool progress,
results, cost, errors and session-state changes — 40 leaf variants under 11 discriminants.
`Query` has **zero** `on()`/`emit()`/`subscribe` members (grepped). Permissions are a
callback _because a stream item has no return channel_; they used the language's own
request/response primitive instead of inventing a correlation protocol. Deliberate
asymmetry: permission **denials** are echoed back onto the observation stream, so a host can
render a complete transcript without instrumenting its own callbacks.

**Codex is not our model.** Its single-rail purity is a consequence of architecture, not
taste: it spawns `codex exec` and closes the child's stdin after writing the prompt
(`index.js:262-263`), so a request/response rail is structurally impossible. Verified
empirically — with `approvalPolicy: "untrusted"` and a prompt demanding a file write,
nothing hung, nothing threw, no approval event was emitted, and the escalation was silently
auto-denied. `ApprovalMode` is decorative. TeXRA has real interactive approvals, so TeXRA is
in the Anthropic class.

**Our violation of the principle is systematic.** Every approval exists **both** as a
fire-and-forget event (`RuntimeInteractionEventPayloads.show{Bash,Plan,ToolEdit,…}`,
`src/agent/runtime/runtimeInteractionEvents.ts:19-37`) **and** as a response-bearing method
(`HostInteractions.request{BashApproval,PlanApproval,…}`,
`src/agent/runtime/HostInteractions.ts:307-333`). Six kinds, two surfaces each. Same for
bypass state. This is not "too many channels" — it is one concern modelled twice in two
incompatible shapes.

## 3. Three structural findings

### 3.1 There are two renderers, not three

`packages/desktop/tsconfig.paths.json` maps `@webview/*`, `@progressView/*`, `@settingsView/*`
and `@common/*` into `packages/extension/src`. The desktop "renderer" **is** the extension
webview (37,108 LoC), wrapped by a 1,953-LoC Electron shell; both also share
`src/controllers/progressView/backend/ProgressBackend.ts` and the same
`ApprovalRequestHandlerSet`. Only Ink is genuinely separate.

Presentation is therefore already unified. **What is triplicated is the bookkeeping stack
around it** — which is where the cost actually sits, and why "do not unify the three
renderers" was guarding a problem that does not exist.

Leaked runtime bookkeeping as a share of each host's **own** code (excluding shared webview):

| Host           | Own LoC | Bookkeeping |
| -------------- | ------- | ----------- |
| extension      | 22,735  | **13.5%**   |
| desktop (main) | 11,306  | **38.8%**   |
| cli            | 50,027  | **13.8%**   |

Corroborating, independent of file assignment: in `packages/cli/src/chat/tui/state/`,
**3,600 of 5,764 LoC (62%)** mirrors state the runtime already owns — `StreamStatusMachine`
phases, `StreamLogStore` entries, snapshot todos/plan/usage, a second pending-approval
registry.

### 3.2 The runtime never states an ownership lifetime, so each host invented one

`StreamSnapshotStore`'s own header says "SINGLE writer… shared by CLI TUI, extension,
desktop" (`src/transcript/StreamSnapshotStore.ts:1-9`). It has **four write-owners**
(`ProgressBackend.ts:132-139`, `desktopProcessStores.ts:109,131`,
`packages/cli/src/runtime/runExecution.ts:184-190`, `runChatTui.tsx:414-419`), arbitrated by
a `stateOwnership` flag whose own doc calls it ledgered debt. Four different lifetimes
(process / window / process-run / turn).

Consequences: the extension re-implements the artifact-flush drain as a fourth spelling
(`ProgressViewState.ts:565-568` vs `SessionHandle.flushArtifactsOnce`); and because it never
implemented the `emit` port that desktop satisfies in **six lines**
(`desktopHostInteractions.ts:80-85`), it wrote its own 1000-event replay buffer
(`extensionPresentationEvents.ts:20,28-74`) — 76 LoC and a duplicate mechanism for six
lines not written.

### 3.3 Misfiling caused a real parity hole

**`src/controllers/` has only one CLI consumer.** Measured:
`grep -rn "@controllers/" packages/*/src` → **cli 1, extension 44, desktop 44,
trace-viewer 0** (the one CLI hit, `packages/cli/src/onboarding/runOnboarding.tsx:24`, imports
`planOnboardingFunnelTransition`). CLAUDE.md describes it as "host-neutral orchestration"; it
is in fact the
**extension-webview controller layer** — and since the desktop renderer _is_ the extension
webview (§3.1), "shared by two hosts" is weaker than it sounds: one projector serves one
renderer. It is a real layer (54 modules, 10,590 LoC, 0 `vscode` imports — the boundary rule
holds), just not the one its name and charter claim.

**964 LoC of host-agnostic runtime logic is filed behind that UI path**, which is the
mechanism that produced the parity hole:

- `progressView/backend/restartRepair.ts` (415 LoC) — crash recovery. **0** `vscode`, **0**
  webview, **0** IPC references; imports only `@agent/storage/*`, `@agent/runtime/StreamStatusService`,
  `@shared/*`. Consumers: `ProgressViewProvider.ts:402`, `desktopAgentExecution.ts:790,825`.
  **CLI: 0.** Belongs in `src/agent/runtime/`, beside the `StreamStatusService` whose types it
  already imports.
- `progressView/backend/state/SessionStores.ts` (549 LoC) — same shape, same CLI blind spot.

A CLI crash therefore leaves RUNNING execution status and flow records on disk with no repair
pass. Same story for `teardownDefaultSession`, which the CLI never calls
(`registerAgentShutdownHandlers` is already wired in
`packages/cli/src/runtime/initPlatform.ts:323`, so that half of shutdown is not a gap). These
are not platform differences; they are obligations a host missed because nothing made them
discoverable.

**Moving them is worth zero on its own** (0 elements, 0 LoC, churns 4 files, and R4 bans
churn-only renames). It pays only inside the PR that makes `SessionHandle` call the repair on
store open — which is where the ~180 host LoC and the CLI parity hole go together.

The same fact→view switch exists **four times** (219 LoC of switch, inside 2,058 LoC of file,
over the same 13 `RUN_FACT_EVENT_TYPES` and 10 `SessionFact` arms) — **three of the four
inside the CLI**. One
status write site fans to three rails with **13 production apply-sites**, forcing 30 LoC of
dedup in a renderer. _(Corrected 2026-07-26: the two **projectable** status rails — trace and
session-fact; `onDidChange` is the third and fires unconditionally — were mutually exclusive in
production, so this dedup map was never reachable — dead code, not an active CLAUDE.md
violation; see the acceptance-criteria row 5 correction in §7.)_

## 4. Intermediate layers, measured — and mostly exonerated

> **Corrected 2026-07-26 by a hop-by-hop study of the function bodies.** An earlier draft of
> this section claimed "13 config types = 13 collapsible layers" and flagged three stranded
> callbacks. Both claims were wrong. The corrected findings stand as a warning that counting
> _types_ on a path predicts nothing about _layers_ on that path.

The path carries **20 named types** (not 13; 7 more live in `RunContext.ts`), ≈214 LoC of
declarations. But hop-by-hop, there are exactly **two pure pass-throughs**, both trivial:
`withExecutionRunContext` (`AgentLaunchContext.ts:117-142`, 26 LoC of which 11 are a comment)
and `createRunScope` (`RunScope.ts:25-27`, `return Object.freeze({...scope})` — 1 production
caller, 12 test callers, so inlining it 13× is a net-add). The other five hops own 6-15 real
decisions each: `runAgent` (executionId assignment, lease capture, failure finalization),
`executeAgent` (runtimeHost guard, category dispatch), `buildAgentLaunchContext` (stream
reservation, saga compensation), `runFlowWithLifecycle`, `runToolUseFlow`.

**The cost is width, not depth — and most of the width is justified.** Honest mechanical
total: **−1 type, −2 dead fields, ≈ −10 production LoC.**

- `AgentConfigInput` (`AgentConfig.ts:123`) has 3 occurrences in 2 files and is a second
  spelling of `AgentConfigPayload` (it derives from the _shared-fields_ schema, so it does not
  model the legacy pre-migration shape as its name implies). **Merge.**
- `AgentLaunchInput.taskType` (`AgentLaunchContext.ts:92`) — **0 setters repo-wide**. Dead.
- `CreateLaunchRunContextOptions.model` (`RunContext.ts:72`) — 0 production setters; the
  right arm of `getModel() ?? model` is unreachable because `AgentConfig.model` is
  `z.string().prefault(...)`. Dead.
- Two free rename collapses: `onStreamResolved`→`onBeforeActivation` and `onRunError`→`onError`
  are pure renames of identical semantics (`executeAgent.ts:384`, `:452`). Pick one name each.

**`ExecutionRequest` → `ValidatedExecutionRequest` differ by exactly one token**, confirmed.
But the parse boundary earns the input type. The real finding is downstream: of 6
`validateExecutionRequest` call sites, **3 are re-parses of a value already typed
`AgentConfig`** (`desktopHistoryHandlers.ts:137`, `desktopAgentExecution.ts:403`,
`ProgressViewMessageHandler.ts:891,908`) — because three port declarations advertise the loose
type and widen back after parse. Retyping those 3 ports and deleting the 3 re-parses is
≈ −25 host LoC, and is a **behavior ruling** (it removes defense-in-depth at a controller→host
seam), not a mechanical PR.

**`RunScope` / `BareRunContext` share 6 of 7 fields**, confirmed, and `getRunContextField`
(`RunContext.ts:180-187`) types that intersection literally. The real finding is worse and has
no net-negative remedy: **`BareRunContext` has zero production constructors.** Its only
non-`AgentLaunchContext` caller is a self-described test helper. So ~50 lines of _production_
type surface exist solely for tests — and they are the sole reason all 6 accessors return
`| undefined`, forcing `??`/`?.` at 118 call sites. Deleting it pushes 44 test sites from
1-line to ~7-line construction: **≈ +150 test LoC against ≈ −50 production LoC**, doubled under
R7. Avoiding that needs a shared test factory — adding an element to remove one. **Documented
smell, not a work item.**

**The stranded-callback claim was false.** 7 fields (not 3) on `ExecuteAgentOptions` are absent
from `RunAgentOptions`, and all 7 have live production consumers reaching them via
`executeAgent` directly (`inBandSubagentExecution.ts:524`, `nativeSubagentStrategy.ts:175-180`).
All 7 are subagent-lineage concerns; `runAgent` is the root-launch entry and its docstring
(`runAgent.ts:68-70`) already states the split. The actual defect is a name:
`SubagentRunOptions` is documented as subagent-only (`executeAgent.ts:274-280`) while 4 of its
9 fields are picked into `RunAgentOptions` for root launches. One-word doc fix; R4 bans the
rename.

**The tool registry is closed.** `IToolRegistry` is `{get, has}`
(`src/agent/core/tools/ToolTypes.ts:41-44`); 54 tools are hard-coded in `createDefaultTools()`
(`src/tools/registry.ts:89-146`); there is **no public `register`**. An embedder cannot add a
tool. Compare `tool(name, desc, zodSchema, handler)` in one call. This remains the largest
single gap on the launch path — and it is the one place the surface must **grow**.

## 5. State-model diagnosis

Two tiers, and they need different remedies.

**Tier 1 — naming (glossary, not renames).** 78 `*State` types, 47 `*Session` types, **13
distinct meanings of "session"**. Misleading names include `TaskState` (holds no state — it
is `AgentConfig` plus four derived booleans), `AgentWorkspaceState` (agent scratch, unrelated
to `platform().workspaceState`), `StreamSnapshotStore` (mutable, with four overlay maps),
`SessionHandle` (not a conversational session; its own header disclaims it). Repo-wide
renames are the maximal-churn class banned by fewer-elements R4 — the remedy is a glossary or
a boundary alias.

**Tier 2 — three genuine faults a glossary would only document.**

1. **Per-run state in the per-workspace settings bucket.** `src/tools/goal/goalStore.ts:21-22,85`
   writes `goals:byStream:${streamId}` into `platform().workspaceState` with a hand-maintained
   index, a `Mutex`, and a code comment admitting the leak.
2. **`JsonStore` serves stale cross-process reads** (`src/platform/defaults/jsonStore.ts:101-205`).
   Writes are atomic under a lockfile; reads return the instance's open-time snapshot. The CLI
   runs many short-lived processes against one `state.json`, so concurrent hosts can clobber.
   The `StateStore` port does not disclose this and offers no `keys()`/`delete()`.
3. **The workspace/global split is not principled.** 17 of 31 "workspace" keys are physically
   in globalState via `WorktreeMemento`; one logical setting (git author) has **three physical
   homes**; ~12 keys bypass the enums as raw literals; five historical migration paths each
   record a past misfile.

**Identity.** `StreamTabId` is **not opaque** — `streamTab.ts:17` builds
`` `${agent}@${model}#${executionId}` `` and `executionIdFromStream.ts:11` parses it back. It is
1:1 with `ExecutionId`, and that relation is stored redundantly four more times. A session has
**no id at all** — identified by object reference in `liveSessions: Set<SessionHandle>`. Of ~20
identity types, 6 are redundant or dead. `z.brand()` appears zero times in `src/shared` or
`src/agent`.

For contrast: the Claude SDK exposes **no** `TaskState`, **no** `WorkspaceState`, and no
host-held snapshot. `persistSession` defaults `true`; resume is one string. Where they had to
expose stored state, they typed entries as a 3-field structural supertype with the reason
inline — the real union "is CLI-internal and not part of the SDK API surface"
(`sdk.d.ts:4844-4857`).

## 6. The absorption sequence

Every item folds bookkeeping into an owner that **already exists**, citing what the runtime
already does for a sibling. No facade, no barrel, no new plane — north-star §5 stands.

| Move                                                                                                                                                      | Precedent it copies                                                                    | Effect                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `SessionHandle` owns/attaches/flushes `snapshots`                                                                                                         | it already does this for `transcripts` (`SessionHandle.ts:110,141,266`)                | 4 write-owners → 0; `stateOwnership` deleted                                                                   |
| `dispose()` awaits `flushArtifactsOnce()`                                                                                                                 | already calls `flushPendingTraces()` (`:386`)                                          | teardown 5 lines → 1; kills the 4th flush spelling                                                             |
| `SessionHostInteractions` becomes the only `AgentRuntimeHost`                                                                                             | already `implements` both (`HostInteractions.ts:362-364`) and has `replayWhenAttached` | `runtimeHost` leaves the options bag; 108 extension LoC deleted                                                |
| One status rail; consumers read `onDidChange`                                                                                                             | the listener rail already fires unconditionally (`StreamStatusService.ts:321-323`)     | 13 apply-sites → ≤5; renderer dedup deleted                                                                    |
| Repair runs when the store opens                                                                                                                          | `SessionHandle` ctor already knows `transcripts` + `status`                            | ~180 host LoC deleted; **CLI parity hole closes for free**                                                     |
| **Stop erasing `runScope` from the flow-services type** (move the field from `AgentLaunchContext.ts:73` up into `AgentCore`, `BaseFlowServices.ts:18-27`) | the value **already** travels on the bag                                               | **8 of 11 ambient ALS reads inside flow primitives become `this.services.runScope`**; core→runtime edges 4 → 1 |
| Adopt observe-vs-block                                                                                                                                    | §2                                                                                     | the six `show*` arms die; denials echo onto the stream                                                         |
| Make the 6 ordered globals lazy or session-owned                                                                                                          | serverKeys (PR #9228) is one of six                                                    | 6 → 0                                                                                                          |
| Open the tool registry                                                                                                                                    | —                                                                                      | the one place the surface must **grow**                                                                        |

### 6.1 The ambient-`RunContext` coupling is a type erasure, not a design

The highest-value single item found, and the cheapest. Inside `src/agent/core/` there are **5**
`AsyncLocalStorage` reads (`ModelInvocationNode.ts:135`, `CommonCycleTypes.ts:109,127`,
`RetryState.ts:332`, `ResponseCycleFlow.ts:226`) and **6** more in
`src/agent/implementations/flows/` — 11 total, of which **8 need only `runScope`**.

But `runScope` is **already an own property of the object the flows spread**. It is set at
`AgentLaunchContext.ts:441`, survives all four copies (`executeAgent.ts:140,228,573` →
`runToolUseFlow.ts:228` / `runReflectionFlow.ts:302` → `CycleServices.ts:63`), and is present
on `this.services` at runtime in every node. **It is only absent from the declared type.**

So the ambient global read that the readiness chain has carried as the core embeddability
tension since `-05-29` is a _type-level erasure_, not a structural dependency. Moving one field
declaration converts 8 of the 11 reads to `this.services.runScope`. Migration cost outside
core: **2 test lines**, **0 production call sites** — no signature changes, so it is neither DI
nor parameter-object accretion.

It reverses an explicit doc comment (`RunContext.ts:231-240`: _"Use this instead of
re-deriving these fields on the flow-service bag"_), so it **needs a ruling** — but the doc's
premise is false: nothing is re-derived, the value is already there.

This is the difference between _"an embedder must install an AsyncLocalStorage scope before any
flow node will run"_ and _"an embedder passes a services object."_

### 6.2 Two inventory facts worth recording

- **There are 2 PocketFlow flows, not 3.** `implementations/flows/agentCreator/agentCreatorFlow.ts`
  (406 LoC) contains **zero** `Node`/`Flow`/`@agent/node` references — it is one linear async
  function with a single caller, a VS Code command
  (`packages/extension/src/commands/agent/agentCreatorCommands.ts:223`). CLAUDE.md's "Agent
  system" section lists three flows; that is inaccurate.
- **6 modules in `src/agent/runtime/` (396 LoC) are TeXRA product features, not runtime**:
  `helperModelPreference.ts` 50 (its own header says "for the 'fix LaTeX' VS Code actions"),
  `polishModel.ts` 59, `textEnhancement.ts` 80, `textConnection.ts` 106, `helperModelName.ts`
  70, `selectAutoOpenFinalOutput.ts` 31. Four have zero importers inside `src/agent/` outside
  runtime siblings. Moving them is 0 elements and 0 LoC — inventory for the §9 split, not a
  work item. _(An earlier draft said 524 LoC; re-measured at HEAD it is 396.)_

A minimal frontend today is **84 lines, 27% intent, 3 silent-corruption ordering traps**.
Target: **~45 lines, ~50% intent, 0 paired detaches, 0 ordering traps** — inside the
north-star's own ≤~80-line acceptance bar, with zero new elements.

## 7. Acceptance criteria

Checkable by a number, a grep, or a file that does not exist. Baselines at `5fc03f9436`.

| #   | Property                                                           | Today                                                                                  | Target                                        |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | One owner of durable persistence                                   | 9 host attach/construct hits; `stateOwnership` live                                    | 0; symbol absent                              |
| 2   | Attach/detach symmetry costs the host nothing                      | cli headless 7, cli TUI 4                                                              | 0 everywhere                                  |
| 3   | Per-run block is intent-only                                       | 158 / 74 / 44 / 45 LoC                                                                 | all ≤45; `setupRunHost` deleted               |
| 4   | Bootstrap is one call                                              | cli 15 registrations across 14 modules                                                 | ≤3 per host, inside `createNodePlatform`      |
| 5   | One status rail                                                    | 13 apply-sites, 3 rails                                                                | **10**, renderer dedup deleted (see note)     |
| 6   | Recovery + shutdown are the runtime's, uniformly                   | cli references: 0 repair, 0 `teardownDefaultSession` (shutdown handlers already wired) | 0 host references (absorbed)                  |
| 7   | Port is required-shaped; no host re-implements a runtime mechanism | 0/7 required; 99 identical ext/desktop lines; `extensionPresentationEvents.ts` exists  | 6/7 required; ≤20; file absent                |
| 8   | An executable minimal example, gated                               | none                                                                                   | ≤50 lines, zero `attach`/`detach` identifiers |

**Note on row 5 — the "≤5" target in north-star §6 is unreachable by deletion; 10 is the
floor.** The 13 apply-sites were enumerated exactly. Deleting the three _projector_ trace-arms
per the `9fd44cd689` (#9209) ruling takes 13 → **10**, and the remaining three cannot go:
`TexraTranscriptRecorder.ts:389-426` became a load-bearing persistence consumer of the trace
arm in #9127 (it closes the transcript boundary and settles open tool rows on WAITING/terminal);
`subscribeRuntimeHost.ts:371` is an `assertNever` exhaustiveness arm, now protected by the
silent-degradation rule; and the five `onDidChange` listeners are all legitimate in-process
consumers, one of them inside the runtime itself. **Restate the acceptance target as 10.**

> **Corrected 2026-07-26 — "deleting the three projector trace-arms" is not the mechanism that
> gets there; see [#9250 comment](https://github.com/LionSR/TeXRA/issues/9250#issuecomment-5084548544)
> and #9263.** `publishStatus` gates the session-fact emit on `options.events`, and no production
> call site has ever passed `trace` and `events` together
> (`ExecutionRegistry.streamStatusEmitOptions` returns one or the other; `AgentLaunchContext`
> used `...(runTrace ? {} : { events })`). So dropping the `!options.trace &&` guard alone is a
> no-op, and deleting the three projector trace-arms alone **silences status entirely** for every
> trace-owned transition — run start, terminal, manual-retry WAITING/RESUME/CANCEL, restart
> repair. The rails being mutually exclusive also means the renderer dedup map that §3.3 calls a
> CLAUDE.md violation was **unreachable dead code**, not an active violation.
>
> The route that actually reaches 13 → 10: `StreamStatusMachine` receives the session hub at
> construction — mirroring `new ExecutionRegistry({ streamStatus, events })` a few statements
> later in the same `SessionHandle` constructor — and publishes the fact itself. The
> independent `SessionHandleInit.status` injection seam goes away with it, so the machine and
> the hub can no longer be bound to different owners.
> `StreamStatusEmitOptions.events` and its 7 call-site properties are deleted, along with
> `'status'` from `RUN_FACT_EVENT_TYPES`. Apply-sites land at 13 → 10 as targeted (trace 4→1,
> fact 4→4, `onDidChange` 5→5), for **−69** production LoC, with `TexraTranscriptRecorder`
> untouched.

**One-line test for the goal:** a reader opens `desktopAgentLaunch.ts` (44 LoC, 0 detaches)
and `executeCommand.ts` (45 LoC, 0 detaches), learns everything needed to write a frontend,
and opening `runExecution.ts` teaches nothing extra — because nothing extra is left in it.

## 7.1 The interaction-surface design (tournament result, design of record)

Produced by a judge-panel tournament: four independent designs (minimal-surface,
cheapest-migration, host-parity, embedder-first), scored by three comparative lenses (element
economy, does-it-actually-work, teachability), then synthesised. The design that **won on
teachability was disqualified on the code** — which is the argument for running these as
tournaments rather than single passes.

### The principle

> **A fact the host only watches goes on `session.events`; a decision the run waits for is a
> method on the `HostInteractions` object the host hands to `session.useHostInteractions()`;
> anything a host shows to its own UI is a call inside that host — and nothing is ever on two
> of them.**

Two enforcement clauses a contributor applies without asking:

- **Misfiling grep.** Grep the arm name. If every producer _and_ every consumer sit under
  `packages/*/src` (or both under `src/controllers/`), it never crossed the runtime boundary
  and must not be declared in `@agent/runtime`. This is what catches `showToolEditPermission`:
  emitted at `src/tools/approval/toolEditApproval.ts:103`, consumed only in hosts and
  `src/controllers/` — a host→runtime→host loop.
- **Tiebreak.** If a fact is on two surfaces, delete the one with no producer; if both have
  producers, delete the one that cannot carry a reply.

**Why presentation is not observation** — structural, not taste. A presentation arm is
addressed to _the_ attached UI, delivered once, parked if nobody is attached
(`HostInteractions.ts:410-423,641-665`). `SessionEventHub.emit` (`SessionEventHub.ts:107`) fans
out to every subscriber with zero retention. Putting `requestOpenFile` on the hub means either
N subscribers open the file, or the hub grows a retention buffer — re-minting the 1000-entry
buffer at `extensionPresentationEvents.ts:20` that this design deletes. The fix is to narrow
`emit`'s key type from `AgentRuntimeEvent` (15 keys) to `RuntimePresentationEvent` (5 keys) and
make it **required**: the affordance that produced the defect was a generic `emit<K extends
AgentRuntimeEvent>` that _accepted the 10 interaction keys_.

### The disqualification

"Total Port, Echoed Denials" seeds a permanent default-denier at `attachments[0]`. But
`activeAttachment` is `this.attachments.at(-1)` (`HostInteractions.ts:591-592`) and the
disposer re-dispatches every non-cancelled pending request to the new active attachment
(`:399-407,636-638`). So **every live approval auto-denies the moment a host detaches** — and
desktop detaches per window (`desktopAgentExecution.ts:348/662`). Closing a desktop window
would silently deny a pending tool-edit diff: the Codex auto-deny failure, reintroduced.

### Honest deltas

In-process channels go **12 → 10**, which is not a meaningful reduction and is not presented as
one. What moves:

|                                     | before |                  after |
| ----------------------------------- | -----: | ---------------------: |
| Surfaces a consumer must wire       |      8 |                  **2** |
| Required run options                |      1 |                  **0** |
| Facts duplicated across ≥2 channels |     14 |                  **4** |
| Named constructs                    |      — |            **−42, +0** |
| Files                               |      — | **−6** (341 LoC exact) |
| Port shape (members / required)     | 15 / 1 |                14 / 11 |

Production LoC: **bank −400**, −550 is upside. **Additions: zero** new constructs, files, or
vocabularies — five _implementations_ of interface members that already exist (desktop already
satisfies `emit` in six lines at `desktopHostInteractions.ts:80-85`).

**The price every design undercounted:** `runtimeHost`/`AgentRuntimeHost` is **267 references /
63 production files** plus **300 / 61 test files**. The winning design claimed "37 test files."

### Two parity holes, found only by combining designs

`updateBashApprovalBypassState` has a producer (`streamApprovalQueue.ts:264`) and **zero
consumers** — absent from the `Pick` at `ProgressInteractionHandler.ts:23-28`, so extension and
desktop never learn bash bypass changed. Conversely `setApprovalBypassState` is implemented
**only** by the CLI TUI (`subscribeApprovals.ts:243`), so toolEdit/superYolo bypass never
reaches it. Disjoint consumers; **one rail fixes both.**

### Migration — each step independently shippable

1. Delete the 5 producerless `show*` arms. CLI-only, type-level, no window.
2. **One bypass rail.** No compat window: the CLI's new `setApprovalBypassState` writes the
   byte-identical NDJSON record from the identical 1:1 call sites.
3. Tool-edit arms become host-local; `RuntimeInteractionEventPayloads` dies.
4. Narrow + require `emit`; delete the extension's two buses. **⚠ Ruling** — pass
   `replayWhenAttached: true` at the four launch-path emit sites pre-emptively.
5. Delete `AgentRuntimeHost` and the `runtimeHost` option. The 124-file sweep.
6. Required-shape the port; delete the silent-settle arm (`HostInteractions.ts:678-681`) and
   the 5 hand-rolled throws it forced.

Orthogonal, each needing its own ruling: the reveal-stream fold (7) and the status rail
13 → 10 (8, atomic). **No persisted format changes in any step.**

> **Corrected 2026-07-26** — step 8 as prescribed in the §7 acceptance-criteria row-5 note is
> not atomic-safe: dropping the
> `!options.trace &&` guard alone is a no-op and deleting the three projector trace-arms alone
> silences status for every trace-owned transition (run start, terminal, manual-retry
> WAITING/RESUME/CANCEL, restart repair) — the two do not compose into "one rail." See the
> corrected acceptance-criteria row 5 note (§7) and
> [#9250 comment](https://github.com/LionSR/TeXRA/issues/9250#issuecomment-5084548544) / #9263
> for the mechanism that actually ships 13 → 10.

### Correction to a premise this doc previously carried

Webview-reload replay is **not** owned by `SessionHostInteractions` parking. The extension calls
`useHostInteractions` once in the `ProgressViewProvider` constructor (`:175`) and detaches only
on dispose — a reload never touches the attachment. Exactly-once redisplay is owned by
`ApprovalRequestHandler`'s pending map + `delivered` set + `canSend` gate
(`ApprovalRequestHandler.ts:37-45,150-155,200`). Parking covers a _different_ case (desktop's
per-window attach/detach). Both survive untouched; the deleted extension buffer was a **third,
competing** replay mechanism.

### The one ruling that gates calling this an SDK

The embedder hang survives this design, and neither obvious fix works: a permanent default
attachment **auto-denies on detach** (the disqualification above); a never-attached latch
**auto-denies a desktop startup-resume approval** that begins before any window attaches.
Recommendation: reuse the CLI's existing non-interactive policy shape rather than invent a
runtime default.

**Honest claim: the surface becomes teachable — not the coupling becomes loose.** Anyone
measuring the second will be disappointed. §9 remains untouched by this design.

## 7.2 Maintainer rulings recorded

- **2026-07-26 — `@shared/schemas` is a published surface**, not a convenience spelling. It
  stays. Consequence: the 395 production `@shared/schemas/<file>` deep imports become the
  anomaly. **197 of them are _forced_** (they name symbols the barrel does not export),
  revealing 10 leaf modules with zero presence on the surface (`toolResult` alone is 95 forced
  statements). A ratchet (~+180 LoC, copying `hostAgentDeepImportRatchet`) is priced far below
  a codemod (~473 changed lines / 254 files, 95 of which already import the barrel and would
  need statements merged). A ratchet must record **forced and gratuitous separately** or the
  number will look permanently stuck.
- Follow-on decisions still open: the four zero-consumer `export *` lines (39 symbols, 13
  host-imported — narrow the surface, or migrate those hosts onto it?); and
  `commonViewMessages`, which publishes a namespace **nobody imports**, leaving that family with
  no working barrel path and all 10 consumers forced deep.

## 8. What not to do

Carried from north-star §5 and re-confirmed by these studies: no `@texra/core` barrel before
the fence enforces; no `runSession()` facade; no repo-wide `StreamTabId` rename; no
dependency-cruiser; no definitions-as-options API; no trace↔bus merge. Added by this study:

- **Do not collapse to a single rail Codex-style.** Its purity is a subprocess artifact, and
  it costs silently auto-denied approvals. Keep a blocking-decision callback rail.
- **Do not unify the two shaping pipelines.** Extension and desktop already share one
  renderer; Ink genuinely diverges.
- **Do not treat export count as the target.** 236 exports did not stop the reference SDK
  from being embeddable in four lines.
- **Do not make `SessionHandle` the public surface without argument.** Anthropic built,
  shipped, and then _removed_ `unstable_v2_createSession` / `SDKSession` in 0.3.142,
  reverting to the single iterator. That experiment has already been run.

## 8.1 Where the mass is — and why there is no four-figure production win

Measured at HEAD (tracked files, tests and fixtures excluded, `wc -l`):

|                                                     |         LoC | files |
| --------------------------------------------------- | ----------: | ----: |
| Production (`src` + `packages`)                     | **292,864** | 1,556 |
| Tests (`*.vitest.*`, ~all under `src/test-kernel/`) | **212,672** |   783 |

**Tests are 42% of all TypeScript in the repo.** No prior study measured this.

Production mass by bucket: provider + product domain 63,246 (21.6%) · renderers/UI 66,525
(22.7%) · agent runtime+core+flows+storage+trace 39,237 (13.4%) · wire contracts 20,676 (7.1%)
· host wiring/IPC/commands ~37,700 (12.9%) · the bookkeeping every study targets **≤18,414
(≤6.3%, a whole-file ceiling, not an estimate)**.

**Duplication is not the lever.** A normalized-line clone census (K=6, ≥25-line blocks, 0
pair-level false positives on inspection) finds lines participating in any cross-file clone =
**2,823 / 294,420 = 0.96% of production**. (The census denominator counts total lines by a
different methodology than the `wc -l` production count above — the two don't reconcile
exactly, but the gap is immaterial to the 0.96% conclusion.) The complete list of clusters
above threshold is
ten pairs totalling 449 lines; the largest is **80** lines (`modelHandlerGoogleGenAI` ↔
`modelHandlerGoogleInteractions`, two distinct Google APIs — justified). **There is no
≥1,000-LoC copy-paste cluster in this repository.** The "duplication" the studies report is
_conceptual_ — one obligation discharged in two incompatible shapes — which is exactly why
merging it does not return lines.

**Consequence: no layer exists where one change removes thousands of production lines.** The
largest genuinely net-negative product change measured is ≈ **−200 LoC** (repair-on-store-open),
and its value is a closed CLI parity hole, not the LoC.

**The one four-figure net-negative in the repo is the test kernel**: 356 suites under 150 lines
totalling **30,259 LoC**, at a 2.57% clone rate (2.7× production). Fewer-elements **R7** already
authorizes the fold; nobody has run it. Est. **−2,000…−4,000 test LoC, −100…−230 files, zero
product risk** — and it buys no architecture, which should be said plainly when proposing it.

### Numbers that drifted — re-measure before quoting

| Claim                                            | Previously quoted |                                Measured at HEAD |
| ------------------------------------------------ | ----------------: | ----------------------------------------------: |
| Product modules misfiled in `src/agent/runtime/` |               524 |                                         **396** |
| `extensionPresentationEvents.ts`                 |               108 |                                          **76** |
| Hard-coded tools in `createDefaultTools()`       |                52 |                                          **54** |
| ext↔desktop `HostInteractions` identical lines   |                99 |                                         **105** |
| "4 fact→projection switches, 441 LoC"            |               441 | **219 LoC of switch**, inside 2,058 LoC of file |
| `@shared` names                                  |               586 |                     573 imported / 990 exported |

Exact and re-confirmed: CLI `tui/state` 5,764; `restartRepair.ts` 415; `SessionStores.ts` 549;
`@controllers/` consumers 1/44/44/0; 11 ALS reads of which 8 are `runScope`-only; 4
`StreamSnapshotStore` write-owners.

### Withdrawn as net-positive

- **The CLI's 3,600-line `chat/tui/state/` mirror.** Real, and confirmed at 5,764 LoC for the
  directory. But deleting it requires the runtime to own a _reactive projected view_ — a new
  element — and the extension independently pays the same cost (`ProgressFactApplier` 974 +
  `ProgressViewState` 673). Two hosts paying the same cost separately **is** the definition of
  genuine divergence here. Not harvestable at negative LoC.
- **Moving the 6 product modules out of `runtime/`** — 0 LoC, 0 elements, churns 6 files; R4.
- **Opening the tool registry** — adds by construction (+80…+150). Correct to do; last on LoC,
  first on foundation.

## 9. The ceiling

None of §6 makes this a _foundation_ while `AgentConfig.toolConfig` carries five LaTeX
booleans (`src/shared/schemas/toolConfig.ts:6-12`), `WorkflowFlowResult` carries
`compileFailures` (`AgentFlowResult.ts:34`), `RunAgentOptions` carries a VS Code feature flag
(`preferHelperModel`, `runAgent.ts:50-56`), and 54 TeXRA tools are welded into a registry with
no public `register`. **The separation is a product-out-of-runtime split, not a tidying.**
§6 is what makes that split possible; it is not a substitute for it.
