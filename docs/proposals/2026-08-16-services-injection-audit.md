# Services, bags, and injection seams: resolve-once-at-boundary by deletion

**Date:** 2026-08-16
**Status:** Proposed
**Evidence base:** three verified surveys of origin/main @ `3122ace2bc` (bags census, threading census, injection-seams census), an adversarial verification pass over every headline claim, and the prior-art register (AGENTS.md, review-checklist §13–§15, `docs/architecture/pocketflow-state.md`, the DI-cleanup and SSOT-consolidation plans, tournament ledger #8974). All file:line references are at that commit unless marked otherwise. Corrections from the adversarial pass are applied throughout; one survey claim was refuted outright and is recorded in §3 as a do-not-refile row.

---

## 1. Diagnosis, in the maintainer's frame

The standing ruling (memory `feedback_no_deep_injection.md`; `2026-07-09-tech-debt-design-philosophy.md:101`) is that the agent-core mess was **dual ownership** — one launch context fanned into both the services bag and the frozen `RunContext` ALS — and that the cure is single owner + resolve-once-at-boundary, achieved by deletion, never by another DI layer. The 2026-08-15 extension of that ruling adds: hydration ceremonies, resolve chains, and hand-synced secondary channels are the same disease.

**The headline finding of this audit is that the adjudicated disease is substantially cured on main.** Verified:

- The four run-policy flags (`approvalPromptsUnavailable`, `onApprovalPolicyDenial`, `runtimeUnavailableTools`, `stopAfterCycle`) live **only** in the ALS `LaunchRunContext` (`src/agent/runtime/RunContext.ts:16-19`). No services bag re-carries them. In-flow consumers read the ALS directly (`runToolUseFlow.ts:181,201-202` — resolving tools once at the boundary, so the resolved tool list, not the flags, travels in services; `ToolUseWaitNode.ts:59`; `ResponseCycleFlow.ts:216-221`).
- `RunScope` is one frozen object (`src/agent/runtime/RunScope.ts:26`, `Object.freeze`) shared **by reference** between `AgentCore.runScope` (`src/agent/core/flows/BaseFlowServices.ts:19`) and the ALS (`AgentLaunchContext.ts:149` passes `runScope: ctx.runScope`). Single owner, two access paths — not dual ownership.
- `withExecutionRunContext` (`AgentLaunchContext.ts:129-155`) is the single projection owner into `createRunContext`; every non-ALS appearance of the flags is boundary plumbing on option types funneling through it.
- The dead `delegationConfig` carrier is gone (deleted 2026-06-09, commit `092358d86`); `src/agent/runtime/executionOwnership.ts` is gone; the campaign closures (#6921, #8749, #9255, #7737, #10594, #7691) held.

What remains is not the old disease but its residue in three shapes:

1. **Dead weight on option bags and flow contexts** — fields with zero producers or zero readers that survived the campaign because nothing forced a census (`ResumeQueuedToolUseOptions`' 8 never-set inherited fields; `ToolUseFlowContext.model`/`interactions`; `RunReflectionFlowInput`'s two zero-passer injection ports; `fallbackTeamId`).
2. **Long pure-forward threads for a handful of facts** — worst is the approval trio re-threaded to delegated children: ALS → 4–6 explicit frames → child ALS, byte-identical values (Chains A′/A″ below).
3. **Test-only injection seams in production modules** — a family the shared-contracts doc (2026-08-15) already tiers; this audit found 8 more members it missed.

### Worst-10 tables (post-campaign state)

**Widest option bags (production, distinct field count):**

| Bag                                  | File:line                                         | Fields                                                  |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------- |
| `ExecuteAgentOptions`                | `src/agent/runtime/executeAgent.ts:332`           | 24 (12 inherited + 12)                                  |
| `RunToolUseFlowInput`                | `runToolUseFlow.ts:70`                            | 21 (9 + 13, `setting` re-narrowed)                      |
| `ToolUseServices`                    | `tooluse/ToolUseServices.ts:10`                   | 21 (9 + 12)                                             |
| `RunAgentOptions`                    | `runAgent.ts:36`                                  | 20 (drift-proof 15-field Pick + 5)                      |
| `ResumeQueuedToolUseOptions`         | `resumeQueuedToolUse.ts:24`                       | 19 (12 inherited — **8 never set by any caller** — + 7) |
| `NativeSubagentStrategyParams`       | `nativeSubagentStrategy.ts:132`                   | 17                                                      |
| `ResumeToolUseFromResumeDataOptions` | `executeAgent.ts:506`                             | 17                                                      |
| `WorkflowScriptStrategyParams`       | `workflowScriptStrategy.ts:105`                   | 14 (all used in body)                                   |
| `InBandSubagentExecutionOptions`     | `inBandSubagentExecution.ts:62,77`                | 13                                                      |
| `CliConfigExecuteOptions`            | `packages/cli/src/runtime/runExecution.ts:66,100` | 12                                                      |

**Deepest threads (frames SET→USE; pure-FWD frames in parens):**

| Field                                        | Frames             | Route                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approval trio via workflow-script grandchild | 10 (6 FWD)         | host → `runAgent` → `executeAgent` → ALS → `WorkflowScriptTool.ts:255` → `workflowScriptAgentRunner.ts:315-317` → `inBandSubagentExecution.ts:452` → `nativeSubagentStrategy.ts:290-292` → `executeAgent.ts:419-421` → child ALS → tools |
| approval trio via `delegate_agent` child     | 7 (4 FWD)          | parent ALS → `subagentExecution.ts:162-164/222-224` → `strategyParams` → strategy → `executeAgent` → child ALS → tools                                                                                                                   |
| `workflowPhase`                              | 6 (5 FWD)          | `workflowScriptAgentRunner.ts:322` → `ChildRunLaunchOptions` → inBand spread → `nativeSubagentStrategy.ts:293` → `executeAgent.ts:326` → `buildLifecycleOptions` → `AgentRunLifecycle.ts:488`                                            |
| `onIdle`                                     | 6 (4 FWD)          | `chatSessionController.ts:453` → `runAgent` → `executeAgent.ts:478` → variant → flow input → `ToolUseWaitNode.ts:34` (genuine host↔node callback — keep)                                                                                 |
| approval trio via chat resume                | 5 (3 FWD)          | `chatSessionController.ts:714-717` → `resumeQueuedToolUse.ts:137-139` → `executeAgent.ts:580-582` → ALS → tools                                                                                                                          |
| child `onStreamResolved`                     | 5 (4 FWD + rename) | `subagentExecution.ts:132-143` → params → strategy → `executeAgent.ts:408` (renamed `onBeforeActivation`) → `AgentLaunchContext.ts:395`                                                                                                  |
| `enforceCategory` (CLI)                      | 5 (4 FWD)          | `CliConfigExecuteOptions` → `executeCliRequest` → `runAgent` → `executeAgent` → `buildAgentLaunchContext`                                                                                                                                |
| in-band `notify`                             | 5 (3 FWD)          | `subagentExecution` → inBand opts → `executeInBand`¹ → `detachedChildRun` → `childRunLoop` ports                                                                                                                                         |
| `modelHandlerCompatibilityKey` (resume)      | 5 (3 FWD)          | workflow.ts → CLI opts → `runAgent` → `executeAgent` → `buildAgentLaunchContext` (deep consumer `ModelFactory.ts:238-251` — acceptable plumbing)                                                                                         |
| `copilotRouteOverride`                       | 4 (3 FWD)          | `executeCommand` → `runAgent` → `executeAgent` → `createModelHandler` (acceptable)                                                                                                                                                       |

¹ The in-band route has since changed on this branch: `executeInBand` is no longer a second driver (smells 1–2 of `2026-08-15-single-driver-child-runs.md`, landed). Line references for that hop are main-at-audit-time; implementing PRs must re-anchor against the branch.

**What the census cleared (negative results — do not re-hunt):** every `AgentCore`/`BaseFlowContextInit` field is boundary-resolved with multiple consumers; `ToolUseServices`/`ReflectionServices`/`CycleServices` fields all traced to live consumers; the services-vs-shared-store split has **no material leak** (flow directories contain zero `platform()` calls and zero ambient-session reads); the `AgentConfig.model`↔`modelCell.modelId` mirror is a documented single-writer design, adjudicated acceptable; no module boundary exists only to be mocked (every heavily-mocked target has ≥2 production consumers); no hook array with ≤1 hook and no one-registration registry exists anywhere in src/ or packages/*/src.

---

## 2. Candidates, ranked strong-first

Every candidate below is deletion-shaped: a field deleted, a resolution moved to the boundary, or a seam demoted. Net LoC is `git diff --stat` prediction against the audit baseline; element delta is per §14 R6 (constructs added minus deleted).

### C1 — Narrow `ResumeQueuedToolUseOptions` to its real surface _(strong)_

**Evidence:** the interface inherits 12 `SubagentRunOptions` fields (`resumeQueuedToolUse.ts:24`); its 3 production callers (`packages/extension/src/commands/agent/resumeFromResumeData.ts:84-87`, `packages/desktop/src/main/desktopAgentResume.ts:134-141`, `packages/cli/src/chat/chatSessionController.ts:711-733`) collectively supply only 4 of them (session + approval trio). Eight are never set by any caller: `tools`, `parentStreamId`, `onFollowUpConsumed`, `onProgress`, `onRunError`, `onRun`, `workflowPhase`, `userFollowUpSupport`. Verified precision: 7 of the 8 are forwarded at `resumeQueuedToolUse.ts:138,140-141,145-148`; `userFollowUpSupport` is never forwarded either (the resume path derives it from the persisted record, `executeAgent.ts:548-557,623`).
**Fix:** change `extends SubagentRunOptions` to a `Pick<SubagentRunOptions, 'session' | 'approvalPromptsUnavailable' | 'onApprovalPolicyDenial' | 'runtimeUnavailableTools'>`; delete the dead forwards; collapse `parentStreamId ?? resume.parentStreamId` to `resume.parentStreamId` (confirmed: no caller sets it). **Caveat (verified):** the `onFollowUpConsumed` closure at `:142-144` is not wholly dead — its `followUps = []` reset is load-bearing for restore-on-WAITING; only the inner `options.onFollowUpConsumed?.()` call at `:144` deletes.
**Net:** ≈ −11 LoC. **Elements:** −8 effective option fields, 0 added. **Rules:** §14 R6; §15 (options carried but never decided by anyone); "Exports are contracts" (AGENTS.md L628).

### C2 — Delete the two zero-passer injection ports on `RunReflectionFlowInput` _(strong)_

**Evidence:** `getOutputFileLocation?` / `workflowOutputPolicy?` (`runReflectionFlow.ts:77-80`) have **zero passers anywhere** — production caller `runReflectionAgent` (`executeAgent.ts:239-243`) spreads `AgentLaunchContext`, which declares neither field, so the spread cannot smuggle them; the sole other caller (`ReflectionFlowStateRecovery.vitest.ts:77-91`) passes neither. The three test files the survey attributed to these ports actually inject via the **`ReflectionServices` bag** (`ReflectionOutputLocation.vitest.ts:18-24`, `ResponseCycleCancellation.vitest.ts:60-71`, `OutputProgressEvents.vitest.ts:115-172`), which stays.
**Fix:** delete the two optional fields plus the two `input.X ??` clauses (`:152-153`, `:254-255`). **No test rework required** — the adversarial pass strengthened the original verdict. The `ReflectionServices` fields are multi-consumer (`ResponseCycleNode.ts:57`; `OutputNode.ts:254,278,322`) and are untouched.
**Net:** ≈ −8 LoC. **Elements:** −2 fields, −2 fallback clauses. **Rules:** L628; §15 M4 (`??` chain whose left arm can never fire).

### C3 — Delete two dead fields on `ToolUseFlowContext` _(strong)_

**Evidence (exhaustively verified, incl. dynamic access, spreads, packages/agent re-exports):** the `model` getter (`runToolUseFlow.ts:374-376`) has zero readers — every downstream holder is typed as `LiveToolUseFlowContext` (`ExecutionHandle.ts:98-110` Pick, which excludes it); the `DelegationTools.ts:131/253` `context.model` hits are the ALS `RunContext` getter, not this field. `interactions` (`:373`) is written once, never read — `interrupt()` (`:377-382`) uses the `runSession.interactions` closure, not the field.
**Fix:** delete both. **Explicitly kept:** `modelSwitchDisabledReason` — see §3, R-1.
**Net:** ≈ −7 LoC. **Elements:** −2 fields. **Rules:** L628.

### C4 — Delete `AgentRosterControllerDeps.fallbackTeamId` _(strong)_

**Evidence:** exactly 5 sites repo-wide: declaration (`src/agent/roster/AgentRosterController.ts:52`), one read `getDefaultTeamId() ?? this.deps.fallbackTeamId` (`:271`), three `fallbackTeamId: null` pass sites (`agentRegistry.ts:412`, `SettingsAgentControllerFactory.ts:72`, the vitest helper at `AgentRosterController.vitest.ts:44`). Both downstream consumers of `teamIdOf` (`:286`, `:297`) consume only truthy values; `?? null` only converts undefined→null — falsy either way. Behavior-identical deletion.
**Net:** ≈ −6 LoC. **Elements:** −1 field, −1 fallback. **Rules:** §15 M4; L628.

### C5 — Make `AgentLaunchInput.executionId` required; delete the dead second mint _(strong)_

**Evidence:** both production callers of `buildAgentLaunchContext` pass it (`executeAgent.ts:404` — its required parameter; `:559-571` — `resume.executionId`). The `?? generateExecutionId()` at `AgentLaunchContext.ts:623` is production-unreachable, and is a **second id-mint on a chain that already minted** — a silent-wrong-id hazard if a caller ever forgets.
**Net:** −2 LoC. **Elements:** −1 fallback. **Rules:** §15 "decide-once-carry-as-data"; the fact exists upstream, carry it.

### C6 — One session default per chain _(correctness; net ~0 — flagged per the honesty bar)_

**Evidence:** `runAgent.ts:107` resolves `options.session ?? defaultSession()` for lease release while the raw `options.session` rides to `buildAgentLaunchContext` (`AgentLaunchContext.ts:620`), which defaults `?? currentSession()` — and `currentSession()` is ambient-else-default (`SessionHandle.ts:1191`). The two can disagree if `runAgent` ever runs inside another run's ALS without an explicit session. Verified **latent, not live**: no current production caller hits the divergence (the `runAgent(...)` at `runWorkflowScript.ts:693` is a local runner port, not `@agent/runtime/runAgent`).
**Fix:** `runAgent` forwards its resolved `runSession` explicitly in the spread. **Justification for ~0 net:** deletes a fallback divergence (§15 "a `??` chain over >2 sources needs a named single owner") at zero abstraction cost; it is one line moved, not a construct added.

### C7 — Delete the redundant `interactions` parameter on `assembleAgentLaunchContext` _(solid)_

**Evidence:** `AgentLaunchContext.ts:288` receives `interactions` alongside `input.session`, whose `.interactions` it equals (`:621,636-641`) — two channels for one fact.
**Fix:** delete the parameter; read `input.session.interactions`. **Net:** −3. **Elements:** −1 parameter. **Rules:** single owner per concern; §15 M4.

### C8 — Relocate `onFollowUpConsumed` off `SubagentRunOptions` _(solid)_

**Evidence:** zero external producers on the fresh-launch path — verified across all routes into `executeAgent`: `runAgent`'s Pick excludes it (`runAgent.ts:36-53`), `nativeSubagentStrategy.ts:282-300` omits it, the SDK routes through `runAgent` (`packages/agent/src/index.ts:282-291`). The only producer anywhere is `resumeQueuedToolUse.ts:142`'s internal closure. The fresh-path invocation `shared.onFollowUpConsumed?.()` at `executeAgent.ts:159` can never fire from a fresh bag.
**Fix:** move the field from `SubagentRunOptions` (`executeAgent.ts:297`) to `ResumeToolUseFromResumeDataOptions`. Neither direct resume caller sets it, so nothing breaks. **Net:** ≈ −3. **Elements:** field narrowed to its real scope.

### C9 — Delete the dead defaulted ctor param on `SettingsViewMessageHandler` _(solid)_

**Evidence:** `subscriptionUsage: SubscriptionUsageReader = new SubscriptionUsageService()` (`packages/extension/src/settingsView/SettingsViewMessageHandler.ts:153`) has zero second-arg passers repo-wide **including tests** (sole prod call `SettingsViewProvider.ts:38`; all 3 vitest ctor sites pass 1 arg). Same species as the shared-contracts doc's Tier-2 "options with zero passers" — that sweep covered `*Options` fields, not defaulted ctor params (the doc flags this gap itself at `:346-348`).
**Fix:** collapse to a local. **Net:** ≈ −3. **Elements:** −1 seam.

### C10 — Doc fixes _(zero-risk)_

- `RunToolUseFlowInput.isSubagent` comment claims "delegation tools are filtered out" (`runToolUseFlow.ts:86`) and `ExecuteAgentOptions.isSubagent` claims "proposal tools are filtered out" (`executeAgent.ts:348`) — no tool-filtering site keys on `isSubagent`; its live effects are the prompt variant (`PromptBuilder.ts:200`), WAITING-suspend (`ToolUseWaitNode.ts:76/89/120`), and view/error-suppression defaults (`executeAgent.ts:409-412`).
- `docs/architecture/pocketflow-state.md:69` says `shared.state.stateSlices`; the field is `shared.stateSlices` (`nodes/types.ts:55`).

### C11 — `DesktopAgentLaunchOptions` as a Pick _(cosmetic tail)_

`desktopAgentLaunch.ts:30-42` redeclares 4 `RunAgentOptions` fields, all pure-FWD at `:54-57`; `runExecution.ts:78` already models the Pick discipline. **Net:** ≈ −8 decl/doc lines. Drift-proofing, not behavior.

### C12 — `userFollowUpSupport` derivation helper _(flagged: adds one element)_

**Evidence:** the rule (`category === ToolUse && !single-cycle`) is derived at three sites (`runAgent.ts:115-119`, `subagentExecution.ts:202-205`, `nativeSubagentStrategy.ts:308-312`); the resume path correctly reads the persisted record instead (`executeAgent.ts:555-557`).
**Fix:** one 3-caller helper. **Honesty flag:** element delta +1 function against −3 duplicated derivations, net ≈ −4 LoC. Permitted by L622 (three callers, not single-caller); justification is drift-guarding a persisted-contract rule, not DRY for its own sake. Lowest priority; acceptable to drop.

### C13 — Approval trio: single owner for a launch-pinned fact _(design-level — demoted from mechanical by the adversarial pass)_

**The finding stands:** the trio rides 6 pure-FWD frames on the workflow-script grandchild chain (A″) and 4 on the delegate_agent chain (A′), re-threading byte-identical values from parent ALS to child ALS through `subagentExecution.ts:162-164/222-224` → `nativeSubagentStrategy.ts:117-119,290-292,376-378` → `executeAgent.ts:419-421/580-582`. Full-repo grep confirms **no intermediate hop reads or branches** — every read is at the declared use sites (`bashApproval.ts:109,114`; `toolEditApproval.ts:264,268`; `agentToolResolution.ts:120-134`; `runToolUseFlow.ts:201-202`; `ResponseCycleFlow.ts:217-221`; `proposalFlow.ts:190`).

**The proposed cure was refuted as mechanical:** the survey's "host-mode facts, invariant per session" premise fails for the CLI chat host. `SessionHandle` owns a **mutable** `approvalPolicy` (`SessionHandle.ts:260`), the TUI changes it mid-session (`approvalCommand.ts:30` → `setApprovalPolicy`), and `approvalsUnavailable` is recomputed **per launched run** (`chatSessionController.ts:387`); `settleApprovals.ts:61-66` documents it as "the launch-time policy the run is pinned to." A session-owned trio would either flip mid-run (breaking documented pinning and changing `bashApproval`/`toolEditApproval` behavior for in-flight runs) or require freezing at launch — which is run scoping again — and would dual-own a fact derivable from `session.approvalPolicy`, the adjudicated anti-pattern. Additionally `runExecution.ts:515-517` folds a per-call `CliConfigExecuteOptions.runtimeUnavailableTools` (`:73`) knob, making the value per-launch by design.

**Disposition:** keep as its own design step, not a batch item. The deletion target is real (est. −40/−50 LoC across ~14 files if solved), but the implementing PR needs an explicit launch-pinned-snapshot design first — who freezes the trio at launch, and where the frozen copy lives without creating a second owner beside `session.approvalPolicy`. The explicitly rejected shapes: session-owned mutable trio (above), and implicit child inheritance of parent ALS values (dual-ownership). If no shape clears §15's single-owner bar, the answer is to keep the explicit threading — it is ugly but honest.

### C14 — Test-only seam demotion _(gated on the house ruling in the shared-contracts doc)_

The seams census found 8 seams/families of the "one production impl; seam exists for tests" species that the shared-contracts Tier-3 list (`docs/proposals/2026-08-15-shared-contracts-and-retirement.md:349-357`, 6 symbols) missed:

| Seam                                                                         | Def                                                                                                                                                                                                                                                                                                                                                                                                | Note                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `setServerSideKeyService` + `resetServerSideKeyServiceForTests`              | `src/auth/serverKeys/index.ts:80,:88`                                                                                                                                                                                                                                                                                                                                                              | zero production callers; prod path is lazy self-construction (`:53-76`) |
| `resetExecutionLeaseCoordinationForTests` + the `let leaseCoordination` swap | `src/agent/storage/executionLease.ts:150-156`                                                                                                                                                                                                                                                                                                                                                      | only non-init writer of the `let`                                       |
| `resetRelayTokenTierCacheForTests`                                           | `src/auth/relayToken.ts:103`                                                                                                                                                                                                                                                                                                                                                                       |                                                                         |
| transcript-fold test counters/hooks                                          | `packages/cli/.../subscribeStreamLog.ts:92-115`                                                                                                                                                                                                                                                                                                                                                    | self-labeled "Test-only" in a prod module                               |
| `resetCliUpdateNotifyLatchForTests`                                          | `packages/cli/src/runtime/updateChecker.ts:299`                                                                                                                                                                                                                                                                                                                                                    |                                                                         |
| `resetAgentCatalogAuthRefreshScopeForTests`                                  | `packages/extension/.../agentCatalogRefreshScope.ts:35`                                                                                                                                                                                                                                                                                                                                            |                                                                         |
| `AgentCliSessionRegistry` defaulted deps bag                                 | `src/tools/agentCliSessionRegistry.ts:53`                                                                                                                                                                                                                                                                                                                                                          | both prod constructions use the default                                 |
| `unregisterSlashCommand`                                                     | `packages/cli/.../slashRegistry.ts:73`                                                                                                                                                                                                                                                                                                                                                             | zero prod callers; test teardown of a prod registry                     |
| injectable-clock family (`now?`/`nowMs?` defaulting `Date.now`)              | 12 sites: `directLspAdapter.ts:77`, `deviceCodePoll.ts:56`, `SubscriptionOAuthCoordinator.ts:105`, `CodexSessionCoordinator.ts:43` + `XaiSessionCoordinator.ts:43`, `updateCheck.ts:24`, `SubscriptionUsageService.ts:71`, `SettingsAgentCatalogController.ts:60`, cli `updateChecker.ts:261` + `supabaseAuthDeviceCode.ts:50` + `runProgressRenderer.ts:85`, desktop `desktopUpdateChecker.ts:63` | zero production passers anywhere; largest family by count               |

**Disposition:** grow the pending Tier-3 ruling PR to cover these — one mechanical, net-negative PR **if** the house ruling lands as "test seams move to test-kernel or die." The injectable-clock family carries test-rework cost (fake-timer migration) and is lowest-priority within the batch; it may be split out or deferred without weakening the rest. Do not pre-empt the ruling.

---

## 3. Rejected and thin candidates (do not refile)

**Refuted this round — permanent rows:**

- **R-1: deleting `ToolUseFlowContext.modelSwitchDisabledReason` from the exported surface.** REFUTED — it has a production caller the survey missed: `packages/cli/src/chat/tui/runChatTui.tsx:366-376` fetches the live flow via `runtimeSession.executions.getToolUseFlowContext(...)` and calls `activeFlow?.modelSwitchDisabledReason(candidateModel)` to drive the model-picker's disabled-reason display. The 6 test-fixture stubs exist because the Live type genuinely requires it. Load-bearing port.
- **R-2: approval trio → session-owned fields as a mechanical move.** Refuted as described in C13 — the value is a launch-pinned run fact derived from mutable session state, not a session invariant.

**Thin — measured and declined:**

- **`ToolUseServices.resumeShared` collapse** — LOC-neutral and semantically delicate (verbatim-messages/prompt-cache contract, `ToolUsePrepareNode.ts:52-65`). Fold in only if that file is otherwise touched.
- **`ToolUseServices` spread leak** (`services = {...input, …}` leaks undeclared input fields untyped) — fixing adds lines; note-only.
- **`workflowPhase` full-chain collapse** — one producer (`workflowScriptAgentRunner.ts:322`), one option-chain consumer (`AgentRunLifecycle.ts:488`, with downstream `handle.workflowPhase` readers at `executionRegistry.ts:700-701`), but the honest deletion has no clean hook (`onRun` is consumed by the strategy itself). The dead resume-path forward deletes via C1. **Do not build a new hook** (§13 build-implies-delete fails).
- **`DetachedChildRunInput` collapse** — 8-of-9 verbatim FWD, but it carries the lease-guard invariant with 3 callers. Keep.
- **`CycleRunServices.fileService` relocation** to `ToolUseRoundServices` — ±0 one-liner; note-only.
- **Chains D and E** (`modelHandlerCompatibilityKey`, `copilotRouteOverride`, `enforceCategory`, `onIdle`) — consumers are genuinely deep, no ambient alternative; acceptable plumbing.
- **`streamId` formula at 4 sites** — agreement is by shared function (`getStreamTabId`); `childRunLoop.ts:280-286` documents it load-bearing. No change.
- **`AgentConfig.model` vs `modelCell.modelId` mirror** — adjudicated acceptable (single writer `onModelChanged`, `executeAgent.ts:163-169`; depth readers display/debug-only). Do not re-litigate.
- **Cost-accounting chain** — each hop wraps per the documented cumulative-commit contract (`childRunLoop.ts:69-101`). Keep.
- **Seams census negatives** — `SharedToolInjectionRegistry` (2 registrations; the one-consumer registry was already pruned in-file), `ChildRunStrategy` (2 prod strategies), `makeCoordinator` (2 impls), `registerExternalRoot` (5 kinds — the extension-only registrar is a _gap_, tracked as a separate concern, not a seam smell), vi.mock census (no boundary exists only to be mocked). Do not re-hunt.

**Settled by prior rulings — cite, never refile** (tournament ledger #8974 rows carry over via SSOT §0.1; maintainer's closing directive on #8974 stands):

- Ambient inheritance of options at `executeAgent` (child implicitly reading parent ALS) — the adjudicated dual-ownership anti-pattern.
- #6945-style grouping / ISP-narrowed node interfaces / `RunScope`-as-DI-object / cohesion-splitting the services bag (design-philosophy L101: "REJECTED TRAP").
- `BootstrapConfig` / flat `RunOptions` superset threaded through hosts (§0.1 item 11).
- `SessionHandle` facade, `runSession()`, deleting `defaultSession()` (§0.1 item 4).
- `SessionHostInteractions` forward-deepening; `requestToolEditApproval` required (§0.1 item 7).
- A8 stage 2 unified subscription registry (measured out with probe evidence).
- Ledger-banned: ApprovalRequestHandler deletion, hook engine, progress-vocabulary unification, Google GenAI handler deletion, full D3 dual-writer retirement, settings one-composition-path.
- B8 negatives: inline-agent machinery (SDK Tier-1 mechanism), legacy-storage migrations (need a retirement date).
- Caching per-request `getConfig` in `src/tools/approval/*` (§0.1 item 9 — live toggles are correct).
- Merged super-cycle flow; unified per-node outcome unions; shared detached-launcher abstraction (2026-08-14 non-goals — except the in-band/detached split, which the maintainer re-opened and which was resolved by the single-driver landing; see §4).
- `provideAgentEngine`, `setIncludedModelAccess`, the codex/xai probes, `setCliAgentResumeHandler` — legitimate cycle/ordering-severing slots, doc-commented; `registerInlineAgents` — frozen SDK surface; `RESET_HOOKS` — already owned by the lifecycle doc's migration plan.

---

## 4. Constraints register for the implementing PRs

1. **No new carriers.** No parameter object, no `RunScope`-style DI bag, no shared resolver/hydration helper, no new `resolve*`/`derive*` mid-layer (§15; no-deep-injection ruling and its 2026-08-15 extension). Every fix here is a field deletion, a Pick-narrowing, or a parameter removal.
2. **§0.1 item 7:** `SessionHostInteractions`' 9 one-line forwards and `requestToolEditApproval`'s optionality are load-bearing — C13's eventual design must not touch them.
3. **§0.1 item 11:** composition folds take the `nodeHost.ts` shape — named helpers called in order by each composition root.
4. **`provideAgentEngine` is settled** (#10475 in-file ruling, `nativeSubagentStrategy.ts:63-88`) — no PR may convert it to an explicit parameter.
5. **Frozen `@agent` surface:** C8/C13 touch `SubagentRunOptions`/`executeAgent` types — verify `host-agent-import-baseline` and the SDK build do not widen; the `packages/agent` route goes through `runAgent` (`index.ts:11,282-291`).
6. **§13/§14 mechanics:** every PR body states `git diff --stat` net LoC and the R6 element delta; no construct merges without same-PR deletion; PR template `## Net elements (R6)` / `## Consumer counts (R8)` sections are mandatory (#7736).
7. **Branch drift:** this branch (delegation-substrate-wave1) already landed the single-driver change — `executeInBand` is gone as a second driver, and `resumeQueuedToolUse.ts` / `executeAgent.ts` line numbers have moved. Re-anchor every C1/C8/C13 reference against branch HEAD before editing; the 2026-08-03 "in-band vs detached durability" non-goal is no longer standing.
8. **Coordinate, don't duplicate, with open issues:** #10652 (no-ALS test — C13's eventual PR must keep it green), #10644 (B7 reflection-output remainder — C2 touches the same flow file), #10583/#10584/#10579 (run-kind/result-union type work adjacent to C1's Pick), #10629, #10625, #10628/#10618.
9. **Typecheck gate:** builds don't type check; every batch runs `npm run typecheck` (the C1/C3 narrowings are exactly the class of change vitest passes and tsc fails).
10. **Tests:** C2 requires no test rework (verified); C3 shrinks Live-type fixtures; C14's clock family is the only item with real fake-timer migration cost.

---

## 5. Suggested PR batching

**PR 1 — agent-runtime dead-surface sweep** (C1, C2, C3, C5, C7, C8, plus the C10 comment fixes in the same files). One reviewable theme: fields with zero producers or zero readers on the launch/resume chain. Est. net ≈ −34 LoC, element delta ≈ −16, zero behavior change. Mechanical; highest confidence.

**PR 2 — periphery deletions** (C4 `fallbackTeamId`, C9 `SettingsViewMessageHandler` param, `pocketflow-state.md:69` doc fix). Est. net ≈ −10. Separate because it crosses into controllers/extension territory with different reviewers.

**PR 3 — session-default correctness** (C6, optionally C12). Small and correctness-flavored; kept out of PR 1 so the behavior-identical sweep stays trivially auditable. Net ≈ 0 to −4, with the C6 justification (deletes a latent `??`-divergence) stated in the body per the honesty bar.

**PR 4 — test-only seam demotion** (C14). Gated on the shared-contracts Tier-3 house ruling; lands as one mechanical PR extending that ruling's list, with the injectable-clock family as a severable tail commit.

**Step 5 — approval-trio design note** (C13). Not a PR yet: a short addendum to this proposal resolving the launch-pinned-snapshot question (owner, freeze point, relationship to `session.approvalPolicy`), reviewed by the maintainer before any code. If no shape clears the single-owner bar, close it as "explicit threading is the correct honest form" and add it to the do-not-refile rows.

**Tail (optional, either PR 2 or 3):** C11 desktop Pick.

Aggregate if all mechanical batches land: ≈ −50 to −60 LoC, ~−25 elements, zero new constructs — before C13/C14, which carry the only remaining upside (−40/−50 and a net-negative seam sweep respectively) and both sit behind explicit gates.

---

## 6. Resolution addendum (2026-08-16)

**C13 — approval trio is resolved; do-not-refile.** Current main post-#10647 already freezes `approvalPromptsUnavailable`, `runtimeUnavailableTools`, and `stopAfterCycle` in the per-launch `ToolPolicy` (`src/agent/core/flows/BaseFlowServices.ts:26-45`, frozen by `createToolPolicy`), carried on `AgentLaunchContext` (`src/agent/runtime/AgentLaunchContext.ts:120`, `:510`) and projected into the ambient context through `withExecutionRunContext` (`:138-154`). That is the accepted single-owner shape: launch-scoped policy frozen at the boundary, never re-derived from mutable session state. `onApprovalPolicyDenial` stays explicit on the projection boundary because it is a caller-injected callback, not a session-derived fact (`:142`, `:154`) — correct and intentional, not residue.

**C12 is not pursued.** Its three-site `userFollowUpSupport` derivation premise is stale on current main: `single-cycle` collapsed into the launch-scoped `stopAfterCycle` (`ToolPolicy`) via #10647, and the remaining derivations are entry-point-specific rather than one shared rule.

**C14 is dropped.** The Tier-3 test-seam house ruling was closed not-planned in #10675 (the test-seam portion is out under the maintainer's no-more-testing direction); the production projection-zero/bandwidth gate is tracked separately under #10672.
