# Agent SDK / Runtime — Change-Amplification Audit (2026-07-29)

**Status:** Audit of record. Companion to
[`2026-07-29-agent-sdk-readiness-checkpoint.md`](./2026-07-29-agent-sdk-readiness-checkpoint.md)
and its `-06-25` → `-07-27` chain. That chain asks "is the shape SDK-ready";
this one asks a different question: **how many files does one logical change
force you to edit, and how many should it force?**

Inspected at HEAD `8116ce9` (`Stop bundling the Codex and Claude Code CLIs in
the desktop app (#9396)`). Method: six probe changes driven end-to-end through
the tree — _add one rendered run fact_, _add one per-run runtime flag_, _add one
provider_, _add one tool that needs its own approval_, _add one host-interaction
kind_, _add one persisted field_ — each counted by grep, then adversarially
re-verified by a second pass that recounted every number and killed three
collapse proposals. Production and test call sites are counted **separately**
throughout; tests are migration cost, never justification.

Items already on the standing record (ModelHandler god-class, `createChannelTrace`,
the `@agent` barrel split, tool-registry closure, product-type leakage into the
launch path, `RunScope`/`RunContext` duality, `AgentFlowResult` twins, the
canonical/legacy snapshot twin, the reverted `MapToolRegistry` narrowing) are
**not re-filed here**. Where they corroborate a finding they are tagged
`[TRACKED]`.

## 1. Verdict

**One root cause produces 8 of the 12 findings: a closed set of names is
declared as a hand-written literal list N times, at boundaries where nothing
derives one list from another.** Approval kinds (12 declarations, 3 mutually
incompatible spellings), provider identity (9 files), the per-run flag trio
(4 declarations inside one 140-line file), run-fact subscription filters
(2 hand-copied arrays), the region toggle (5 files, 5 copies of one boolean) —
all the same shape. The remaining three findings are a second, smaller cause:
**policy resolved at the call site instead of at the owning boundary**
(`detachActiveChildren`, the compatibility-key backfill, the todo list's three
writers). §3.12, added later, is the root cause in its purest form: not a list
of names but a _formula_, restated in 12 files because no module owns it.

**The repo already contains the fix, three times, and where it is applied there
is zero drift.** `RunFactHandlers` is a mapped type over `RUN_FACT_EVENT_TYPES`
(`src/controllers/progressView/backend/events/ProgressFactApplier.ts:85-93`);
`apiKeyEnvName`/`apiKeySecretName` derive from `API_KEY_PROVIDER_IDS` with a
one-row override (`src/model/apiProviders.ts:13-36`); `PROVIDER_ENDPOINT_SETTINGS`
derives its catalog rows from `PROVIDER_ENDPOINT_STATE_ENTRIES`
(`src/shared/schemas/stateSettings.ts:254-268`). Every one of those is
amplification-free. Every hand-listed twin next to them has **already drifted in
fact** — this audit measured **nine live divergences**, listed in §1.1.

**This is not "the runtime is a mess."** The spine is sound: `ExecutionRegistry`,
`StreamStatusMachine`, `SessionEventHub`, `SessionHandle`, `ChildRunStrategy`,
`hostInteractionResultMappers`, `resolveAndResumeStream` and the three-bus split
were all examined and all do real work — §4 records them so future passes stop
re-proposing them. The amplification is concentrated in **declaration tables and
host adapters**, not in the execution machinery.

**One collapse proposal was rejected outright** (the run-fact wire census, §3.11)
because its arithmetic did not survive recounting. It is retained as a map, not
as work.

### 1.1 Drift already realized (not hypothetical)

| #   | Divergence                                                                                                                                                                              | Site                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 5 of 12 providers have no icon → generic robot glyph in every model dropdown                                                                                                            | `src/shared/utils/icons.ts:23-63` (8 entries) vs `src/shared/constants/providers.ts:56-231` (12 ids)                                         |
| 2   | CLI validation env allowlist missing `META_API_KEY` and `KIMI_CODE_API_KEY`                                                                                                             | `packages/cli/scripts/validate-run.mjs:42-52` (10 entries)                                                                                   |
| 3   | `stopStream` hardcodes `detachActiveChildren: true`, ignoring the user setting honored 600 lines above it                                                                               | `packages/cli/src/chat/chatSessionController.ts:883` vs `:285`                                                                               |
| 4   | desktop `openExternalInquiry` does not `revealStream`; extension does                                                                                                                   | `packages/desktop/src/main/desktopHostInteractions.ts:190-197` vs `packages/extension/src/progressView/extensionHostInteractions.ts:292-296` |
| 5   | desktop `requestRetry` used to resolve `{action:'cancel'}` immediately, killing runs the user was never asked about — fixed, root cause (the clone) still present                       | `packages/desktop/src/main/desktopHostInteractions.ts:156-164` (in-code postmortem)                                                          |
| 6   | `activeForm` silently stripped on every `readTodos()`                                                                                                                                   | `src/agent/storage/ExecutionKVStore.ts:83-86` vs `src/shared/schemas/todo.ts:16-23`                                                          |
| 7   | TUI run-fact filter omits `run.start`; snapshot-store filter omits 3 more — new facts never reach the TUI, the snapshot, or the trace viewer, with no compile error                     | `packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts:393-405`, `src/transcript/StreamSnapshotStore.ts:477-486`                           |
| 8   | Region-default guardrail skips `dashscope`/`minimax` (`if (setting.defaultValue === undefined) continue`) — a flipped prefault would route to the wrong host while the UI shows Off     | `src/test-kernel/shared/settingsConfiguration.vitest.ts:106`                                                                                 |
| 9   | Compatibility-key backfill: 1 of 6 sites skips logging, 4 of 6 stop one fallback short, 4 of 6 discard the inferred key, and the same persisted field has 3 different Zod null policies | `src/agent/runtime/SessionResumeRetrieval.ts:270`, `nodes/types.ts:42-45` vs `ReflectionFlowState.ts:50` vs `SessionResumeRetrieval.ts:91`   |

