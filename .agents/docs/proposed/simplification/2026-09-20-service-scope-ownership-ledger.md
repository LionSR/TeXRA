# Service scopes and ownership: the investigation ledger

Date: 2026-09-20
Status: proposed
Baseline: `main` at `3378a967`, re-verified at `e33e64f9` on the survey branch.
Origin: a `find-simplification` pass over the service-injection map recorded in
[the post-refactor survey](../architecture/2026-09-20-post-refactor-architecture-survey.md).
Three investigators, one per scope (session, run and call, process and module
globals), each holding the standing rules (AGENTS.md "Code quality rules",
checklist §13 to §15, the "no new carriers" constraint of the
[2026-08-16 injection audit](../../archived/simplification/2026-08-16-services-injection-audit.md)
§4) and the recorded rulings (D5, D26 and the runtime-slot ruling in the
[rulings ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md);
the `provideAgentEngine` in-file ruling from #10475).

The headline: of the fourteen candidates the injection map raised, **eight are
refuted on evidence**, six survive as bounded deletions, and one needs a
maintainer re-ruling rather than a PR. The refutations are the more valuable
half, because each was a plausible first proposal that an autonomous pass
would raise again. They are recorded here so they are not re-mined.

## 1. What the context system actually is

Three facts drive every verdict below; two of them the earlier survey got
wrong.

1. **There is one runtime per process and no session runtime.**
   `ProcessServices` (`src/platform/processRuntime.ts:46-60`) lists fourteen
   tags and no session tag. `executeAgent` is typed
   `Effect<…, Error, ProcessServices>` (`executeAgent.ts:477`) and runs on the
   process runtime. Session services reach a program only by explicit
   `provideService` from a `SessionHandle` parameter; the `Sessions`
   `LayerMap` entry's context (`sessionLayer.ts:684-686`) never escapes the
   map. There is no `session.context`, no `Context.merge`, no per-session
   runtime anywhere. Consequently the `RunLedger` provision at
   `executeAgent.ts:143` is **not a shadow**: it re-injects the same instance
   `graph.ledger` yielded at `sessionLayer.ts:284`, and it is the only
   provider a run program can see. The same holds for `sessionFsLayer` at
   `:144`.
2. **Tools cannot reach `AgentRun`.** `ToolServices`
   (`src/agent/runtime/ToolServices.ts:14-15`) is
   `ProcessServices | Runs | ToolCall | WorkspaceFs | StorageFs | Scope`.
   Adding `AgentRun` would make every tool unrunnable at the run-free call
   boundary (the extension's language-model bridge,
   `packages/extension/src/frontend/lm/registerLanguageModelTools.ts:60-126`,
   which provides `ToolCall` with `run: undefined` for three registry tools).
   "Derivable from `AgentRun`" therefore means "derivable from `call.run`",
   and `run` must stay optional.
3. **The `SessionOwner` faces are not called outside fibers.** Every
   production caller of the two synchronous faces (`current`, `held`) is
   already inside `Effect.gen` or `Effect.sync`; what they need is
   non-waiting semantics, because `held()` must not block on an entry that
   is still building (`sessionLayer.ts:811-829`). `runtime` is the one face
   that is genuinely synchronous, because `composeProcess`
   (`packages/agent/src/effect/runtime.ts:175,199`) is synchronous by
   contract. `runtime.dispose()` unwinds sessions but does not settle them:
   `closeAdmissions`, run kill and `awaitDrained` live only in
   `closeSession` (`sessionLayer.ts:858-905`), which is why every host orders
   the sweep before disposal.

## 2. Target layering, per scope

Diagram-able: tag, built by, one provider.

**Process** (`installProcessRuntime`, `sessionLayer.ts:1049-1147`, unchanged
as the one composition):

- stdlib: `FileSystem`, `Path`, `HttpClient`, diagnostics logger.
- `GlobalStorageFs` ← `globalStorageFsLayer(globalStorage)`.
- **`GlobalDatabase` (new)** ← `databaseLayer('persistent')` at the global
  root, beside `GlobalStorageFs`; replaces `withScopedDatabase`. Design in
  [its own note](./2026-09-20-global-database-process-service.md).
- `ProcessIdentity` ← `Layer.effect` over `processStart`, provided **outside**
  `Layer.fresh` so it builds once.
- `Secrets`, `AppState` (required, not optional), `SupabaseAuth`,
  `LanguageModel`, `AgentResume`, `SetupPlatform`, `EditorModel`,
  `ToolInjections` ← `Layer.succeed` over host values, as today.
- `InquiryRecords`, `UpdateCheckRecords` ← `Layer.effect` over
  `GlobalDatabase`.
- `LeanLanguageServices` ← host layer, absorbing `leanServerRegistry`'s map.
- **`UsageLog` (new)** ← `Layer.scoped`; replaces the singleton bracketed by
  hand at four roots.
- `Sessions` ← `LayerMap.make`.

**Session** (`Sessions` entry, `Layer.fresh`): `WorkspaceRoots` → `Database`
→ `SessionEvents` → `RunLedger`; the sources and the view; one `Session`
value in the entry context. `Runs` stays a tag (eight tool-body consumers
with no session parameter, `ToolServices.ts:15`), provided from the handle
at the run and request entries as today. `Requests` is deleted as a tag.

**Run** (`runLayerFor`, `executeAgent.ts:117-145`): `AgentRun` (which reads
`ToolInjections` from context itself), `ModelInvoker`, `FollowUps`,
`RunLedger` and `WorkspaceFs`/`StorageFs` provided once from the handle.
Launch assembly under a `Scope` instead of the hand-rolled `resources`
unwind stack.

**Call** (`toolUseDispatch.ts:420`): one `ToolCall` of eight fields:
`roots`, `run` (optional), `toolCallId`, `userInstruction`, `tracker`,
`workPlanState`, `hooks`, and `workingDirectory` if the twelve readers on
possibly run-free paths keep it. Two providers stay, the loop and the
language-model bridge, because `run: undefined` is a real state.

## 3. Candidates

### 3.1 Proceed

| Id  | Candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                  | Deletes                                                                                                                                                                               | Owner                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| S1  | **Delete the `Requests` tag; narrow the session entry context to `Session`.** Its only consumer, `sweepLeftoverRuns.ts:34-35`, already takes `session: SessionHandle` and can read `session.requests` and `session.runs` (`SessionHandle.ts:232,249`). `heldSession` (`sessionLayer.ts:829-830`) reads `session.runs` instead of `Context.get(held.value, Runs)`.                                                                                                                                                                                                                                                                  | `runApprovalQueue.ts:388-401`; `sessionLayer.ts:50,660-661,685-686,751,830`                                                                                                                                                                                                                                                                                                                                               | 1 export, 2 `provideService`, 2 `Context.add`, 1 `Context.get`, the `Sessions` type union 3→1; ≈ −30 LoC, 0 additions                                                                 | #12425                                      |
| R1  | **`ToolInjections` read from context in `agentRunLayer`, not threaded.** `resolveAgentTools` has one caller (`AgentRun.ts:196-205`); the value is forwarded byte-identical through six frames from `executeAgent.ts:481/647` to `agentToolResolution.ts:175`. `ToolInjections` is a `ProcessServices` arm (`processRuntime.ts:58`) and `agentRunLayer` already builds under it. The reflection discriminator moves onto `ctx.setting.agentCategory`.                                                                                                                                                                               | `executeAgent.ts:113,122,197,223,258-263`; `AgentRun.ts:163,202`; `agentToolResolution.ts:68,133`                                                                                                                                                                                                                                                                                                                         | 2 params, 1 interface field, 1 options field, 2 `yield*`, 4 pass sites, likely `NO_TOOL_INJECTIONS`; ≈ −25 LoC, zero reader changes                                                   | #12882                                      |
| R2  | **Launch assembly under a `Scope`.** The `resources: Array<() => void>` stack (`AgentLaunchContext.ts:396,609,630`) with its reversed unwind, and `disposeTrace` (`:588`, called from `AgentRunLifecycle.ts:699` in `Effect.ensuring`) are a hand-rolled finalizer pair for `createRunTrace`.                                                                                                                                                                                                                                                                                                                                      | `AgentLaunchContext.ts:396-442,588,625-642`; `AgentRunLifecycle.ts:699`; `launchContextTestUtils.ts:103`                                                                                                                                                                                                                                                                                                                  | the array, the unwind block, the field, one call, one test double; ≈ −25 LoC, −4 elements. `childRun.ts:103-125` keeps its own `disposeTrace`, so one duplicate survives              | #12882                                      |
| R3  | **Delete the five `ToolCall` fields whose readers all hold a non-null `run`.** `delegationAgentScope` (2 readers), `model` (6, all on `DelegationParent`), `onApprovalPolicyDenial` (5), `trace` (1), `stopAfterCycle` (2) are copies of `run.…` provided at `toolUseDispatch.ts:420-441`. `workingDirectory` (12 readers, some run-free) and `roots` (~60, read with `run: undefined`) stay flat.                                                                                                                                                                                                                                 | `ToolCall.ts:12-37`; readers listed in the investigation                                                                                                                                                                                                                                                                                                                                                                  | 5 fields, 5 provision lines, ~11 reader lines edited, no `?.` added; small net. Also the dead `tracker` at the LM bridge (`registerLanguageModelTools.ts:113`)                        | #12882                                      |
| R4  | **One `sessionFsLayer` provision per host dispatch root.** 24 sites, none inside a run: 23 host-request paths (extension 11, desktop 6, CLI 4) and the LM bridge. `extensionCommandSurface.ts:74-76` `onSessionFiles` already has the shape and five command files bypass it; `extensionHostRequests.ts:1075` wraps `dispatch`, so `:394,696` are double provisions.                                                                                                                                                                                                                                                               | sites: `extensionHostRequests` 394/696/1075, `extensionCommandSurface:76`, `memoryHandlers:45`, `openBuild:261`, `extension.ts:743`, `figCommands:100`, `latexdiffCommands:388`, `gitCommands:372`, `openFileCommands:57`, `sampleProjectCommands:88`; `desktopHostRequests:179`, `desktopSettingsIpc` 195/210/222/280, `desktopPreviewHost:210`; CLI `memory.ts:112`, `clipboardImage.ts:214`, `memoryCommands.ts` 22/32 | 23 → about 5 provisions; ≈ −40 LoC                                                                                                                                                    | #12884                                      |
| P1  | **`GlobalDatabase` process service replaces `withScopedDatabase`.** Each call builds a fresh `databaseLayer` plus `WorkspaceRoots` plus `ProcessIdentity`, runs four pragmas and the schema, and forks a 250 ms `data_version` poll (`Database.ts:405-425`) for one key write. A per-operation handle also makes the `Database`'s reactive surface dead for these callers.                                                                                                                                                                                                                                                         | `Database.ts:1279-1294`; callers `updateCheckRecords.ts:14`, `appStateStore.ts:128,135`, `inquiryRecords.ts:31`, `cli/…/inputHistory.ts:40`; sixth hand build `desktopProjectRecords.ts:17-27`                                                                                                                                                                                                                            | `withScopedDatabase`, `withDatabase`, `inGlobalDatabase` and two layer params, `inputHistory`'s `access` wrapper, the desktop `Layer.build`; ≈ −90 LoC, −6 layer builds per operation | #12422; design in the companion note        |
| P2  | **`UsageLog` as `Layer.scoped` in the process layer.** The singleton's `initialize`/`dispose` are bracketed by hand at `extension.ts:722,789`, `desktop/platform/index.ts:250,254`, `cli/initPlatform.ts:404,418`, in three different shutdown phases. A service whose lifetime is the runtime scope is the fix for that defect.                                                                                                                                                                                                                                                                                                   | `src/telemetry/UsageLogService.ts` (`owner` guard `:223`)                                                                                                                                                                                                                                                                                                                                                                 | `initialize`, `dispose`, `shutdown`, the re-entrancy guard, six host call sites; ≈ −60 LoC                                                                                            | #12076, cross-referenced from #12884 step 5 |
| P3  | **`appState` required; `refusingStateStore()` for the CLI `clone` entry.** The optionality has exactly one omitter (`cliProcessRuntime.ts:83-91,120-131`, a possibly read-only root), and the `Layer.empty as Layer.Layer<AppState>` cast at `sessionLayer.ts:1077-1082` fakes a service into the type. A ~10-line store whose `update` fails `StateWriteFailed` and whose synchronous `get` throws a defect naming the clone entry turns the untyped missing-service defect into a tagged refusal on writes and keeps reads as loud as the omitted layer; a `get` that returned its fallback would silently read as absent state. | `sessionLayer.ts:1077-1082`; `cliProcessRuntime.ts` `options?: { appState: 'omit' }`, `omitAppState`, the spread                                                                                                                                                                                                                                                                                                          | the cast and its comment, the optional field and its doc, the CLI option, both ternaries; ≈ −45/+12 LoC, −2 optional fields, +1 const                                                 | #12422                                      |
| P4  | **Provide the identity layer outside `Layer.fresh`.** `services` is passed twice (`sessionLayer.ts:1088,1089`); inside the entry's `Layer.fresh` (`:733-737`) the eleven layers rebuild per session, three of them real effects (`ProcessIdentity`, `InquiryRecords`, `UpdateCheckRecords`). The `fresh` exists for the sources and the database (`:719-726`), not for identity.                                                                                                                                                                                                                                                   | `sessionLayer.ts:727-744,1085-1111`                                                                                                                                                                                                                                                                                                                                                                                       | the `identity` parameter on `Sessions.layer` and `sessionLayer`, ≈ −8 LoC, three rebuilds per open. Must be proven by a test, not by reading: `Layer.fresh` scoping is subtle         | #12422                                      |
| P5  | **Delete the SDK `Runtime` tag.** Declared at `packages/agent/src/effect/runtime.ts:264`, exported from `effect.ts:23`, provided by its own `Runtime.layer` at `:285`, never `yield*`ed anywhere in the repo. The SDK surface is frozen but unpublished, so this shrinks the frozen set.                                                                                                                                                                                                                                                                                                                                           | `runtime.ts:264-286`, `effect.ts:23`                                                                                                                                                                                                                                                                                                                                                                                      | 1 service class, 1 public export, 1 `Context.add`; `Runtime.layer` becomes `Sessions.layer(platform)`; ≈ −25 LoC                                                                      | agent SDK Tier-1 manifest work              |
| P6  | **Six installed-port slots with `set*` installers**, the shape the 2026-09-19 ruling retired for process roots: `runtimeModelRegistry.ts:61`, `modelAvailabilityWarning.ts:8`, `runtimeSkills.ts:32`, `InlineCommentTool.ts:60`, `nativeSubagentStrategy.ts:89`, `shortcutPreferences.ts:42`. Each needs its own consumer read before it is priced; listed as a lane, not costed.                                                                                                                                                                                                                                                  | the six files                                                                                                                                                                                                                                                                                                                                                                                                             | up to 6 `let`s, 6 installers, 6 host calls; ≈ −60 LoC if all six clear                                                                                                                | #12071                                      |

### 3.2 Needs a ruling, not a PR

**R5, `AgentEngine` as a process service.** The cycle
`@tools/registry → DelegationTools → subagentRun → nativeSubagentStrategy → executeAgent → AgentRun → getDefaultToolRegistry → @tools/registry`
is real (`nativeSubagentStrategy.ts:66-74`, `AgentRun.ts:39`). A tag module
with type-only imports breaks it, since erased imports contribute no bundle
input and `toolRegistryCycle.vitest.ts:26-28` counts bundle inputs;
provision as a `ProcessServices` arm beside `ToolInjections`
(`processRuntime.ts:22,58`) from `installProcessRuntime` widens no host
import baseline. The #10475 in-file ruling and the 2026-08-16 audit's
constraint §4 forbid converting the slot to an **explicit parameter**; a
context tag is not that, and it satisfies both of the ruling's stated
reasons. But the constraint is categorical and the LoC gain is about zero:
the win is that the module slot, the import side effect
(`executeAgent.ts:788-795`) and the throwing accessor become unrepresentable.
A reviewer will call it a construct for a construct under §14 R6 unless the
maintainer names that defect class as worth a tag. Ask; do not open a PR.

### 3.3 Refuted, with the evidence

Do not re-propose these as specified.

| Candidate                                                                   | Why it fails                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `Session` tag in `src/shared/session/`                                    | `config/ratchets/architecture-edges-baseline.json` has no `shared → agent` pair; the tag's shape is `SessionHandle` (`@agent/runtime`), so even a type-only import is a `new-edge` failure in `subsystemEdgeRatchet.vitest.ts:30`. CLAUDE.md separately bars new `@agent/*` imports in `src/shared`. The shared tags this was modelled on define their shapes locally.                                                                              |
| A `Session` tag exported from `@agent/runtime/SessionHandle`                | Legal, but +1 export and 0 deletions: the 227 `session:` annotations in 107 files are host and domain code, not Effect requirers, and `roots` alone is 47 % of member reads, concentrated in non-Effect host handlers. Every requirer would still `provideService(Session, …)` at the sites that provide `Runs` today.                                                                                                                              |
| `Runs` and `Requests` as `Layer.effect` from `Session`                      | Adds two layers to delete zero provisions; callers must provide `Session` and the layers.                                                                                                                                                                                                                                                                                                                                                           |
| `SubscriptionRef` plus `Effect.runSync` replacing `HeldSessions`            | The sync faces exist to not wait on a building entry (`sessionLayer.ts:811-816`); a `runSync` on a lazily built layer is the second mechanism D5 names. Element count is a wash.                                                                                                                                                                                                                                                                    |
| `current`/`held` as Effects, deleting `HeldSessions`                        | Zero production breaks, but 414 `testDefaultSession()` call sites in 45 suites and one dev harness, for ~35 LoC. Fails the tests-are-a-budget bar.                                                                                                                                                                                                                                                                                                  |
| `SessionOwner` global onto a tag                                            | D5 stands: `installedProcessRuntime()` must answer synchronously for `composeProcess`.                                                                                                                                                                                                                                                                                                                                                              |
| The `RunLedger` "shadow" at `executeAgent.ts:143`                           | Same instance, not a second build, and the only provider a run program can see (section 1, fact 1). Removing it needs a session runtime or a context carrier: a new carrier.                                                                                                                                                                                                                                                                        |
| Tools reading `AgentRun` from context                                       | `ToolServices` has no `AgentRun` and cannot, because of the run-free bridge (fact 2).                                                                                                                                                                                                                                                                                                                                                               |
| The second `ToolCall` provision at the language-model bridge                | A genuine call boundary: three registry tools exposed to Copilot Chat with no run, no session, no ledger. A narrower tag would fork `ITool`'s `R` across fifty `defineTool` modules.                                                                                                                                                                                                                                                                |
| `hooks.recordSubagentCost` moved onto the tool result                       | The child-run loop rolls cost in after the tool call returned for detached children (`subagentRun.ts:99-101`); the settlement row consumes it at `toolUseDispatch.ts:573-581`.                                                                                                                                                                                                                                                                      |
| `stopped` + `interrupt` replaced by fiber interruption                      | Twelve synchronous host callers reach `interrupt()` through `RunHandle`/`runRegistry` with no fiber handle, and `failIfLaunchStopped` races the `Deferred` at eleven sites before any fiber exists. The `Deferred` is what makes stop callable from a synchronous surface. The honest residue is one duplicated alias (`AgentRun.ts:151,318`).                                                                                                      |
| `AppState`/`Secrets` as `Layer.scoped` over `FileSystem`                    | The original proposal reverted #12553 without removing its synchronous state-read dependency. The complete Effect-native StateStore cutover supersedes only AppState construction: SQLite state is now acquired in the existing runtime scope, host Mementos use AppState.layer, and dependent agent directories capture the store through their layer. Secrets and process identity still resolve at bootstrap; the process-install latch remains. |
| `Context.Reference` for a default `AppState`                                | A default store is the silent-degradation shape §15 forbids. Zero uses repo-wide, and it should stay that way.                                                                                                                                                                                                                                                                                                                                      |
| The six `PerKeyLane` maps as services                                       | Self-pruning: `withPerKeyLane` deletes the entry when the last holder settles (`perKeyQueue.ts:93-97`), so all are empty at rest. Pure net-add.                                                                                                                                                                                                                                                                                                     |
| `registry.ts`, `toolAvailability`, `apiProviders`, once-warn latches, memos | Class C: lazy memos of immutable tables, a class-not-bare-`let` cache, a `WeakMap` keyed by the secrets store. Keep.                                                                                                                                                                                                                                                                                                                                |
| `EditorModel` as a dead tag                                                 | Not dead: read through `Effect.serviceOption` at `modelBinding.ts:888`, bound at `:1050`, supplied by the extension (`extension.ts:265-268`). Zero requirers is not zero consumers.                                                                                                                                                                                                                                                                 |
| `ExternalRoots` as a standalone service                                     | One writer (`packages/extension/src/frontend/setup.ts`), four VS Code-free readers, keyed by kind not by session; a process-wide allowlist with a sound freeze rule. Correct shape is a process service, but that is +4 signatures for 0 deletions today. Recorded as a hazard on #12071: the desktop and SDK share one allowlist across roots the day either registers.                                                                            |

### 3.4 Suspected defect, unconfirmed

`hooks.recordSubagentCost` has no `accepting` latch, unlike `onToolOutput`
(`toolUseDispatch.ts:437` versus `:465`), so a post-settlement call silently
increments a dead local. Not confirmed by execution. Filed with the R-lane
comment on #12882 as a candidate regression test, not as a change.

## 4. Consolidation

No new tracking issue. S1 to #12425, R1 to R3 to #12882, R4 to #12884, P1 to
P4 to #12422 (P2 also to #12076), P5 to the Tier-1 manifest work, P6 and the
`ExternalRoots` hazard to #12071, R5 as a re-ruling request to the
maintainer. The published status page's section 13 is corrected to match.

## 5. Acceptance

- `Requests` has no `Context.Service` declaration; `Sessions`' type
  parameter is `Session`.
- `AgentRunLayerInput` has no `toolInjections` field; `agentRunLayer` yields
  `ToolInjections`.
- `AgentLaunchContext` has no `resources` array and no `disposeTrace`.
- `ToolCall` has no `model`, `delegationAgentScope`, `onApprovalPolicyDenial`,
  `trace` or `stopAfterCycle` field.
- `withScopedDatabase` is no longer exported; its one file-local use serves
  the pre-runtime app-state store, and every caller on the process runtime
  holds the process-scoped handle.
- `UsageLogService.initialize` and `.dispose` do not exist.
- `ProcessRuntimeOptions.appState` is required.
- `packages/agent/src/effect/runtime.ts` declares no `Runtime` tag.