Two documentation claims are falsified by the code they describe:
`src/agent/runtime/detachSubagentsOnStop.ts:9-13` asserts the policy "has one
source of truth" (item 3 above), and `src/shared/constants/providers.ts:51` says
"To add a new provider: add a single entry here" (9 files). The
`-07-29` checkpoint cites the former as a **strength** (split point #3); this
audit corrects that entry.

## 2. The amplification table

Sorted by wasted effort eliminated (`today − after`).

| #   | Seam                                             | The one change                                            | Files today | Files after | Effort | Novelty                            |
| --- | ------------------------------------------------ | --------------------------------------------------------- | ----------- | ----------- | ------ | ---------------------------------- |
| 1   | Approval / host-interaction kind vocabulary      | add one tool with its own approval card                   | 31          | 12          | L      | [NEW]                              |
| 2   | Per-run runtime flags (`RunFlags`)               | add one per-run flag settable by SDK + CLI + VS Code      | 17          | 7           | M      | [EXTENDS-TRACKED]                  |
| 3   | `detachActiveChildren` threading                 | add one stop/kill surface                                 | 7           | 1           | S      | [NEW]                              |
| 4   | Provider identity restatement                    | add one provider                                          | 9           | 5           | M      | [NEW]                              |
| 5   | `modelHandlerCompatibilityKey` backfill          | change how a persisted conversation's format is recovered | 6           | 2           | M      | [NEW]                              |
| 6   | Per-provider China/region toggle                 | add a region toggle to a 5th provider                     | 5           | 1           | M      | [NEW]                              |
| 7   | extension/desktop host-interaction twins         | change any approval-request behavior                      | 4           | 1           | M      | [NEW]                              |
| 8   | Run-fact subscription filters                    | add one run fact and have it reach every consumer         | 3           | 1           | S      | [NEW]                              |
| 9   | Todo list persisted three times                  | add one persisted todo attribute                          | 3           | 1           | M      | [NEW]                              |
| 10  | `WebviewUpdater` pass-through methods            | send one new webview message                              | 2           | 1           | M+     | [NEW]                              |
| 11  | Run-fact → wire → renderer census                | add one rendered run fact                                 | 21          | 20          | —      | census only, **collapse rejected** |
| 12  | `streamId` as a lossy composite of `executionId` | recover either run id when you hold the other             | 12          | 1           | M      | [EXTENDS-TRACKED]                  |

Findings 1 and 7 overlap: 7 is a strict subset of 1's blast radius and doing it
first halves 1. Finding 10 is one of 11's edit sites. Finding 12 was added after
the six probes closed (see §3.12 and §6). See §5.

## 3. Findings

### 3.1 Approval / host-interaction kind vocabulary — 31 → 12 files [NEW]

**Cost today.** Probe: add one tool needing its own approval card. Measured
against `userQuestion`, the most recent kind actually added:
`rg -l 'userQuestion|UserQuestion|USER_QUESTION' src packages` excluding
`src/test-kernel`, `*.md` and `packages/cli/scripts` returns **38 production
files**; 7 are dedicated new files that would exist under any design
(`src/tools/userQuestion/{UserQuestionTool.ts,index.ts}`,
`UserQuestionPanel.{ts,styles.ts}`, `modals/UserQuestion{.tsx,State.ts}`,
`runtime/userQuestionAnswer.ts`). **31 pre-existing production files edited in
lockstep.** Tests: 10 files, of which four are per-kind suites totalling 1,564
lines (`ExtensionHostInteractions.vitest.mts` 806, `DesktopHostInteractions.vitest.mts`
476, `ApprovalRequestHandlerSet.vitest.ts` 194, `HostInteractionSettlements.vitest.ts` 88).

The reusing case is healthy and is **not** a finding: a tool that reuses bash or
toolEdit approval declares `requiresApproval` once (24 sites, all `src/tools/**`)
and is read by exactly 3 generic consumers
(`src/agent/runtime/agentToolResolution.ts:155`,
`src/agent/core/flows/ResponseCycleFlow.ts:231`, `packages/agent/src/index.ts:205`).

Twelve declarations of the 7-name vocabulary, in **three mutually incompatible
spellings** (verified by reading all four in one pass):

| Spelling               | Site                                                                                | `plan`                        | `proposal`               |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------- | ------------------------ |
| A (canonical)          | `src/agent/runtime/HostInteractions.ts:180-187`                                     | `plan`                        | `proposal`               |
| A (copy, no type link) | `packages/agent/src/index.ts:31-42`                                                 | `plan`                        | `proposal`               |
| A (5-arm copy)         | `packages/extension/src/progressView/extensionHostInteractions.ts:79-85`            | `plan`                        | `proposal`               |
| A (5-arm copy)         | `packages/desktop/src/main/desktopHostInteractions.ts:72-78`                        | `plan`                        | `proposal`               |
| B (handler keys)       | `src/controllers/progressView/backend/progressBackendUiConfig.ts:36-62`, `:132-140` | `planApproval`                | `agentProposal`          |
| C (wire)               | `src/shared/utils/uiConstants.ts:1-9`                                               | `planApproval`                | `proposal`               |
| C (wire, re-typed)     | `src/shared/schemas/progressView/outbound.ts:181-189`                               | `planApproval`                | `proposal`               |
| D (CSS selectors)      | `packages/extension/src/progressView/frontend/components/RequestPanelsState.ts:9`   | `plan-approval-request-panel` | `proposal-request-panel` |

Plus `PermissionGroups` (`RequestPanelsState.ts:12-19`),
`createEmptyPermissionGroups` (`:22-31`), `KIND_TO_GROUP` (`:34-42`),
`PermissionState` (`packages/extension/src/progressView/frontend/permissionState.ts:42-43`),
two CLI policy switches (`packages/cli/src/chat/tui/appInteractionPolicy.ts:193-196`,
`:205-217`), and the seven `handle<Kind>Action` methods plus seven pure-forward
dispatch arms in `src/controllers/progressView/ProgressViewCommandHandlers.ts:104-133,285-299`.

The measurable cost of the spelling split:
`src/controllers/progressView/backend/progressBackendUiConfig.ts:89-117` is a
29-line switch whose entire body is
`cancelled += cancelHandler(handlers.<renamed>, kind, selector)` — 3 of 5 arms
are literally `handlers[kind]`.

**Why it exists.** No reason survives inspection.
`PendingInteractionKind` — the union that ought to be canonical — has **zero
cross-file production consumers**: `rg 'PendingInteractionKind'` returns 5 hits,
all inside `HostInteractions.ts` (`:236,:245,:325,:573`). It cannot catch a miss
anywhere else. Four of the twelve tables _are_ compile-enforced
(`cancellationResultFactories` mapped type `HostInteractions.ts:191-206`,
`APPROVAL_REQUEST_HANDLER_KEY_MAP` `satisfies` `:132-140`, `KIND_TO_GROUP`
`Record<PermissionState['kind'],…>`, the CLI `assertNever` switches); the other
eight fail silently.

**Collapse.** Three independent steps, cheapest first.

1. **Delete** the inline union at `packages/agent/src/index.ts:31-42`; re-export
   `PendingInteractionKind`. 8 lines → 1. The SDK stops shipping a private copy
   of a core vocabulary. Self-contained.
2. **Derive** `PermissionKindSchema` (`outbound.ts:181`) from `PERMISSION_KIND`.
   Note: `outbound.ts` does **not** currently import `uiConstants` (the finder
   claimed it sits "four lines away"; it does not) — this adds a cross-import.
3. **Rename** `ApprovalRequestHandlerSet.planApproval → plan` and
   `.agentProposal → proposal`, collapsing spelling B into A. **Keep** the
   generic per-kind payload typing. **Replaces:** the 29-line translator
   at `progressBackendUiConfig.ts:89-117` becomes a loop.

**What breaks.** Step 3 is a wire-vocabulary rename crossing the webview IPC
boundary. Host and webview ship together and the values are transient UI state,
not persisted, so there is no compatibility window — and the blast radius is
smaller than it looks: every frontend consumer goes through the `PERMISSION_KIND`
constants, and `rg "'planApproval'"` over src+packages returns only 8 hits, 3 of
them tests.

**Correction to the collapse, proved empirically.** The one-liner
`for (const kind of kinds) cancelled += cancelHandler(handlers[kind], kind, selector)`
**does not typecheck** — reproducing the generic shape under `tsc --strict`
yields `TS2345: Argument of type 'H<Bash,"requestId",boolean> | H<Retry,"streamId",string> | …'
is not assignable to parameter of type 'H<Retry,"streamId",boolean>'`. The
switch's per-arm concrete typing is doing real inference work for
`cancelHandler`'s `K extends keyof T` constraint. Widening `cancelHandler`'s
first parameter to a structural
`interface Cancellable { cancelWhere(p: (item: {streamId: string}, s?: string) => boolean, cause?: string): number }`
makes the loop compile (verified, exit 0). Report step 3 as **rename +
de-generify `cancelHandler`**, not "delete the switch".

**Realistic target: 31 → ~12, not 8.** The residue (payload schema, progressView
panel, CLI modal, the tool, the per-kind result type) is genuinely new code.

### 3.2 Per-run runtime flags have no named type — 17 → 7 files [EXTENDS-TRACKED]

**Cost today.** Personally recounted with
`rg -l … --glob '!src/test-kernel/**' --glob '!*.md'`:
`runtimeUnavailableTools` **17** production files, `approvalPromptsUnavailable`
**16**, `stopAfterCycle` **14**, union **24**. Test files touching the three:
**16**.

The concept is declared **four times inside one 140-line file**, verbatim
(read at `src/agent/runtime/RunContext.ts`):

```
:11-14  RunContextCommon          { approvalPromptsUnavailable?, runtimeUnavailableTools?, stopAfterCycle? }
:49-52  CreateRunContextCommon    byte-identical field set; only `readonly` differs
:84-85  CommonRunContextFieldNames  the same three names as a string-literal union
:94-97  commonRunContextFields    the same three names hand-copied into an object body
```

A fifth restatement at `src/agent/runtime/AgentLaunchContext.ts:116-119`:
`Pick<CreateLaunchRunContextOptions, 'approvalPromptsUnavailable' | 'runtimeUnavailableTools' | 'stopAfterCycle'>`.

Hop-by-hop for one value, classified forward-vs-transform: of ~27 hops **exactly
3 do work** — `new Set(...)` at `agentToolResolution.ts:139` and
`ResponseCycleFlow.ts:226`, and the only merge, `runExecution.ts:280-283`
(concats `CLI_UNAVAILABLE_TOOLS`). Every other hop copies unchanged:
`executeAgent.ts:388-390,540-541`, `resumeQueuedToolUse.ts:141-142`,
`runToolUseFlow.ts:201-202`, `subagentExecution.ts:132-133,181-182`,
`nativeSubagentStrategy.ts:233-234,293-294`,
`inBandSubagentExecution.ts:496-497`, `workflowScriptAgentRunner.ts:344-345`,
`chatSessionController.ts:492,627,754`, `desktopAgentLaunch.ts:49`,
`desktopAgentResume.ts:177`.

**Why it exists.** `SubagentRunOptions` (`executeAgent.ts:275-280`) is documented
as an anti-drift bag — "Extracted so the three option bags describing the same
run can't silently drift out of sync" — and it works for
`ResumeToolUseFromResumeDataOptions:452` and `ResumeQueuedToolUseOptions:25`.
**The guard stops one hop short.** `NativeSubagentStrategyParams`
(`nativeSubagentStrategy.ts:65-83`) and `InBandSubagentExecutionBaseOptions`
(`inBandSubagentExecution.ts:67-83`) do not extend it and re-declare the same
field names independently — and those are exactly the bags the delegation copies
flow through.

**The "already drifted" claim is struck.** The two `withExecutionRunContext`
literals differ — `executeAgent.ts:387-391` passes all three flags,
`:539-541` passes only two, verified by reading both — but this is **not** a
realized bug. `ToolUseWaitNode.ts:97` returns `{kind:'stop'}` before the
`isSubagent` WAITING branch at `:120-124`, and `post()` maps `'stop'` →
`FlowTransition.COMPLETE`, so a `stopAfterCycle` run never writes a resumable
cursor. `inBandSubagentExecution.ts:487-505` calls `strategy.launch()` directly
for `executionMode:'single-cycle'`, so `nativeSubagentStrategy.runTurn` is
unreachable on that path. State it as **"parity is expressed as two hand-written
literals with nothing enforcing it"**, and treat Step 2's effect on the resume
path as **inert**, not as a fix.

**Collapse.** Name the concept once and carry it as one object.

- **Step 1 (S, mechanical).** Add
  `export interface RunFlags { approvalPromptsUnavailable?: boolean; runtimeUnavailableTools?: readonly string[]; stopAfterCycle?: boolean }`.
  `RunContextCommon = Readonly<RunFlags> & { readonly model?: string }`;
  `CreateRunContextCommon = RunFlags`. **Delete** `CommonRunContextFieldNames`
  (`:84-85`) and the hand-copied body of `commonRunContextFields` (`:94-97`).
  Change `withExecutionRunContext`'s second parameter to `RunFlags` — that
  signature then never changes again. 4 declarations → 1.
- **Step 2 (M).** Nest rather than spread: one `runFlags?: RunFlags` on
  `SubagentRunOptions` (`:292-294`) and `ExecuteAgentOptions` (`:334`);
  `runAgent.ts:30-32`'s three `Pick` entries → `'runFlags'`; both
  `withExecutionRunContext` literals → `options.runFlags ?? {}`.
- **Step 3 (M).** Have `NativeSubagentStrategyParams` and
  `InBandSubagentExecutionBaseOptions` extend the shared base so the documented
  drift guard actually reaches them. The 8 delegation copy sites each become one
  line.
- **Step 4 (S).** `CliExecuteOptions` and `RunAgentInput` carry
  `runFlags?: Partial<RunFlags>`, merged once.

**Keep:** `model` **out** of `RunFlags` — it is a live getter on the launch
variant (`RunContext.ts:117-119`) and a static value on the bare variant
(`:133-135`), and `AgentLaunchContext.ts:126-129` depends on that for
interactive model switching. Keep the `Object.freeze` at `:112`/`:127`.
Keep `CliExecuteOptions` as a host-narrowing seam.

**Why this is a real reduction, not a relocation.** A 4th flag never again
touches the nine pure-forwarding files (`AgentLaunchContext.ts`,
`executeAgent.ts` ×2, `runAgent.ts`, `resumeQueuedToolUse.ts`,
`subagentExecution.ts`, `nativeSubagentStrategy.ts`,
`inBandSubagentExecution.ts`, `workflowScriptAgentRunner.ts`,
`runToolUseFlow.ts`). They forward an opaque bag and drop out of the edit set
permanently. Only sites that **set** or **read** the flag are touched — and
those were always going to be touched.

**What breaks.** (a) Optional-field semantics: several sites rely on tri-state
reads (`approvalPromptsUnavailable !== true` at `agentToolResolution.ts:154`
**and, duplicated verbatim,** `ResponseCycleFlow.ts:230-231`;
`runtimeUnavailableTools ?? []` at `agentToolResolution.ts:139`). Pick one rule
(`options.runFlags ?? {}`) and apply it at every construction site.
(b) 16 test files reference the three flags as flat fields; the bulk of the diff
is `DelegationHeadless.vitest.mts` (9 sites) and
`ToolUseToolResolution.vitest.ts` (8). (c) `runExecution.ts:279-283` **merges**;
it must stay a merge.

**Warning that must survive into the PR.** Do **not** "fix" this by having
`createRunContext` inherit from `tryUseRunContext()`. `executeAgent` builds a
fresh context deliberately (`:387-392`, no parent merge) because the child-run
loop's resume/turn path runs on the host thread **outside** the parent's ALS
frame (see the comment at `runToolUseFlow.ts:188-190`). ALS inheritance would
cover launch and silently drop the flags on every resumed turn.

`WorkflowScriptTool.ts:440,454,472` is a fourth consumer file, and
`subagentExecution.ts:124` (`if (parentContext.stopAfterCycle)`) is the read
that chooses in-band vs native delegation entirely — both belong in the edit
set. `RunAgentOptions.preferHelperModel` on the same path is `[TRACKED]`.

### 3.3 `detachActiveChildren` threaded through every stop surface — 7 → 1 [NEW]

**Cost today.** Personally enumerated every production caller of
`ExecutionRegistry.kill` / `.stopAgentStream`: **exactly 7**, all passing the
option. Six repeat the identical two-token incantation
`detachActiveChildren: detachSubagentsOnStop()` —
`src/tools/ExecutionsTool.ts:712`,
`packages/desktop/src/main/desktopAgentExecution.ts:259`,
`packages/cli/src/chat/tui/runChatTui.tsx:823`,
`packages/cli/src/chat/chatSessionController.ts:285`,
`packages/extension/src/frontend/review/AgentReviewRunController.ts:63`,
`packages/extension/src/commands/agent/agentCommands.ts:12`. The seventh,
`packages/cli/src/chat/chatSessionController.ts:883` (`stopStream`),
**hardcodes `detachActiveChildren: true`** — in the same file as `:285`
(`interruptActiveRun`), which honors the setting. No comment marks it as
intentional. Test sites: 4 explicit passes out of 32 total
kill/stopAgentStream test calls.

**Why it exists.** `src/agent/runtime/detachSubagentsOnStop.ts:9-13` claims the
policy "has one source of truth" and the `-07-29` checkpoint (`:248-249`) cites
it in the **strengths** section. Both are falsified by `:883`.

Worse, the default is silently wrong: `ExecutionStopOptions.detachActiveChildren`
is optional (`executionRegistry.ts:52-54`) and all three reads are `=== true` /
`!== true` (`:455,:601,:611`), so a new stop surface that **forgets** the option
gets the opposite of the user's setting with no warning — CLAUDE.md's
silent-degradation defect.

**Collapse.** In `stopAgentStream` and `kill`, replace the three reads with
`const detach = options.detachActiveChildren ?? detachSubagentsOnStop();`.
`detachSubagentsOnStop()` uses only `tryPlatform()` and `@shared/state/stateKeys`,
so the import stays inside the VS Code-free zone (`SessionHandle.ts:275` already
reads `platform().storage` from the same directory). **Delete** the option from
the six sites that pass `detachSubagentsOnStop()`. **Keep** `:883`'s literal
**only** with a comment justifying why per-stream TUI stop overrides the setting.

**Cheaper variant** if policy-in-core feels wrong: make `detachActiveChildren`
**required** on `ExecutionStopOptions`. That forces every new stop surface to
decide, costs 4 test edits, and still surfaces `:883` as an explicit choice.

**What breaks.** Behavior at `:883` either way — with the setting off (its
default, `detachSubagentsOnStop.ts:19-22`), `stopStream` currently detaches and
would start killing. That is exactly the decision the duplication is hiding; make
it explicitly, with a test. Also: `stopStream` calls
`current.interactions.cancel({streamId, cause:'Run interrupted.'})` at `:876-881`
while `interruptActiveRun` calls `clearApprovals()` at `:280` — a second
inconsistency in the same pair that must be resolved if the paths are unified.
`registry.detachActiveChildren(parentStreamId)` is already covered directly
(`ExecutionRegistry.vitest.ts:1770,1812,1843`); what no test asserts is _"stop
honors the setting."_

### 3.4 Provider identity restated in 9 files — 9 → 5 [NEW]

**Cost today.** Traced against `META`, the newest and structurally simplest
provider (no region toggle, no subscription route, reuses
`ModelHandlerOpenAIResponse`). Nine in-repo production files:
`src/shared/constants/providers.ts:154` (registry) + `:462`
(`API_KEY_PROVIDER_IDS`); `src/shared/state/stateKeys.ts:113` + `:135`;
`src/shared/schemas/usage.ts:18`; `src/logger/redaction.ts:69`;
`src/agent/modelHandlers/support/ProxyConfigResolver.ts:54`;
`src/model/setupModelDefaults.ts:33` + `:54`;
`src/agent/runtime/ModelFactory.ts:128`;
`src/agent/runtime/modelHandlerCompatibilityKey.ts:18`. Plus
`src/shared/utils/icons.ts`, which **should** have been edited and silently was
not (drift #1). Only 4 of the 12 sites are compile-enforced. Test sites: 3 files.

**Why it exists.** `providers.ts:51` claims "To add a new provider: add a single
entry here." Verified false by 8 further edits.

**Collapse.** Widen `ProviderDef` (`providers.ts:12-25`) with the scattered
facts: `baseUrl`, `icon`/`hint`, `preferredSetupModel`. Then:

- **(a)** derive `streamingKey`/`endpointKey` inside `PROVIDER_STATE_ENTRIES`
  (`:217-224`) as `` `texra.streaming.${id}` `` / `` `texra.endpoint.${id}` `` and
  **delete** the 22 per-provider `GlobalStateKey` members
  (`stateKeys.ts:102-113,126-135`; keep `STREAMING_GLOBAL`). Verified safe and
  non-relocating: `rg 'GlobalStateKey\.(STREAMING|ENDPOINT)_'` returns hits in
  exactly **two** files — `providers.ts` itself and two `STREAMING_GLOBAL`
  references at `src/utils/config/providerConfig.ts:55,59`. Nothing enumerates
  the enum, and both consumer signatures take plain strings
  (`StateStore.get(key: string, …)` `src/platform/interfaces.ts:58`;
  `StateSettingEntry.key: string` `src/shared/schemas/stateSettings.ts:113`).
  44 lines collapse to zero.
- **(b)** derive `API_KEY_PROVIDER_IDS` from registry ids + the two keyless
  extras. **Precedent already shipped:** `src/model/apiProviders.ts:13-36`
  derives `API_PROVIDERS`, `apiKeySecretName` and `apiKeyEnvName` from
  `API_KEY_PROVIDER_IDS` with a one-row override.
- **(d)** build `ProxyConfigResolver`'s `BASE_URLS` from the registry.
- **(e)** replace `FALLBACK_MODEL_SOURCE` with a **1-row** override map
  defaulting to the id (`setupModelDefaults.ts:42-55` is identity for 11 of 12
  rows; only `openRouter → ANTHROPIC` is a real override).
- **(f)** build `MODEL_PROVIDER_DECORATORS` from the registry so a new provider
  cannot silently render as the generic robot glyph.

**Keep:** `PROVIDER_HANDLER_ROUTES`, `modelHandlerCompatibilityKey`, the handler
class, and the curated setup-model pick — genuine per-provider decisions.

**Sub-claim (c) is killed. Do not derive `UsageProviderSchema`.**
`src/shared/schemas/usage.ts:6-19` is 13 arms and is **not** a function of the
registry: it carries `'openai-response'` and `'unknown'` with no registry id, it
lowercases `'openrouter'`, and it **omits `kimiCode` entirely**. It is also
persisted — the `provider` field of `NormalizedUsageSchema`
(`src/agent/types/NormalizedUsage.ts:32`), embedded in `AgentState`
(`src/agent/core/state/AgentState.ts:15`) and `RunUsageAccumulator`. Getting the
casing wrong makes every resumed run's usage slice fail to parse. Keep it hand-
written.

**Sub-claim: `RELAY_PATH_SUFFIXES` is killed too.**
`src/auth/serverKeys/ServerSideKeyService.ts:45` is
`Partial<Record<ServerSideProvider, string>>`, META (`hasServerKey:false`)
needed no entry, and its data genuinely differs from `BASE_URLS` (relay deepseek
is `'/v1'`; the direct base is `'https://api.deepseek.com'` with no path).

**Related leak worth fixing in the same pass:**
`src/agent/modelHandlers/openai/modelHandlerOpenAI.ts:1042-1043` does
`return this.config.provider as NormalizedUsage['provider']` — an unchecked cast
from the llm-zoo enum into the hand-maintained Zod enum — and
`src/agent/utils/UsageMonitor.ts:273` swallows the mismatch with
`UsageProviderSchema.catch('unknown').parse(...)`. A forgotten arm silently
mislabels billing telemetry at emit time and only explodes later at persistence.

**Out of scope, documented as a second edit:** `supabase/functions/relay/models.ts:78-122`
(separate Deno deploy target, cannot import `@shared`) and
`packages/cli/scripts/validate-run.mjs:42-52` (cross-language; already derivable
in principle via `apiKeyEnvName`, not worth a build step — but note it has
**already drifted**, drift #2).

### 3.5 `modelHandlerCompatibilityKey` backfill re-derived at 6 sites — 6 → 2 [NEW]

**Root cause (leaky abstraction).** The persisted conversation is stored
**provider-native**, not canonical: `src/agent/storage/conversationFormat.ts:4-12`
states a stored conversation is `unknown[]` in "whichever model handler produced
it." Because the format leaks, resume must recover _"which format is this?"_ from
a persisted 15-value enum
(`src/agent/runtime/modelHandlerCompatibilityKey.ts:3-20`) and sniff message
shapes when the key is absent.

**Cost today.** 6 distinct "key absent → derive it" sites in 6 files, personally
re-grepped (16 production files reference the key/type; 9 test files, 68 test
occurrences):

```
SessionResumeRetrieval.ts:187-193   tool-use retrieval  — logging variant
SessionResumeRetrieval.ts:268-273   workflow retrieval  — NON-logging variant
executeAgent.ts:508-511             resumeToolUseFromResumeData
AgentLaunchContext.ts:290-292       + an EXTRA disk read at :188-189 purely to run a third entry point
runToolUseFlow.ts:487-506           the only site that writes the inferred key back (:507-516)
runReflectionFlow.ts:207-211        mutates `shared`, persisted by RoundPersistedFlow
```

Three inference entry points in one file with 1/4/1 production callers:
`inferPersistedModelHandlerCompatibilityKey` (`:64`),
`inferAndLogPersistedModelHandlerCompatibilityKey` (`:90`, a 14-line log-only
wrapper), `inferPersistedFlowModelHandlerCompatibilityKey` (`:133`, the same
function plus a `record.state` unwrap).

**Site 3 is provably dead recomputation.** Every production `ToolUseResumeData`
is built by `retrieveSessionResumeData` — `rg "type: 'toolUse'"` outside tests
yields exactly one constructor (`SessionResumeRetrieval.ts:205`), and no
production site spreads/overrides `resume` (`rg '\.\.\.resume'` outside tests:
zero hits). `executeAgent.ts:509-513` therefore feeds inference the identical
`(model, messages)` pair retrieval already fed it.

Drift measured across the 6 (see §1.1 item 9), including three different Zod null
policies on the **same persisted field**: `.nullable().transform(k => k ?? undefined).optional()`
(`nodes/types.ts:42-45`) vs `.nullish()` (`ReflectionFlowState.ts:50`) vs
`.nullish()` (`SessionResumeRetrieval.ts:91`) — so `?? infer(...)` fires on a
persisted `null` in two shapes and cannot in the third.

**Collapse.** (1) Fold the 3 entry points into one
`resolvePersistedCompatibilityKey(model, sharedRecord, logger)`; keep the unwrap,
delete the two wrappers. (2) Have `retrieveSessionResumeData` return an
**always-resolved** key, backfilling and writing it once at that boundary the way
`runToolUseFlow.ts:507-516` already does; make the field **required** on
`ToolUseResumeData`/`WorkflowResumeData`. (3) **Delete** `executeAgent.ts:508-511`
outright — zero behavior change today. (5) Unify the 3 Zod declarations on one
exported field schema.

**Target corrected 1 → 2.** Step (3)'s other half — deleting
`AgentLaunchContext.ts:183-199` and `:290-292` — **would break a live path**:
`src/controllers/progressView/ProgressViewHost.ts:65-72` launches a workflow
resume as `executeAgent({config, ...(executionId && {executionId})})` with **no**
key → `ProgressViewMessageHandler.ts:371` → `texra.execute` →
`executeCommand.ts:38-53` (key resolves to `undefined`) → `runAgent` →
`buildAgentLaunchContext`. That launch has an existing flow record and never
touches `retrieveSessionResumeData`, so the launch-context inference is
load-bearing there; deleting it silently routes the resume to the wrong provider
message format. Realistic target: **two** resolvers (retrieval boundary + launch
boundary), or one only if `ProgressViewHost`'s workflow resume is first re-routed
through `resolveAndResumeStream`.

**What breaks.** Making the key required is a type-level change across 4
production call sites and 9 test files (68 occurrences). Inference is genuinely
undecidable for legacy keyless records (returns `undefined` for all
non-Google/non-Copilot/non-VSCodeLM models, `inference.ts:78`) — the resolver
must keep `undefined` representable rather than inventing a key.
`activeModelHandlerCompatibilityKey` / `modelHandlersShareConversationFormat`
(`ModelFactory.ts:331-346`) are load-bearing for the model-switch gate
(`runToolUseFlow.ts:280-297`) and must not be folded in.

The key is also baked into a **host port signature** —
`resolveAndResumeStream.ts:62-66` `executeWorkflow(config, executionId, modelHandlerCompatibilityKey)`
— forcing re-declaration at `desktopAgentResume.ts:182-190`,
`resumeFromResumeData.ts:66-70`, `executeCommand.ts:33-41`,
`desktopAgentLaunch.ts:27,50` and `runAgent.ts:35`.

### 3.6 Per-provider China/region toggle — 5 → 1 [NEW]

**Cost today.** 5 production files, verified by `rg -ln 'UseChina|useChina|USE_CHINA'`:
`src/shared/state/stateKeys.ts:138-141` (4 enum members, each exactly
`` `texra.${id}.useChina` ``), `src/shared/constants/providers.ts`
(4 registry `region:` blocks `:105-151`, 4 named `X_USE_CHINA_PROVIDER_SETTING`
consts `:298-340`, 4 `PROVIDER_VSCODE_SETTINGS` rows `:431-434`),
`src/shared/schemas/stateSettings.ts:609-651` (4 hand-written catalog rows),
`src/utils/config/providerConfig.ts:127-141` (4 named getters),
`src/agent/modelHandlers/support/ProxyConfigResolver.ts:216-244` (4 switch
cases). Test files: 4.

**The default boolean is written five times, two of them dead and two of them
live on different read paths.**

- **Dead #1.** `ProviderRegionSetting.default` (`providers.ts:29`), populated on
  all four region providers. `rg 'region\.default'` across `src` and `packages`
  returns **two hits, both comments** — `providerConfig.ts:45` and
  `stateSettings.vitest.ts:111`. The former asserts it is "kept aligned … by the
  state-settings guardrail suite"; no test compares them. A dead field whose own
  doc claims it is guarded.
- **Dead #2.** The `?? false` / `?? true` at `providerConfig.ts:128,132,136,140`.
  `regionSet()` (`:42-48`) returns `region ? readPlatformSetting<boolean>(region.key) : undefined`,
  and `readPlatformSetting` (`src/utils/config/platformSettings.ts:26-41`) either
  throws or always returns a value; all four keys have catalog entries, so the
  `??` is unreachable in all four cases.
- **Live #1.** `z.boolean().prefault(...)` at `stateSettings.ts:611,622,633,644`
  — the CLI / `ProxyConfigResolver` routing path.
- **Live #2.** `defaultValue: true` on `MOONSHOT_USE_CHINA_PROVIDER_SETTING`
  (`providers.ts:323`) and `GLM_USE_CHINA_PROVIDER_SETTING` (`:336`), read by
  `src/controllers/settingsView/SettingsProfileController.ts:236-245` as
  `globalState.get<boolean>(def.globalStateKey, def.defaultValue ?? false) ?? def.defaultValue ?? false`
  — a read path that **bypasses the catalog prefault entirely**. The
  extension/desktop Models-tab toggle and the routing resolve the same fact
  through two independent defaults.
- **Copy #5.** `src/test-kernel/shared/stateSettings.vitest.ts:113-117`, whose
  own comment says it "mirrors the `PROVIDER_REGISTRY` `region.default` facts"
  — a fact nothing reads.

The guardrail tying the two live copies together has a hole:
`src/test-kernel/shared/settingsConfiguration.vitest.ts:106`
`if (setting.defaultValue === undefined) continue` skips `dashscope` and
`minimax`, whose settings omit `defaultValue` (`providers.ts:298-316`). Flip the
dashscope prefault and nothing fails: the UI renders Off while routing goes to
`dashscope.aliyuncs.com` (drift #8).

The 4 getters are single-caller extractions, which this repo bans: verified —
4 definitions, 4 imports and 4 call sites, **all inside `resolveDirectBaseUrl`**
(`ProxyConfigResolver.ts:218,225,234,241`), plus 2 test refs.

**Collapse.** Make the registry `region` block carry the whole fact:
`{ default, label, description, warning?, domainWhenSet, domainWhenUnset, path }`.
Derive the state key as `` `texra.${id}.useChina` `` (**delete**
`stateKeys.ts:138-141`). Derive the 4 `stateSettings` rows the way
`PROVIDER_ENDPOINT_SETTINGS` (`stateSettings.ts:254-268`) already derives
endpoint rows, reading `.prefault(region.default)` — this makes the dead field
live. Derive the `PROVIDER_VSCODE_SETTINGS` rows from the same block
(**deleting** `providers.ts:298-340`, which also kills live copy #2). **Delete**
the 4 getters. **Replace** the 4-case switch with one table read.

**What breaks.** These strings decide which host every request for 4 provider
families goes to; a transcription slip produces auth failures, not a crash. GLM
is the awkward case: its path is a second dimension
(`getGLMCodingPlan()` at `ProxyConfigResolver.ts:242` selects
`/api/coding/paas/v4` vs `/api/paas/v4`) — do **not** flatten `path` into a
single string. Defaults are asymmetric on purpose (moonshot/glm → China,
dashscope/minimax → international). Rewrite
`stateSettings.vitest.ts:113-117` to assert against `region.default` rather than
repeating literals, or the fifth copy survives the refactor. The CLI-roster
guardrail already shows the right shape (`stateSettings.vitest.ts:396-398`
spreads `PROVIDER_ENDPOINT_STATE_ENTRIES.map(...)`), three lines above a
hand-listed region block at `:402-405`.

### 3.7 extension/desktop host-interaction twins — 4 → 1 [NEW]

**Cost today.** These are not two presentations behind one seam — they are two
backends for the **same** presentation: `packages/desktop/src/renderer/main.ts:23`
does `import '@progressView/frontend'`. Both build on the same shared,
VS Code-free `ApprovalRequestHandlerSet`.

Member-by-member census of the 24-member union (read in full, both files):
**15 byte-equivalent** modulo `handlers()` vs `this.options.getApprovalHandlers()`
— the 8-member exported interface (`extensionHostInteractions.ts:57-77` vs
`desktopHostInteractions.ts:51-70`), the kinds const (`:79-85` vs `:72-78`, both
literally `['bash','plan','proposal','retry','userQuestion']`, differing only in
const _name_), `revealStream` (`:96-111` vs `:290-305`, identical bodies), the
four `request<Kind>` methods (`:247-290` vs `:134-188`), `isRetryPending`, the
five `submit<Kind>Decision` methods, `dismissExternalInquiry`, `emit`,
`setApprovalBypassState`. **5 shared-but-one-line-divergent**:
`requestToolEditApproval`, `cancel` (toolEdit branch), `approvePendingDelegatedWork`
(final await), `dispose` (cause string), `openExternalInquiry` (the drift).
**3 extension-only**: `readDiagnostics`, `addCriticism`, `notifyUnavailableTools`.
**1 desktop-only**: `showInfoMessage`.

A **third clone pair** one layer up, byte-identical bodies modulo the parameter
name: `handleBashApprovalAction` (`ProgressViewMessageHandler.ts:655-663` vs
`desktopAgentExecution.ts:838-845`), `handleUserQuestionAction` (`:666-675` vs
`:846-853`), `handlePlanApprovalAction` (`:880-890` vs `:854-861`).

Even the import blocks are clones: both pull the identical 17-symbol
`@agent/runtime/HostInteractions` list.

Note: the reported "67% of lines identical" could only be partially reproduced —
a coarser normalization gives 153 of 275 (56%). The **member-level identity** is
the real evidence; the percentage is not load-bearing.

**Why it exists.** Inertia. The genuinely shared parts that _have_ been extracted
(`cancelApprovalRequestHandlers`, `toBashApprovalResult`, `toUserQuestionResult`,
`cancellationResultFor`) prove the seam is host-neutral.

**Collapse.** Add `createProgressApprovalHostInteractions(options)` in
`src/controllers/progressView/backend/` — a CLAUDE.md VS Code-free zone that
already holds `ApprovalRequestHandlerSet`. It owns the 15 shared members, the
kinds const, and the shared branches of `cancel`/`dispose`/`approvePendingDelegatedWork`.
Its hooks are exactly the divergent set:
`{ toolEdit: { requestApproval, cancel, approvePendingForStream }, disposeCause, requestIdPrefix, optional: showInfoMessage / readDiagnostics / addCriticism / notifyUnavailableTools }`.
Each host file shrinks to ~40-60 lines of wiring. In the same pass move the three
identical `handle<Kind>Action` bodies into
`src/agent/runtime/hostInteractionResultMappers.ts`, which already exists for
exactly this. Decide `openExternalInquiry`'s `revealStream` **once**.

**Downgrade to record.** There are **four** `HostInteractions` implementations,
not two: the CLI headless adapter
(`packages/cli/src/runtime/approvalAdapter.ts:206-216`) and the CLI TUI
(`packages/cli/src/chat/tui/state/subscribeApprovals.ts:126,158`) are
structurally different (Ink FIFO queue) and use no `ApprovalRequestHandlerSet`.
The shared factory unifies **2 of 4**, and the port itself remains a genuine
multi-implementation seam. Say so in the PR.

**What breaks.** Desktop is a class with per-window session scoping; the
extension is a closure over a single session. The shared factory must take the
`SessionHandle` as a hook argument and never capture a module-level default, or a
desktop window's approvals could settle into a sibling window's session.
Adopting the extension's `openExternalInquiry` `revealStream` on desktop is a
real UX diff. The request-id prefix risk is **nil**: `rg 'desktop-bash'` returns
exactly one hit, the generation site itself. Cancellation cause strings
('Extension session disposed.' vs 'Desktop presentation detached.') are
user-visible in parked-request logs — keep them as a parameter. Test cost:
`ExtensionHostInteractions.vitest.mts` (806) + `DesktopHostInteractions.vitest.mts`
(476) merge into one parameterized suite; note the extension twin has **no**
equivalent of `SessionInteractions.vitest.ts:129`, which is why the
`openExternalInquiry` drift has no test that would catch it.

### 3.8 Non-exhaustive `types:` subscription filters silently drop new run facts — 3 → 1 [NEW]

**Cost today.** Fully reproduced. `RUN_FACT_EVENT_TYPES`
(`src/agent/trace/events.ts:374-387`) declares 12 types, `Object.freeze`d with
`satisfies readonly AgentEvent['type'][]`. `rg 'RUN_FACT_EVENT_TYPES'` returns 6
production hits in 4 files; only **2** are subscription filters
(`ProgressBackend.ts:442`, `sessionProgressSubscription.ts:201`). The other two
subscribers hand-list the array:

- `packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts:393-405` — 11 entries,
  omits `'run.start'`.
- `src/transcript/StreamSnapshotStore.ts:477-486` — 9 entries, omits
  `'conversation.progress'`, `'stage.start'`, `'child.activity'`.

The filter is typed `types?: readonly AgentEvent['type'][]`
(`src/agent/runtime/SessionEventHub.ts:76`) — a plain array, **not**
exhaustiveness-checked — and `emit` drops non-matching types at `:110-118`
**before** the callback. Adding an arm to `AgentEvent` _and_
`RUN_FACT_EVENT_TYPES` produces **zero** compile error at either site and the
fact never arrives.

Then three silent-drop defaults compound it: `subscribeRuntimeHost.ts:307`
`default: return false`, `StreamSnapshotStore.ts:470-472`
`case 'goalPaused': default: return;`, and
`packages/cli/src/runtime/runProgressRenderer.ts:222` `default: return false` —
each contrasting with an `assertNever` sibling in its own file
(`subscribeRuntimeHost.ts:342-374`, `runProgressRenderer.ts:185`).

`subscribeRuntimeHost.ts:307` is worse than a silent drop:
`applyDirectTuiRunEvent`'s boolean is dead — the call site is
`if (applyDirectTuiRunEvent(...)) { return; }` with nothing after it (`:385-390`),
so both branches behave identically. `StreamSnapshotStore.ts:441-473` and
`:477-486` are two enumerations of the same vocabulary inside **one function
body, 4 lines apart** — the tightest lockstep pair in the runtime.

Consequence chain: `StreamSnapshotStore` is the sole writer of the snapshot
`packages/trace-viewer` replays (`traceDataSchema.ts:15-23`), so a new run fact
is invisible in the trace viewer too, with no error anywhere. Test sites: **0** —
`AgentTrace.vitest.ts:22-25` asserts only `Object.isFrozen`.

**Collapse.** Make run-fact subscription **opt-out**. Replace both literal arrays
with `RUN_FACT_EVENT_TYPES` filtered by a locally-declared exclusion const
(`const TUI_IGNORED = ['run.start'] as const satisfies readonly RunFactType[]`),
so a new fact arrives by default and an omission is a named decision. Replace the
three silent defaults with `assertNever` over `RunFactType`. **Delete**
`StreamSnapshotStore`'s duplicate 9-entry array. The pattern to copy is already
in the tree: `ProgressFactApplier.ts:85-93`'s `RunFactHandlers` mapped type is
the one consumer that **cannot** drift.

**What breaks.** Dispatch volume: `StreamSnapshotStore` would start receiving
`conversation.progress` and `stage.start`, which fire per-round rather than
per-chunk. Measure before assuming it is free; exclude them explicitly if the
debounced writer is sensitive. `assertNever` converts a silent gap into a build
break — that is the intent, but it means two extra required edits per fact until
the exclusion consts absorb them.

Highest ratio of any finding: effort S, zero test churn, converts an invisible
failure mode into a compile error.

### 3.9 The run's task list is persisted three times — 3 → 1 [NEW]

**Cost today.** Three live writers of one fact, all driven off the single
`updateTodos` run fact, each verified by reading:

1. flow record — `shared.stateSlices.workspaceSnapshot.workPlan.todos` via
   `WorkPlanState.toSnapshot()` (`AgentWorkspaceState.ts:234-240`);
2. `executions/{id}/todos.json` — `persistTodos: (todos) => kv.writeTodos(todos)`
   (`runToolUseFlow.ts:262`), fired per update through a PQueue at
   `ToolUseCycleNode.ts:113-131`;
3. `streamData/{stream}/workPlan.json` sidecar — `StreamSnapshotStore.setTodos`
   (`:1405-1411`) → `writeWorkPlan` (`:1678-1688`), asynchronous.

**Contradiction in the code's own comments.** `completedRunArchive.ts:5-6`
documents the `todos.json` projection as a "READ-ONLY fallback for runs recorded
before sidecars existed" and `runToolUseFlow.ts:544-547` says the old per-step
projections "are gone" — then the next clause admits "Live-run todos still
persist event-driven via `persistTodos` above," and `:262` does exactly that.
**A legacy read-fallback that is still actively written can never age out.**

Reconciliation cost: `readCompletedRunTodos` (`completedRunArchive.ts:96-124`)
compares the two files' mtimes with a documented millisecond-tie heuristic
(`:92-95`); `ExecutionKVStore.todosModifiedAt()` (`:143,:247-249`) exists solely
to feed it and has one production caller.

**The lossy fourth type.** `TodoItemSchema` is
`z.strictObject({content, status: TodoStatusSchema, activeForm})`
(`src/shared/schemas/todo.ts:16-23`). `TodoEntrySchema` is
`z.object({content: z.string().optional(), status: z.string().optional()})`
(`ExecutionKVStore.ts:83-86`) — Zod v4 `z.object` strips, so `activeForm` is
dropped on every `readTodos()`. Worse, `todoItemToEntry`
(`completedRunArchive.ts:51-56`) **downcasts the fresh sidecar's complete
`TodoItem[]`** at `:121`, imposing the legacy file's lossy shape on a path that
has the full data. The status weakening from enum to `string` forces the cast
back at `executionFormatters.ts:119`. Four production readers are typed on the
lossy shape (`executionFormatters.ts:126,:136`,
`executions/summaryFormat.ts:148`, `ExecutionsTool.ts:633`); the type is
re-exported from the `@agent/storage` barrel (`src/agent/storage/index.ts:9`), so
it is a published surface.

**Amplification is 3 declaration files, not 3 copies.** Writer (1) does **not**
amplify: `WorkPlanSnapshotSchema` composes `z.array(TodoItemSchema)`
(`src/shared/schemas/workPlan.ts:38`), so the flow-record copy inherits new
fields for free — as do `streamState.ts:194` and
`progressView/outbound.ts:153,319`. The amplification is confined to the two
hand-written twins: `todo.ts:16`, `ExecutionKVStore.ts:83`,
`completedRunArchive.ts:51`. `activeForm` is proof the lockstep already failed.

**Collapse.** Retire writer #2. **Delete** `persistTodos` from `ToolUseServices`
(`:22`) and its wiring (`runToolUseFlow.ts:262`, `ToolUseCycleNode.ts:113-131`);
**delete** `writeTodos` (`ExecutionKVStore.ts:155,:334-336`), `todosModifiedAt`
(`:143,:247-249`) and the mtime-arbitration branch
(`completedRunArchive.ts:96-119`). **Keep** `readTodos` read-only for pre-sidecar
runs. **Keep** `TodoEntry`'s leniency, but **only** as a parse-time coercion
local to the legacy read arm — it is a deliberate tolerance for corrupt legacy
files, and that is the one good reason it exists. Retype the 4 readers on
`TodoItem`.

**Sequencing constraint (the real work).** `completedRunArchive.ts:92-95` states
a final `todo_write` can land before the asynchronous sidecar write flushes.
**Make the terminal sidecar write synchronous first**; the deletions are
downstream of it. Deleting writer #2 before that loses the last todo update on a
completed run.

**What breaks.** Pre-sidecar `todos.json` files may hold statuses outside
`TODO_STATUS`, so the legacy reader needs an explicit coercion, not a strict
parse, or old runs stop listing. `readTodos` is consumed by
`ExecutionsTool.ts:550,:773`, a model-facing surface.

**The same shape exists a second time, for conversations** —
`completedRunArchive.ts:517` + `ExecutionKVStore.ts:146,:265-267`
(`conversationModifiedAt`) is the identical legacy-projection + sidecar + mtime
tiebreak, and `runReflectionFlow.ts:317`
(`if (s.conversation?.length) await store.writeConversation(...)`) is its
still-live legacy writer. Fix the shape once and both retire.

### 3.10 `WebviewUpdater`: 22 zero-logic send methods — 2 → 1 [NEW]

**Cost today.** `src/controllers/progressView/backend/WebviewUpdater.ts`, 460
LoC, 30 members. 26 call `this.sendMessage`; **22** contain exactly one statement
— an object literal with a `PROGRESS_VIEW_COMMANDS.*` discriminant plus the
positional args re-keyed. Verbatim (`:322-328`):

```ts
updateTodos(stream, todos) {
  this.sendMessage({ command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS, stream, todos });
}
```

Caller census (`rg -o 'webviewUpdater\.\w+' src packages` minus test-kernel,
bucketed — independently reproduced): 37 production calls, of which **15 methods
have exactly one caller** — `updateFiles`, `updateCompileFailures`,
`updateRunUsage`, `setPlacement`, `updateStreamStatus`, `updateStreamDescription`,
`updateConversationProgress`, `updateRoundStage`, `syncInquiryThreads`,
`updateInquiryThread`, `updateParentStream`, `updateTodos`, `updatePlan`,
`updateQueuedFollowUps`, `updateBypassState`. CLAUDE.md: "single-caller
extractions are banned." `updateTheme` (`:221`) is worse — **zero** external
callers, only a self-call at `:408`; it is a private helper wearing a public
method's clothes.

**Why it exists.** The class docstring (`:61-63`) claims "Uses
`ProgressViewOutboundMessage` union type for compile-time safety." That safety
comes from the discriminated-union parameter on `sendMessage`, not from the 22
wrappers — a caller writing the literal directly gets identical narrowing. The
designed test seam is the constructor's `send`/`hasTarget` pair (`:47-58`), not
the methods: there is one production instantiation
(`ProgressBackend.ts:129`) and the two other test doubles cast the class
wholesale (`ApprovalRequestHandlerSet.vitest.ts:184` `{} as WebviewUpdater`,
`StreamContentSync.vitest.ts:102`).

**Collapse.** Rename the private `sendMessage` (`:63`) to a public
`post(message: ProgressViewOutboundMessage): void` — it already carries the only
real behavior, the `hasTarget()` guard — and **delete** the 22 pass-throughs
(~200 LoC, `:120-352`). Rewrite the 37 call sites to pass the literal. **Keep**
the 6 that do real work: `updateStreams` (`:74`, builds `unsupportedCommands`),
`updateStreamMetadata` (`:93`), `updateGoalActive` (`:193`, branches),
`sendStreamMetadata` (`:366`, 63 LoC of derivation),
`buildStreamMetadataForStream` (`:435`), `isAvailable` (`:431`). Inline
`updateTheme` outright.

**Correction: "zero test churn" is false.** The original grep could not see
`vi.spyOn(obj, 'name')`. Verified: `src/test-kernel/progressView/ProgressBackend.vitest.ts`
spies on `backend.webviewUpdater.{updateFiles, updateRunUsage, updateTodos,
updatePlan, updateMissingOutputs, updateCompileFailures}` at
`:1909,1911,1915,1918,1919,1920,2108,2109,2157`, with assertions like
`expect(updateTodos).toHaveBeenCalledWith(streamId, todos)` (`:2057`). Each spy
becomes a `post` spy plus a command-discriminant match. **Effort M+, not M.**
The finding survives the downgrade because the seam is incidental, not designed.

**What breaks.** The wrappers name the `streamId` → `stream` rename at the
boundary (`src/shared/schemas/progressView/data.ts:31` `StreamScopedBaseSchema`);
after the collapse callers write `stream:` themselves — compile-enforced, but 37
sites in one pass. Two methods spread caller-supplied bags
(`updateFiles`/`updateMissingOutputs`/`updateCompileFailures` spread
`{rounds, reset}`; `updateStreamBadges` spreads `StreamBadgeSnapshot`), and
`updateStreamStatus:240` sets `lastTimestamp` unconditionally but `substate`
conditionally — that asymmetry must survive inlining.

### 3.11 Run fact → wire → renderer census — 21 files [CENSUS RETAINED, COLLAPSE REJECTED]

Recorded as a **map, not as work.** Probe: add one rendered run fact, measured
against `updateTodos`. `rg -l 'updateTodos|UPDATE_TODOS|UpdateTodos' src packages`
excluding tests returns **17 files**; minus 2 emit sites
(`ToolUseCycleNode.ts:71,117`, `codex.ts:175`) and 2 domain-model sites
(`AgentWorkspaceState.ts:267`, `TodoTool.ts:101`) = 13. A durable+rendered fact
of that shape additionally forces `src/shared/schemas/workPlan.ts:38,47`,
`streamSnapshot.ts:84` **and** `:100` (the canonical/legacy twin — `[TRACKED]`
New-2), `streamState.ts:194`, `src/transcript/streamSnapshotRead.ts:49`,
`packages/cli/src/chat/tui/state/cliState.ts:200,256`,
`packages/cli/src/chat/tui/appLayout.ts:296`, and
`packages/trace-viewer/src/replayTrace.ts:195-225` (which hand-constructs a
`SyncStreamContentPayload` including `workPlan`). **Corrected total: 21 files,
~26 edit points.** A new `SessionFact` arm is cheaper: 8 files minimum, rising to
12 if it renders — but **three** of its four exhaustive switches live in
`packages/cli`.

How much is mechanical: `projectCliSessionFact`
(`packages/cli/src/runtime/sessionProgressSubscription.ts:29-55`) is 9 identity
returns + 1 undefined + `assertNever`; `runProgressRenderer.ts:161-184` is 2 real
arms + 8 grouped `return false`; `TexraTranscriptRecorder.ts:553-577` is 10 bare
returns (its `default:` at `:579` is a real `never` guard and earns its keep).

**Why the collapse was rejected.** Three named cuts, each of which fails:

1. Collapsing `projectCliSessionFact` targets **session** facts; the probe
   measured a **run** fact, whose path is the different function
   `projectCliRunFact` (`:56-120`) — which does real field selection into the
   frozen NDJSON payload (`payload: {streamId, todos}` at `:86-89`) and is a
   public-contract boundary. Removes **zero** run-fact sites.
2. `packages/cli/src/runtime/cliNdjsonProgressEvents.ts:26-34` carries an
   explicit policy docstring, "Do not add new fact keys here." By its own
   contract it is **not** a lockstep site — subtract it, don't collapse it.
3. A `streamFactMessage` factory leaves `outbound.ts` a lockstep file regardless
   (you still add a factory call plus a union entry), and the shapes are not
   uniformly derivable — `UpdateStreamStatusMessageSchema` (`:105`) carries a
   `lastTimestamp` the fact payload lacks, and the `streamId` → `stream` rename
   is baked into the frontend slices.

Realistic delta: **21 → 20**, via §3.10 alone. At effort L that is a losing
trade. The residual arms — payload schema, trace arm, `RunFactPayloads`,
`ProgressFactApplier` handler, outbound union entry, frontend slice, snapshot
store, TUI switch — each represent a real per-consumer decision and should stay.

Exonerated by the same probe: `packages/trace-viewer` consumes
`TraceDocumentSchema` + `StreamSnapshotSchema` directly
(`traceDataSchema.ts:9-13`) with no re-declaration of the event vocabulary;
`packages/desktop` reuses the extension progress webview
(`desktopProgressIpc.ts` touches only `WEBVIEW_READY`/`THEME_SET`), so "three
hosts" is really **two renderers**.

### 3.12 `streamId` as a lossy composite of `executionId` — 12 → 1 files [EXTENDS-TRACKED]

Added after the six probes closed, during owner spot-check. §6 lists run
identity as unprobed; this fills that gap. It **extends** `[TRACKED]` §New-4,
which named only the `RunScope`/`RunContext` duality — the composite-key
round-trip below is the larger and previously unnamed half.

**Cost today.** A run carries two identifiers, but one is a string encoding of
the other plus two more fields:

```ts
// src/agent/runtime/streamTab.ts:11-18
return `${cleanAgent}@${model}#${options.executionId}`;
```

Because the encoding is a convention rather than an owned mapping, **12
production files know the format**, in three different ways:

- **Forward re-derivation (5 files)** — each rebuilds the id from its own
  `agent`/`model`/`executionId` triple: `AgentLaunchContext.ts:311,562`,
  `tools/delegation/subagentExecution.ts:169`,
  `src/latex/latexdiff/outputDiscovery.ts:239`,
  `src/transcript/traceAssembler.ts:46`,
  `packages/cli/src/runtime/toolUseResumeData.ts:22`.
- **Reverse parsing (3 files + the parser)** — `executionIdFromStream()`
  (`src/agent/storage/executionIdFromStream.ts`, `lastIndexOf('#')` + a
  `safeParse`) recovers the `executionId` back out of the string, called from
  `SessionHandle.ts:445`, `restartRepair.ts:338`, `SessionStores.ts:234,283,289,405`.
- **Ad-hoc substring parsing (2 files)** — the agent name is recovered by
  splitting on `@`: `src/controllers/progressView/backend/streamTabInfo.ts:42`
  and, in a webview renderer,
  `packages/extension/src/progressView/frontend/components/StreamHeader.ts:531`
  (`parentStreamId.split('@')[0]`). This is the CLAUDE.md "never compensate for
  a data-model problem at render time" rule, violated verbatim.

**The mapping is already not trusted.** `SessionStores.executionIdForStream`
(`:228-236`) tries three sources in order — in-memory snapshot map, persisted
record, then string parsing — i.e. the codebase already treats the encoding as a
last-resort guess rather than a derivation. That fallback chain is the honest
admission that the id pair needs an owned mapping.

**Two corroborating artifacts.** `subagentExecution.ts:161-168` carries an
eight-line comment warning that the child stream id "must match the id
`buildAgentLaunchContext` actually reserves … Derive from the exact same
fields, not a parallel formula" — a maintainer documenting this exact
amplification after being bitten by it. And within `AgentLaunchContext.ts` the
formula is already spelled two ways: `getStreamTabId(config.agent, fullConfig.model, …)`
at `:311` versus `getStreamTabId(config.agent, config.model, …)` at `:562`.
**This is not a live divergence** — `config` is `{...fullConfig, agentCategory}`
(`:282-285`), so the two agree — but it is precisely the parallel formula the
comment warns about, one field away from a mismatched reservation.

**Why it exists.** `streamId` is a UI tab key and needs to be human-readable in
transcript filenames; `executionId` is the registry key. Both needs are real.

**The collapse.** Keep both types — they are different concepts — but make the
mapping owned rather than parsed. `streamTab.ts` becomes the single module that
knows the encoding, exposing the forward builder and an authoritative
`executionIdFor(streamId)` backed by the session's existing map, with string
parsing retained _only_ as the documented legacy-transcript path inside that one
module. Delete the two UI re-parsers: `streamTabInfo.ts:42` should read
`run?.agent` (it already does, as the left side of the `??`), and
`StreamHeader.ts:531` should receive the agent name as a prop. The five forward
re-derivations call the builder with a `RunScope` rather than three loose
fields, which makes the `:311`/`:562` divergence unrepresentable.

**What breaks.** The reverse parse is load-bearing for _legacy_ transcripts
written before the execution-id map was persisted — `SessionStores.ts:234`'s
third fallback is a real migration path, not dead code. It must survive the
collapse as an explicitly-named legacy branch inside `streamTab.ts`, not be
deleted. Deleting it would silently orphan old transcripts, which is exactly the
silent-degradation class this repo treats as a defect.

**Sequencing.** Independent of §3.1–§3.11. Do it _with_ `[TRACKED]` §New-4
(`RunScope`/`RunContext` collapse) or immediately after — both changes converge
on "one owned run-identity object", and doing them separately churns the same
launch-path call sites twice.

## 4. Not findings — layers that earn their keep

Recorded so future passes stop re-proposing them.

| Layer                                                                                                                                                                                                    | Why it stays                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimePresentationEventPayloads` (`src/agent/runtime/runtimePresentationEvents.ts:16-22`)                                                                                                              | 3 genuinely different host implementations doing different UI work (`agentEventListeners.ts:155`, `cliPresentationHost.ts:62`, `desktopAgentExecution.ts:1076`). 1 core + 3 hosts is the irreducible cost of a port with 3 implementations.                    |
| `SessionHandle` (843 LOC)                                                                                                                                                                                | A composition record, not a facade: 13 owned members as `readonly` fields, exactly **one** forwarding method (`useHostInteractions` `:505-507`, 6 production + ~50 test call sites). Collapsing churns 56 sites to save 1 line.                                |
| `ExecutionRegistry` (1132 LOC, 30 public methods)                                                                                                                                                        | Exactly one trivial forward (`getActiveChildren` → `collectChildSummary` `:623-625`); everything else is real state/lifecycle work.                                                                                                                            |
| `hostInteractionResultMappers.ts`                                                                                                                                                                        | A **real adapter**, not a rename projector: `toBashApprovalResult` collapses a 2-arm union into `{accepted, userMessage?}` and deliberately scopes `userMessage` to the reject arm (documented anti-drift `:15-21`). 5 production call sites, 2 hosts.         |
| `resolveAndResumeStream.ts`                                                                                                                                                                              | Deliberate host-neutral seam with 3 real implementations (`resumeFromResumeData.ts:34`, `desktopAgentResume.ts:143`, `chatSessionController.ts:738`).                                                                                                          |
| `StreamStatusMachine`, `SessionEventHub`, `SessionHostInteractions` (attachment versioning, parking, dispatch-generation guards), `ExecutionSubscriptionBinder`, `AgentRunLifecycle.finalizeRunTerminal` | All real work.                                                                                                                                                                                                                                                 |
| `ChildRunStrategy` / `startChildRunLoop`                                                                                                                                                                 | `[TRACKED]` as the best-factored part of the runtime. Do not touch.                                                                                                                                                                                            |
| The three buses (`AgentEvent` run-scoped / `SessionFact` session-scoped / `AppSignals` process-scoped)                                                                                                   | `[TRACKED]` as deliberately distinct. Do not propose merging.                                                                                                                                                                                                  |
| `MapToolRegistry` `Map \| Record` narrowing                                                                                                                                                              | `[TRACKED]` — attempted and **reverted** at `-07-22`/`-07-23`. Do not re-propose.                                                                                                                                                                              |
| The ~10 single-override predicate getters on `ModelHandler`                                                                                                                                              | `[TRACKED]` settled work (#7101).                                                                                                                                                                                                                              |
| `UsageProviderSchema` (`src/shared/schemas/usage.ts:6-19`)                                                                                                                                               | **Killed sub-claim of §3.4.** 13 arms, not a function of the registry (`openai-response` and `unknown` have no id, `openrouter` is lowercased, `kimiCode` is absent), and it is persisted. Deriving it would be more error-prone than the hand list.           |
| `RELAY_PATH_SUFFIXES` (`ServerSideKeyService.ts:45-54`)                                                                                                                                                  | **Killed sub-claim of §3.4.** `Partial<Record<ServerSideProvider,…>>`; META needed no entry, and its data genuinely differs from `BASE_URLS` (relay deepseek `'/v1'` vs direct `'https://api.deepseek.com'`).                                                  |
| `progressBackendUiConfig.ts:89-117` as a "pure name translator"                                                                                                                                          | **Partially killed.** Empirically, the per-arm concrete typing does real generic inference (`TS2345` reproduced under `tsc --strict`). Collapsible only together with de-generifying `cancelHandler`.                                                          |
| The `stopAfterCycle` "resume drift"                                                                                                                                                                      | **Killed.** `ToolUseWaitNode.ts:97` returns before the WAITING branch, so no resumable cursor is ever written; `inBandSubagentExecution.ts:487-505` bypasses `runTurn` for single-cycle. The omission at `executeAgent.ts:539-541` is correct-by-construction. |
| The "14 parallel run-config objects" framing                                                                                                                                                             | **Killed as padding.** `AgentConfig`, `ValidatedExecutionRequest`, `RunScope` and `CliExecuteOptions` are genuinely different concepts. Honest count of option bags carrying the flags: **8**, plus `RunContextCommon`.                                        |
| The run-fact wire collapse (§3.11)                                                                                                                                                                       | **Killed.** See §3.11 — the three named cuts remove 0, 0 and 0 files respectively.                                                                                                                                                                             |
| `CliExecuteOptions` (`runExecution.ts:39-53`)                                                                                                                                                            | A host-narrowing seam that deliberately hides `beforeLeaseRelease`/`onExecutionLeaseAcquired` from CLI command code. Keep.                                                                                                                                     |
| `TexraTranscriptRecorder.ts:579` `default:`                                                                                                                                                              | A real `never` exhaustiveness guard — the one silent-looking default that forces an explicit decision. Keep.                                                                                                                                                   |

## 5. Sequencing

Ordered so earlier work does not amplify later work.

1. **§3.8 (run-fact filters, S)** and **§3.3 (`detachActiveChildren`, S)** —
   independent of everything else, both fix live defects, both cheap. Start here.
   §3.3 also corrects a strength claim in the `-07-29` checkpoint.
2. **§3.7 (host-interaction twins, M)** — **must precede §3.1.** It halves §3.1's
   host-side site count: the two 5-arm kinds arrays, the two identical import
   blocks, and the three duplicated `handle<Kind>Action` bodies all become one
   each _before_ the vocabulary rename touches them. Doing §3.1 first means
   performing the rename twice.
3. **§3.1 step 1 (SDK re-export)** — self-contained, one file, no ordering
   constraint. Can land any time; do it early to stop the SDK shipping a private
   copy.
4. **§3.1 steps 2-3 (vocabulary unification + `cancelHandler` de-generify, L)** —
   after §3.7. Split the wire rename into its own commit from the
   `cancelHandler` widening.
5. **§3.2 step 1 (`RunFlags` declaration, S)** — mechanical, no behavior change,
   no ordering constraint. Land it standalone so the 16 test files churn once.
6. **§3.2 steps 2-4 (nest the bag, M)** — after step 1. Step 3 (delegation bags
   extending the shared base) should land with step 2, not after, or the
   delegation files churn twice.
7. **§3.6 (region toggle, M)** — **must precede §3.4.** The region block becomes
   part of `ProviderDef`; doing the wider `ProviderDef` widening first means
   re-opening it. §3.6 also removes live default copy #2, which §3.4's
   `PROVIDER_VSCODE_SETTINGS` derivation would otherwise have to preserve.
8. **§3.4 (provider identity, M)** — after §3.6. Land sub-claim (a) (the 22
   `GlobalStateKey` members) separately from (f) (the icon table); (f) fixes a
   user-visible bug and should not wait on the rest.
9. **§3.9 terminal-sidecar synchronization (M)** — **the precondition**, not the
   deletion. Nothing else in §3.9 is safe until the terminal write is
   synchronous.
10. **§3.9 deletions (S once 9 lands)** — then apply the identical shape to the
    conversation twin (`conversationModifiedAt`).
11. **§3.5 (compatibility-key resolution, M)** — independent. Land the free win
    first (**delete** `executeAgent.ts:508-511`, zero behavior change), then the
    Zod unification, then the required-field change. Do **not** attempt the
    launch-boundary deletion without first re-routing
    `ProgressViewHost.ts:65-72` through `resolveAndResumeStream`.
12. **§3.10 (`WebviewUpdater`, M+)** — last of the collapse work. It is the only
    cut that actually removes a file from §3.11's edit set, but it churns 37
    production sites and 9 test spies for a delta of 1. Do it when touching that
    file anyway, not as a standalone campaign.

**Anti-pattern to avoid across all of these:** do not "fix" a threading problem
by moving the value into ambient context. §3.2's warning generalizes — the
child-run loop runs outside the parent's ALS frame, and several of these seams
cross that boundary.

## 6. Coverage gaps

**Personally re-derived at HEAD `8116ce9`** (ran the greps, read the files):
the `userQuestion` 38→31 production-file count and the three approval-kind
spellings (§3.1); the `RunFlags` 17/16/14/24/16 file counts and the four
`RunContext.ts` declarations and both `withExecutionRunContext` literals (§3.2);
all 7 `detachActiveChildren` call sites and the `:883` divergence (§3.3);
`icons.ts` 8 keys vs 12 registry ids, `validate-run.mjs` 10 entries missing
`META_API_KEY`/`KIMI_CODE_API_KEY`, and the `GlobalStateKey.STREAMING_/ENDPOINT_`
zero-external-consumer result (§3.4); the `region.default` dead-read grep and the
four single-caller region getters (§3.6); `RUN_FACT_EVENT_TYPES` and both
hand-listed filter arrays verbatim (§3.8); `TodoItemSchema` vs `TodoEntrySchema`
and all three todo writers (§3.9); the `WebviewUpdater` caller histogram, the
`updateTheme` zero-caller result, and the `spyOn` sites that falsify the
"zero test churn" claim (§3.10); the `updateTodos` 17-file name-grep (§3.11);
the three compatibility-key inference entry points and 16-file spread (§3.5).

**Taken from the verification pass, not personally re-run:** the `tsc --strict`
reproduction of `TS2345` for `cancelHandler` (§3.1) and the structural fix that
compiles clean; the member-by-member diff of the two host-interaction files
(§3.7) — the member _names_ and the `openExternalInquiry` drift were confirmed,
the byte-equivalence of each body was not; the `ToolUseWaitNode` /
`inBandSubagentExecution` control-flow argument that kills the `stopAfterCycle`
drift claim (§3.2); the `ProgressViewHost` → `executeCommand` → `runAgent` trace
that corrects §3.5's target from 1 to 2; the assertion that no production site
spreads/overrides `resume`.

**Estimates, not counts.** Every `amplificationTarget` in §2 is a judgment about
what residue is irreducible, not a measured number — §3.1's "12" in particular
is a downward revision of a reported "8" and could still be optimistic. The
"~170 duplicated production lines" in §3.7 and the 56%-vs-67% line-overlap
discrepancy are noted as unresolved; the member-level census is the load-bearing
evidence there.

**Added after the probes closed.** §3.12 (`streamId` composite key) was not
produced by any of the six probes — run identity was listed here as unprobed,
and the finding came from an owner spot-check against that gap. All of its
counts were derived directly (the 5 `getStreamTabId` re-derivation sites, the
9 `executionIdFromStream` call sites across 3 files, both `split('@')` UI
re-parsers, and the `SessionStores.executionIdForStream` three-source fallback).
It has **not** been through the adversarial verification pass the other eleven
findings received, and its "12 → 1" target is a judgment, not a measurement.
One sub-claim was checked and deliberately **downgraded**: the `:311`/`:562`
formula mismatch in `AgentLaunchContext.ts` is a latent hazard, **not** a live
divergence, because `config` differs from `fullConfig` only in `agentCategory`.

**Not examined.** `src/agent/modelHandlers/` internals beyond
`ProxyConfigResolver` and the `modelHandlerOpenAI` usage cast — the ModelHandler
god-class is `[TRACKED]` and was deliberately out of scope. The reflection flow
was touched only where it reads the compatibility key and writes conversations;
its own state machine was not probed. `src/latex/`, `src/replacement/`,
`src/auth/` and the settings view were not probed at all.
`packages/trace-viewer` was probed only as a consumer.
`packages/extension/resources/agents/` YAML was not probed. Six probes were run;
a seventh — \*add one model provider **handler class\*** — was not, so the
`ModelFactory` → handler-class path's amplification is unmeasured.

**Method limits.** Counts are file-level (`rg -l`) unless an edit-point count is
stated explicitly; a file needing three edits counts once. Test counts are
`src/test-kernel` only. `vi.spyOn`-style indirect call sites are invisible to
name-greps — this was caught once (§3.10) and may hide elsewhere. No change was
applied; this is a record, not a patch.
