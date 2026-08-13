# Runtime↔UI coupling and run/session data-model layering audit (2026-07-08)

> **Status:** Open tracking audit (2026-07-08). Grounded on a fresh `origin/main`
> worktree at HEAD `54c3bed25` (ahead of the recorded `043c7df0a`; Stage-5
> #7625/#7626/#7627 merged). Companion to
> [`2026-07-03-tech-debt-audit.md`](./2026-07-03-tech-debt-audit.md),
> [`2026-07-07-fewer-elements.md`](./2026-07-07-fewer-elements.md),
> [`2026-07-03-agent-runtime-ui-coupling-audit.md`](./2026-07-03-agent-runtime-ui-coupling-audit.md),
> and [`2026-07-03-session-scoped-runtime-architecture.md`](./2026-07-03-session-scoped-runtime-architecture.md).
> Re-verify every pin before acting — this territory changes at ~60 PRs/day.

**Scope.** The maintainer steered this sweep explicitly _away_ from the
model-handler layer (A1/C3, still the largest raw mass) and _toward_ the
runtime↔UI coupling surface and the run/session data-structure layering: dual
states, plane multiplications, mis-owned/re-derived facts, leaky boundaries,
half-migrations, the bag↔RunContext split-brain, the PocketFlow node/flow
indirection, the agent-definition/registry shape, and the FS-wrapper/cache
stack.

**Method.** Three parallel workflows, each _read → independent adversarial verify
→ synthesize_: (1) ~40 readers over the session-runtime, facts, interaction,
status, agents, flow-engine, and storage planes (Parts A/B); (2) four lenses on
error-handling / try-catch discipline, error-pipeline ownership, one-failure→N-host
rendering, and a live dual-systems census (Parts C/D); (3) an APoSD design-philosophy
pass — module depth, pass-through layers, information leakage, combine/separate
(Part E). **72 findings survived adversarial verification** (3 high, 21 medium, 48
low) out of 106 raised; **27 corpus items were reconfirmed already-resolved** and
are listed so they stop being re-raised. Verifiers refuted or downgraded ~30%
(one claimed "net-delete" was caught proposing a fix that re-homed a shared
vocabulary into the CLI — the exact trap it warned against). Cross-area dedup:
`resolveAndResumeStream` was rediscovered 3×, the desktop `removeStream` leak and
the dead CLI `removeStream` arm 2× each, and the bag↔RunContext carrier appears in
Parts A/B/E — deduped in place with cross-references.

**Non-goals (R4, reaffirmed).** No shared CLI/webview reducer, no merged host
implementations, no new planes/buses/vocabularies/coordinator layers. Every fix
below is net-delete-biased or, where it must net-add, is a memo/ordering fix with
no new element — never a new abstraction. Rejected traps are stated per finding so
the discipline holds.

**Ruled healthy up front** (don't churn — see the consolidated "Healthy" section):
the emit rail is single-owner (`emitRuntimeEvent`→`session.events`, zero
`bus.emit`/`ProgressEventBus` in VS Code-free zones); `ToolResult`'s status
contract is source-declared (C1a done); the two child-run drivers are unified
(C1b done); resumability is one storage-owned predicate; crash-repair is one
shared owner; the coordinator layer is folded into `session.interactions`.

---

> **Companion documents** (same audit, split for length):
>
> - [`2026-07-09-tech-debt-error-ownership.md`](./2026-07-09-tech-debt-error-ownership.md) — Part C (error handling & ownership) + Part D (dual-systems census).
> - [`2026-07-09-tech-debt-design-philosophy.md`](./2026-07-09-tech-debt-design-philosophy.md) — Part E (APoSD design-philosophy evaluation + module-depth scorecard).

---

## Part A — Runtime↔UI coupling & layering debt (maintainer's #1 focus)

Ranked by leverage = (elements/LoC deletable) × (bug-yield) × (safety), highest-leverage
net-deletions first.

### A1. Desktop silently no-ops the `removeStream` session fact → leaked tabs + per-stream resources (HIGH; live bug; net −7 LoC)

_(Consolidates facts-plane `RC1` and host-wiring `HW1` — one gap, two readers.)_

**Pins.** `src/tools/delegation/childStream.ts:331-338` emits `removeStream` on `autoClose`;
`src/tools/bash.ts:450,466` pass `{autoClose:true}` on every background completion
(`:475` prints `Stream tab: ${childStreamId}` — the child is a real rail tab).
`src/shared/progressView/backend/events/ProgressFactApplier.ts:197-198` is `case
'removeStream': return;` (bare no-op, teardown delegated to hosts).
`ProgressBackend.setupEventListeners` (`ProgressBackend.ts:118-125`) is the _only_
shared session-fact route for **both** extension and desktop. Extension wires the
teardown via a bespoke subscriber (`ProgressViewProvider.ts:186-198` →
`ProgressViewMessageHandler.ts:134-137` = `deleteStream` + `GoalStore.forget`);
CLI TUI wires it (`subscribeRuntimeHost.ts:417-419`). Desktop wires _neither_:
`desktopProgressEventBridge.ts:438-458` `handleSessionFact` has no `removeStream`
case (`default: return`); `grep removeStream packages/desktop` = 0. Desktop already
owns a full `deleteStream` (`desktopAgentExecution.ts:1073-1096`:
`releaseStreamResources` + `releaseApprovalsForStream` + `GoalStore.forget` +
`state.clearStream` + `DELETE_STREAM` IPC) — wired only to the UI lifecycle command
at `:522`, never to the fact. `bash` is not in `DESKTOP_UNAVAILABLE_TOOLS`
(`:118-122`), so background bash runs on desktop.

**Mechanism.** The migration made the shared applier no-op `removeStream` and
delegate host teardown; extension and CLI were wired, desktop was missed. Every
background bash/codex child emits `removeStream` on completion → on desktop it
matches no case in either the shared applier or the bridge and is dropped. Each
finished child tab persists forever and its approval state, follow-up queue,
persisted snapshot, and goal record are never released. Extension and CLI are
clean. This is the canonical "works-in-extension-broken-on-desktop" per-host
mis-ownership class (corpus A2 / #6887 lineage).

**Fix (net-delete).** Make the shared applier the single owner: in
`ProgressBackend.setupEventListeners` handle the `removeStream` session fact by
invoking a host deletion callback threaded through the already-shared
`createProgressBackendUiConfig` (extension→`removeStreamFromHost`,
desktop→`deleteStream`). Remove `ProgressFactApplier`'s dead no-op case and the
extension's standalone 13-line `ProgressViewProvider` subscriber. Net ≈ −7 LoC,
no new port; a fourth host can't drift again. CLI keeps its own
`subscribeRuntimeHost` handling (it does not use `ProgressBackend` — accepted
divergence), so the shared-backend fix covers extension+desktop only.

**Rejected trap.** Adding a duplicate per-host `removeStream` subscriber to the
desktop (mirroring `ProgressViewProvider`) "fixes" desktop but perpetuates the
per-host mis-ownership that caused the gap. Do **not** mint a new deletion
port/bus — both hosts already have `deleteStream`; thread it through the existing
shared UI config.

### A2. Dead legacy tool-edit approval fallback: a triple-wired resting state superseded by host-interactions (HIGH; ~−300 to −450 LoC; R1 dual-state)

**R1 dual-state — resting; no open delete PR; no #6981 row.** Documented target
(`2026-07-03-session-scoped-runtime-architecture.md` ~248-253) already prescribes the collapse.

**Pins.** `src/tools/approval/toolEditApproval.ts:232-238` = route 1 (preferred,
host-interactions); `:240-249` = the fallback
`toolEditApprovalController.enqueue(() => (context?.toolEditApprovalHandler ??
platform().toolEditApproval)(request))`. `platform().toolEditApproval` is read
only at `:246`; `context.toolEditApprovalHandler` consumed only at `:246`.
All four production hosts wire `runtimeHost.interactions` _and_ provide
`requestToolEditApproval` (`extensionAgentRuntimeHost.ts:16`,
`desktopAgentExecution.ts:253` + `desktopHostInteractions.ts:77`,
`chatSessionController.ts:234/240`, `runExecution.ts:169-176` +
`approvalAdapter.ts:221`). Subagents ride route 1 too
(`subagentExecution.ts:135` `runtimeHost = parentContext.runtimeHost`). The only
caller that reaches the fallback is the test-only `noopAgentRuntimeHost`
(`AgentRuntimeHost.ts:38`, zero production usages) via
`ConcurrentToolEditApprovalHandlers.vitest.ts`.

**Mechanism.** Tool-edit approval accreted three delivery mechanisms: (3) the
process-global `platform().toolEditApproval` port, (2) the per-run
`RunContext.toolEditApprovalHandler` override (multi-window era), (1) the
session-scoped host-interactions port that supersedes both. Route 1 always wins
in production, so routes 2+3 and the module-global `enqueue` serialization are
dead-but-fully-wired, reachable only through the noop test host. Sibling commit
`134524753` already removed the analogous bash + userQuestion fallbacks (bash
now _throws_ at `bashApproval.ts:108`) but deliberately left tool-edit — a staged
migration, not a required path.

**Fix (net-delete, staged 2-then-3).** Delete the `?? platform().toolEditApproval`
fallback and make `requestToolEditApproval` require the host-interactions route
(throw, mirroring `bashApproval.ts:108`). Then delete: the Platform port field
(`platform.ts:75` + `nodeHost.ts:105-106`), `RunContext.toolEditApprovalHandler`

- its ~10 propagation sites (`executeAgent.ts`, `runAgent.ts`,
  `AgentLaunchContext.ts`, `subagentExecution.ts:207/272`, both native strategies,
  `resumeToolUseSnapshot.ts`, `resumeQueuedToolUse.ts`), the
  `createDesktop/CliToolEditApprovalPort` + `setDesktopToolEditApprovalHandler`
  factories, and rewrite the one noop-host test to exercise route 1. ≈ −300 to −450
  LoC, −1 port, −1 context field, 0 new elements.

**Rejected trap.** Do not "keep it as a safety net" or add a unifying abstraction
over the three routes (net-add). This is dead code the target design already
prescribes removing.

### A3. CLI synthetic-entry machinery: render-time dedup-by-normalized-text for the missing stable-id finalized assistant message (MED; ~−120 LoC; R1 dual-state)

**R1 dual-state — resting; fix = land issue #7086, implemented by in-flight PR #7601.**

**Pins.** `packages/cli/src/chat/tui/state/transcript.ts:49-99`
`appendAssistantTranscriptIfMissing` (51 LoC) dedups the run-result fallback
against store-derived entries **by normalized text**, with
`.replaceAll('\\checkmark','✓')` at `:38-40`. The `✓`↔`\checkmark` divergence is
real: `src/replacement/rules.ts:826` maps `'✓' → '\\checkmark'`, so the
recorder-normalized store text and the raw `result.lastResponse` genuinely differ.
`subscribeStreamLog.ts:393` filters synthetic entries; `:403-422` splices by
`syntheticAfterSeq`; `:327-338` sort-tolerates the out-of-order splice.
`cliState.ts:46-51` adds 3 synthetic fields to `ConversationEntryBase`.
`transcriptProjection.ts:32-47` is the post-audit single `fallbackAssistant`
option; call sites `chatSessionController.ts:302-309` (onIdle/WAITING) and
`:319-329` (tool-final). Tests exercise it: `TuiStateAndFocus.vitest.mts:2060-2264`.

**Mechanism.** `StreamLogStore` carries no guaranteed stable-id finalized assistant
message, so the CLI synthesizes a "final" entry from `result.lastResponse` and
reconciles it against the store-derived `MODEL_RESPONSE` by comparing _normalized_
text (with the `✓`/`\checkmark` substitution). When the predicate misjudges
(replacement rules, subagent-followup trimming, whitespace) the finalized message
duplicates in scrollback or vanishes — the most fragile CLI state code, and an R1
live old+new pair for one logical message. `syncStreamLog` already calls
`flushPendingRunTraces()` (`subscribeStreamLog.ts:379`), itself a timing
workaround for the same store-materialization gap.

**Fix (net-delete).** Land #7086: route the finalized text through the existing
recorder surface — `AgentTrace.finalize(finalText)` (`AgentTrace.ts:112`) /
`stream.end{finalText}` (`TraceEmitter.ts:370-388`) — or a stable-id
`MODEL_RESPONSE` upsert, so the store owns the finalized message. Then delete
`appendAssistantTranscriptIfMissing`, the `\checkmark` normalization, the
`syntheticAfterSeq` splice, the sort-tolerance, and the 3 synthetic fields. The
post-audit `projectStreamTranscript` consolidation makes this one
`fallbackAssistant` option to remove. Net ≈ −120 LoC, −1 helper, −3 fields; adds
a stable-id upsert in the recorder (no new host element).

**Rejected trap.** Adding more normalization rules or a smarter render-time dedup
predicate deepens the very workaround the Render-Time-Workarounds rule forbids.
A shared CLI/webview reducer is rejected (R4): the extension applies IPC deltas
across a process boundary; the CLI reads the store in-process.

### A4. `resolveAndResumeStream` reads the process-global `StreamStatusService`, not the session that owns the fact → the resume anti-clobber guard is dead on desktop (MED; net-neutral correctness)

_(Consolidates runtime-core `RC1`, status-vocabulary `RC1`, and async-races `AR1`
— independently rediscovered 3×.)_

**Pins.** `src/agent/runtime/resolveAndResumeStream.ts:17` value-imports the
`StreamStatusService` singleton; guards at `:82` (early return) and `:117`
(post-retrieval TOCTOU re-check) both call
`StreamStatusService.isActiveOrResuming(streamId)`. `StreamStatusService.ts:324` is
the process singleton. `SessionHandle.ts:113` gives a non-default session a _fresh_
`new StreamStatusMachine()`; `:313-322` `defaultSession()` aliases the singleton.
`AgentLaunchContext.ts:593-594` `launchSession = input.session ?? currentSession()`,
`streamStatus = launchSession.status`. Desktop injects `session: this.session`
(`desktopAgentExecution.ts:1400`) whose status machine is per-window
(`:250 new SessionHandle({ hostChannel })`, `:44 import type` only) — so run status
writes to `this.session.status` while the guard reads the empty global. The
extension injects no session → `defaultSession().status === StreamStatusService`
by identity → guard is accidentally correct there. `restartRepair.ts:4-5,26`
is the correct injected-machine template.

**Mechanism.** On desktop `StreamStatusService.isActiveOrResuming` is always false,
so both guards are dead. Blast radius is narrow: `resumeInFlight` (module-global,
unique `streamId`) still dedupes double-resume-entry, and the workflow branch is
backstopped by the per-window `acquireStreamOrThrow` (a raced workflow resume
throws → `reportFailure` → a spurious "Resume failed: … already running" dialog
rather than a clean skip; extension silently no-ops). The one unguarded path is
tool-use resume (`streamTabIdOverride` → `reservedStreamId=undefined` → no
acquire), where `resumeQueuedToolUse.ts:63-76` flips `RESUMING` + drains the
follow-up queue on side effects the `:117` re-check was meant to prevent — but
only in the very hard-to-reach window where a non-resume launch flips the same
executionId-derived streamId active during retrieval. Regression, born dead on
desktop with the 2026-06-14 session split (`96f63e854`), not orphaned later.

**Fix (net-neutral).** Add `readonly session?: SessionHandle` (or a
`streamStatus` field) to `ResumeStreamPorts`; read
`(ports.session ?? defaultSession()).status.isActiveOrResuming(streamId)` at both
sites; delete the `:17` singleton import. Desktop passes `session: this.session`
(`:1175`); the extension caller (`resumeFromSnapshot.ts:30`) passes nothing →
byte-identical to today. Precedent: `resumeQueuedToolUse.ts:14` already imports
`defaultSession`. ≈ +1 optional field / +2 caller lines / −1 import.

**Rejected trap.** Do **not** call `currentSession().status` inside
`resolveAndResumeStream` — resume runs outside any run ALS, so `currentSession()`
returns `defaultSession()` and stays wrong for desktop. The owner must be injected
by the caller. Do not add a status port or a per-stream `StreamStatusService`
registry (new indirection for a fact each session already owns).

### A5. `AgentRuntimeHost.interactions` is a redundant parallel access path to `session.interactions` (MED; net −1 field/−4 wirings; R1 dual-state)

**R1 dual-state — dual ACCESS PATH / dual NAMING (cannot diverge in production);
no ledger row.**

**Pins.** `AgentRuntimeHost.ts:30` `readonly interactions?: HostInteractions`
(the "direct host-event sink"). The _owner_ is `SessionHandle.ts:103`
`readonly interactions: SessionHostInteractions`
(`HostInteractions.ts:142-151` "Session-owned host interaction surface"). All 4
hosts set `runtimeHost.interactions = session.interactions`
(`extensionAgentRuntimeHost.ts:16`, `desktopAgentExecution.ts:253`,
`chatSessionController.ts:240`, `runExecution.ts:176`). Split read convention:
4 tool sites read `runtimeHost.interactions?.requestX` (`bashApproval.ts:102`,
`UserQuestionTool.ts:74`, `ExternalInquiryTool.ts:422`, `toolEditApproval.ts:233`)
while retry/plan/proposal + all resolve/cancel read `session/currentSession().interactions`
(`RetryState.ts:274`, `PlanTool.ts:259`, `proposalFlow.ts:159`,
`runToolUseFlow.ts:288/472`, `approval/index.ts:38/82/108`).
`currentSession()` (`SessionHandle.ts:332-333`) is never undefined.

**Mechanism.** One object, two names, no principled selection rule — a leftover
from before `RunContext` carried `session`. A reader can't tell whether the two
can diverge (they can't in production), and new interaction code copies whichever
pattern it last saw; it also blurs the write-only presentation sink (`emit`) from
the request/reply session surface. They diverge only in tests that inject a mocked
`interactions` into a session-less `runtimeHost` (`progressTestUtils.ts:65`,
`GoogleInteractions*.vitest.ts`).

**Fix (net-delete).** Delete `AgentRuntimeHost.interactions`; route the 4 tool
read sites through `currentSession().interactions` (single owner). Migrate the
session-less test/bare-context fakes to construct a `SessionHandle` (matches
production, where `session` is always present in a launch context). ≈ −1 field,
−4 wirings; bounded test rewiring (R7).

**Rejected trap.** A resolver/DI parameter choosing between the two is wrong (a
layer for a split that should be deleted). A blind field-delete switching to
`context.session.interactions` without `currentSession()` hits `undefined` on
bare/test contexts.

### A6. 6 of 11 `RuntimeInteractionEventPayloads` arms are phantom emit events (MED; net-neutral relocate; R1 dual-state)

**R1 dual-state — types-only zombie on the core→host `emit` contract; no ledger row.**

**Pins.** `runtimeInteractionEvents.ts:19-40` declares 11 arms, folded into
`AgentRuntimeEventPayloads` (`AgentRuntimeHost.ts:5`) = the `.emit` vocabulary.
Per-arm grep: **5 are live** — `showToolEditPermission` (`toolEditApproval.ts:118`),
`resolveToolEditPermission` (`nativeToolEditApproval.ts:126`,
`desktopToolEditApproval.ts:229`), and 3 bypass states via
`streamApprovalQueue.ts:64` (callers `proposalApproval.ts:10`, `bashApproval.ts:41`,
`toolEditApproval.ts:40`). **6 are never emitted**: `showBashPermission`,
`showPlanApproval`, `showAgentProposal`, `showRetryRequest`, `showExternalInquiry`,
`showUserQuestion` — their flows all run through `session.interactions` request/reply
(`bashApproval:102`, `RetryState:274`, `PlanTool:259`, `proposalFlow:159`,
`UserQuestionTool:74`, `ExternalInquiryTool:422`; headless wiring
`runExecution.ts:170`). The dead CLI adapter branches
`handleCliApprovalEvent` (`approvalAdapter.ts:302/311`) are unreachable.

**Mechanism.** The pre-request/reply emit era was half-retired: the shared
`emit` contract still advertises 6 approval events no code emits, forcing every
host `emit()` to type-accept events that never arrive. The 6 names are _not_ fully
dead — the CLI reuses them as its own internal discriminator vocabulary
(`approvalEvents.ts:6-34`, `decideApprovalEvent` at `approvalAdapter.ts:104`), so
narrowing the shared type requires _relocating_ a payload map into CLI-owned types.

**Fix (net-neutral, contract-negative).** Narrow `RuntimeInteractionEventPayloads`
to the 5 emitted arms; relocate the 6 request payload shapes into a CLI-local map
pointing at the `*Permission` schemas they already alias 1:1 (drop the `satisfies
keyof RuntimeInteractionEventPayloads` constraints); delete the unreachable
`handleCliApprovalEvent` branches + the `isRuntimeInteractionEvent` gate for them.
LoC moved not added; shared-contract surface −6 arms. Natural next step of ongoing
work (`1edb66c16` "split runtime interaction events", Stage-5 "split backend
interaction handler").

**Rejected trap.** Deleting `RuntimeInteractionEventPayloads`/`runtimeInteractionEvents.ts`
wholesale is wrong (5 arms live). Assuming the CLI needs no replacement types is
wrong (it reuses the 6 names) — removal is a move, not a free delete.

### A7. `bashApprovalController` pending registry is dead — bash never registers, so its reject-sweeps are permanent no-ops (MED; net −3 to −10 LoC)

**Pins.** `bashApproval.ts:88` uses only `bashApprovalController.enqueue`
(+`.bypass` at `:50/62/68/98`); it never calls `registerPending`
(`registerPending` has one non-production caller,
`ApprovalCleanupScope.vitest.ts:76-80`). `approval/index.ts:34/81/104` call
`bashApprovalController.rejectPendingForStream/rejectUnscopedPending/rejectAllPending`;
`streamApprovalQueue.ts:126` `rejectWhere` iterates the always-empty `pending`
Map → no-ops. Tool-edit's registry _is_ live
(`nativeToolEditApproval.ts:217`, `desktopToolEditApproval.ts:103`). Actual bash
cancellation flows via `session.interactions.cancel`
(`index.ts:38/82/108` → host `pendingRequests`, `desktopHostInteractions.ts:95`).

**Mechanism.** The migration moved bash pending bookkeeping into each host's
`pendingRequests` (settled via `session.interactions.cancel`) but left bash
constructing the pre-migration controller's pending-registry half and three
reject-sweep calls that iterate an empty map — dead surface that falsely implies
bash cancellation lives in the controller.

**Fix (net-delete).** Delete the 3 dead `bashApprovalController.reject*` calls
(`index.ts:34/81/104`) and the bash `registerPending` test lines; leave the
`StreamApprovalController` pending registry as tool-edit-only (genuinely live).

**Rejected trap.** Splitting `streamApprovalQueue` into a queue-only controller
for bash and a full controller for tool-edit adds a type/factory for a 3-line
win (net-add). Just delete the dead calls.

### A8. RETRACTED — decode-cascade claim rests on the retired `'runFact.'` protocol (#7713 follow-through)

**Correction (2026-07-10, follow-through on #7713).** This finding's pins rest
on the same fabricated/stale protocol as A13: run facts riding the `domain`
`AgentEvent` as `key:'runFact.'+name` with consumers recovering the name via
`fromRunFactDomainKey`. Verified independently at origin/main `4363b4089` (2026-07-10): `fromRunFactDomainKey`,
`toRunFactDomainKey`, and `RUN_FACT_DOMAIN_PREFIX` have zero hits repo-wide
(`git grep` across `src/` and `packages/`), and `runFactEvents.ts` is a 34-line
module exporting only `RunFactPayloads`/`RunFactEventName`/`emitRunFact` — the
string-prefix protocol was retired during the Stage-5 close-out (#6968), so the
described 4× hand-decode cascade cannot exist as cited. The four file:line pins
above date from before that retirement and no longer describe the code. If a
divergent-validation concern survives in the post-Stage-5 typed-arm shape, it
needs a fresh audit with true pins to re-file; nothing here should be cited as
evidence. (Issue #7713 flagged five sibling fabrications, retracted in the same
PR; this one was found by the same grep and retracted for consistency.)

### A9. `goalStateChanged → updateGoalActive` derivation duplicated in extension + desktop; the shared applier receives the fact but no-ops it (LOW; net ≈ −20 LoC, −2 subscription surfaces)

**Pins.** `progressEvents.ts:148-150` `GoalStateChangedPayload = { streamId }`
only. Extension `ProgressViewMessageHandler.ts:120-131` and desktop
`desktopProgressEventBridge.ts:507-513` both re-derive
`GoalStore.getForStream → isGoalInFlight → updateGoalActive(streamId, active,
{status, objective})` — byte-identical. The shared
`ProgressFactApplier.ts:153-154` handles `goalStateChanged` with a bare `return`
while holding `webviewUpdater`. `goalStore.ts` already imports `isGoalInFlight`
(`:9`) and `emitRuntimeEvent` (`:4`); emit sites `:123/203/269/298` have the goal
in hand.

**Mechanism.** Both webview hosts re-derive the identical goal-active projection
from a streamId-only fact through two subscription surfaces, while the shared
applier receives the same fact and discards it. The predicate is copied 2× on the
runtime→UI path and drifts if a status/objective field is added to one host.

**Fix (enrich at source).** Put `{ active: isGoalInFlight(goal), status, objective }`
onto `GoalStateChangedPayload` at the single owner (`goalStore.ts` emit); the
applier's `goalStateChanged` case calls `webviewUpdater.updateGoalActive(streamId,
payload.active, payload)`. Delete both host subscriptions (extension ctor block;
desktop `handleGoalStateChanged` + case + `onGoalStateChanged` option + wiring).
If `subscribeGoalStateChanges` becomes unused, retire it + its test. Net ≈ −20 LoC.

**Rejected trap.** Moving the derivation into the shared applier by importing
`@tools/goal` there is a new `shared→tools` layering violation (`src/shared` has
no `@tools` import today). Enrich the payload at the emit source instead.

### A10. `Shared*` process singletons + `StreamStatusService` are directly imported by 16 host sites — the `defaultSession()` alias is load-bearing, not a removable shim (LOW; −2/−3 exports, 16 edits; R1 alias-dual)

**R1 dual-state — resting alias (identity, cannot diverge); one of the ten known
duals (`defaultSession()` aliasing, fewer-elements:60); no ledger row.**

**Pins.** Three standalone singletons: `executionRegistry.ts:927`
`SharedExecutionRegistry`, `ExecutionSubscriptionBinder.ts:294`
`SharedExecutionSubscriptionBinder`, `StreamStatusService.ts:324`.
`SessionHandle.ts:315-317` `defaultSession()` composes all three _by identity_.
16 host usage sites import them directly (11 `SharedExecutionRegistry`:
`setupAssistantCommand:206`, `agentCommands:12/19`, `historyHandlers:102/129`,
`chatSessionController:204`, `agentModelCommands:108`, `handleSlashCommand:220`,
`runChatTui:445/461/734`; 5 `StreamStatusService`: `followUpCommand:29/52`,
`resumeCommand:67`, `ProgressStreamLifecycleHost:33`, `streamStatus.ts:18`). All
run outside a run ALS, so `currentSession()===defaultSession()===the singletons`.

**Mechanism.** For single-session hosts (extension, CLI) the standalone exports
_are_ `defaultSession()`'s members by identity — zero runtime divergence, deletion/
naming debt only. But `defaultSession()` is load-bearing (both single-session
hosts run through it), so the exports can't fold into its construction until the 16
sites migrate.

**Fix (net-delete).** Migrate the 16 sites to `currentSession().executions` /
`currentSession().status` (behavior-identical; the `currentSession()` seam already
exists), then delete `SharedExecutionRegistry` + `SharedExecutionSubscriptionBinder`
exports and construct them inside `defaultSession()`. File a dated #6981 row
(or calendar-date the D1 sweep #6982 that tracks this dual — either satisfies
R1; the error-ownership census's DUAL-5 row counts it compliant-as-tracked on
that basis).
Marginal value (−2/−3 exports for 16 mechanical edits) under anti-churn discipline.

**Rejected trap.** Do not delete `StreamStatusService` itself or wrap it in a new
accessor/port — it is the deliberate `defaultSession().status` instance
(`SessionHandle.ts:317`); only its _direct host imports_ migrate. Adding any
new port/facade violates R4.

### A11. CLI `childExecutionStatus.ts` hand-rolls an in-flight status set duplicating the trait-derived `isInFlightStatus` (LOW; net −6 LoC, −1 hand-rolled vocabulary)

**Pins.** `childExecutionStatus.ts:7-12` `IN_FLIGHT_STATUSES =
new Set(['initializing','resuming','running','waiting'])`; `:27`
`IN_FLIGHT_STATUSES.has(normalized)`. Byte-equivalent to `isInFlightStatus`
(via `StreamPhaseSchema→isInFlightPhase`, `streamStatus.ts:134-136`, +
`STREAM_STATUS_TRAITS.inFlight`, `stream.ts:47-58`). The canonical predicate is
already imported elsewhere in the same CLI package
(`focusedChildFollowUp.ts:5,33,54`, `StreamTabsStrip.tsx:4,212`).
`stream.ts:22-23` documents the rule: "never declare a new status list by hand —
add a trait column instead."

**Mechanism.** A third hand-maintained status-membership table minted in CLI UI,
duplicating the core trait table; drifts silently from every other host's answer
if a new substate is added.

**Fix (net-delete).** Replace `IN_FLIGHT_STATUSES.has(normalized)` with
`isInFlightStatus(normalized)` and delete the Set. Leave `ERROR_STATUSES`
(`:6`, `:20`) alone — its exit-code regex parses process-exit text, a real concern
outside the status vocabulary.

**Rejected trap.** Do not also route the exit-code detection through a status
predicate; only the 4-word in-flight Set is a clean dedup.

### A12. Dead `removeStream` arm in the CLI TUI emit-wrap `applyToState` (LOW; net −5 LoC; R1 dual-state)

_(Consolidates runtime-ui-boundaries `OC4` and cli-tui `RC3` — one dead arm, two
readers.)_

**R1 dual-state — dead migration leftover (not a live divergent state); no PR.**

**Pins.** `subscribeRuntimeHost.ts:57` `removeStream: RemoveStreamPayload` in
`CliStateRuntimeEventPayloads`; `:471-473` dead `case 'removeStream'` in
`applyToState` (invoked only from `wrapRuntimeHost`'s `emit` wrapper, `:374-393`,
non-presentation host events). No host emits `removeStream`
(`rg "\.emit\(\s*['\"]removeStream"` over src/ + packages/cli = 0). The sole
producer is `src/tools/delegation/childStream.ts:331-338`, which emits a
**session fact** directly through `session.events`, never `host.emit`. The live TUI
applier is the session-fact case at `:417-418`.

**Mechanism.** The migration moved `removeStream` from a host emit to a session
fact but left the old emit-wrap arm; nothing emits it onto the TUI-wrapped host,
so the arm + its type key are unreachable in the TUI and read as a live dual-write
to a future auditor.

**Fix (net-delete).** Delete the `case 'removeStream'` (`:471-473`) and the
`removeStream` key (`:57`); keep the session-fact handler (`:417-418`). Do **not**
touch `cliProgressEvents.ts:64` or `sessionProgressSubscription.ts:65-66` —
`removeStream` is a live host-emit event on the **unwrapped headless** host
(`createCliRuntimeHost.emit` → `runProgress` renderer), which never reaches
`applyToState`.

**Rejected trap.** Deleting `wrapRuntimeHost`/`applyToState` wholesale is wrong —
`setActiveStream` (`subscribeApprovals.ts:580`) and the 3 bypass states
(`streamApprovalQueue.ts:64`) are live host-emit-driven.

### A13. RETRACTED — fabricated `'runFact.'` domain-key prefix claim (#7713)

**Correction (2026-07-10, #7713).** This finding claimed a
`RUN_FACT_DOMAIN_PREFIX = 'runFact.'` constant declared in `runFactEvents.ts:19`
and re-declared in `TexraTranscriptRecorder.ts:40`. Verified independently at
HEAD: `runFactEvents.ts` is 34 lines, exports only `RunFactPayloads`/
`RunFactEventName`/`emitRunFact`, and contains no such constant, no
`to/fromRunFactDomainKey` helpers, and no `'runFact.'` string anywhere — its own
header comment says run facts "ride the run trace as explicit `AgentEvent` arms"
and "producers no longer encode them through the `domain` escape hatch."
`TexraTranscriptRecorder.ts:40` is `function asMessageType(...)`, unrelated to
run facts. Neither side of the claimed duplication exists; there is nothing to
fix. Retracted in full. (This also retracts the `DUAL-8` row it fed in
`2026-07-09-tech-debt-error-ownership.md` Part D — see the correction there.)

### A14. `TaskGroup.index/total` are projected core→UI on every round group but read by nobody — a dead duplicate of the live `roundStage.index/total` fact (LOW; net −6 LoC; R1 dual-state)

**R1 dual-state — dead write-only duplicate representation; no deletion PR.**

**Pins.** `taskGroup.ts:13-14` declares `index/total`; `logSlice.ts:92-93`
(GROUP_START) and `:124-125` (GROUP_END) spread them. Repo-wide grep for any
`TaskGroup .index/.total` **read** = 0. The single live owner is `roundStage`,
derived straight from the `stage.start` trace event
(`ProgressFactApplier.ts:298-306`, reading `event.index/event.total`, not the
persisted GROUP_START copy) and rendered by `progressBadgeFormatter.ts:14-16,32-34`.
Deletion-safe: `TaskGroupSchema` (`z.strictObject`) is re-parsed only at empty
default factories (`streamState.ts:220/229`), never on populated groups.

**Mechanism.** The typed-rounds migration (#7164) fanned `stage.start`'s
index/total into two sinks — the round `TaskGroup` (dead) and `roundStage` (live).
All consumers wired to `roundStage`; the group copy is a write-only dead carry.

**Fix (net-delete).** Delete `TaskGroupSchema.index/total` (`taskGroup.ts:13-14`)
and the 4 `logSlice` spreads; optionally drop them from the recorder's GROUP_START.
Do **not** touch `TraceEmitter` `stage.start` index/total (`:218-220` — feeds
`roundStage`). Net −6 (−8 with recorder).

**Rejected trap.** Wiring a new consumer to `group.index/total` to "make it used"
creates a third live round display competing with the `roundStage` badge.

### A15. `TaskGroupList` still regex-sniffs `/^r\d+$/` round labels after the typed `kind` migration (LOW; net −2 LoC; R1 dual-state)

**R1 dual-state — reachable-but-inert string encoding beside the typed enum; no
deletion PR.** Both the regex disjunct and the typed `kind` were introduced in the
same commit `1cc03dcd8b` (#7164) as a legacy-replay compat shim.

**Pins.** `TaskGroupList.ts:295-298`
`isRunGroup = !this.isToolUse && (group.kind === 'round' || (group.kind ===
undefined && /^r\d+$/.test(group.name)))` — the sole frontend regex round-sniff.
Every live round group carries typed `kind:'round'`
(`runReflectionFlow.ts:271-276`, `ToolUseCycleNode.ts:116-119`;
`TraceEmitter.ts:214-220` stamps it). For HEAD runs the regex disjunct is
unreachable (`kind` always set); replayed legacy traces load already-terminal so
the sound path can't fire regardless.

**Mechanism.** Round identity crosses core→UI in two encodings (typed `kind` +
stringly `r<N>` label still produced by `openStage(\`r${roundIndex}\`)`); the
frontend pattern-matches the string as a fallback, keeping the retired protocol
alive on the render path.

**Fix (net-delete).** Reduce to
`const isRunGroup = !this.isToolUse && group.kind === 'round';`. Behavior-preserving.

**Rejected trap.** Do not "harden"/generalize the regex or add a compensating
typed field — the typed `kind` already exists and is the single owner.

### A16. Plane-2 "single pending registry with replay" target abandoned — `ApprovalRequestHandler` survives as a complementary replay registry (LOW; won't-do closure; R1 dual-state)

**R1 dual-state — two registries per webview-host kind; **justified** complementary
split (settle-fn vs replay-payload); no ledger row (fewer-elements:176-177 notes
no stage bullet/row). Better solution CHANGED to won't-do.**

**Pins.** `git 6e4cef543` (in HEAD) confirms the merge target was attempted then
reverted: `pending()` added to the port and deleted as "never had a production
reader". `ApprovalRequestHandler.ts:16` `pending` Map + `:18` `delivered` Set =
a display-payload replay registry (`show`/`replay`/`resolve`), separate from the
host settle-maps (`extensionHostInteractions.ts:64`, `desktopHostInteractions.ts:70`
`pendingRequests`, which hold the settle callback).

**Mechanism.** Every webview-host approval is tracked in two registries — the
host's `pendingRequests` (settle callback) and `ApprovalRequestHandler` (display
payload for reconnect replay). They are complementary, not redundant, so they
don't misroute; the cost is maintenance (two hand-synced registries per kind) and
a migration item repeatedly re-raised because it was documented-then-abandoned
rather than formally closed.

**Fix.** Do **not** build `PendingInteractionTable`. Formally close the §8
"delete `ApprovalRequestHandler`" item as won't-do (replay is a real concern the
settle-map cannot serve) so it stops being re-raised. No LoC reclaimable.

**Rejected trap (R4).** The shared `PendingInteractionTable` "consumed by all
three hosts" is the trap: CLI cannot consume it (no settle-map shape), and merging
replay+settle across ext/desktop is an extraction across divergent sites that this
repo has repeatedly seen land net-positive.

### A17. Bash approval serialization is process-wide, not per-session — cross-window head-of-line blocking on desktop (LOW; deferred tracking)

**Pins.** `streamApprovalQueue.ts:121` `new PQueue({ concurrency: 1 })` inside
`createStreamApprovalController`; `bashApprovalController` is a module-level
`export const` singleton (`bashApproval.ts:38`), so its PQueue is shared across
all desktop windows in the single Electron main process. `bashApproval.ts:88`
`enqueue` holds the slot until the user answers → a pending bash prompt in window A
blocks window B. Documented as a deliberate behavior change
(`2026-07-03-session-scoped-runtime-architecture.md:266-269`).

**Fix.** When the interactions plane is next touched, move the bash PQueue
ownership onto the session per the doc's per-session-serialization target. Defer
if A2 lands first (it removes tool-edit's use of the queue entirely).

**Rejected trap.** Do not add a new per-session queue registry alongside the
module singletons (dual state); relocate ownership, don't duplicate it.

### A18. Stale comments / doc-drift (net-zero cleanups)

- **`ProgressFactApplier.setStreamStatus._previousStatus`** (`:809-811`): the
  Stage-5 comment claims "this projection no longer consumes it", but the param
  IS consumed at `:828` (`status === RUNNING && _previousStatus !== status`
  drives `isNewRunningTransition`) and Stage 5 has landed (`ProgressEventBus` = 0
  refs). Rename `_previousStatus`→`previousStatus`, replace the false comment with
  its real role. **Do not delete the param** (the comment invites it; `:828` needs
  it). _(Facts-plane `RC4` — Stage-5 precondition fired, but the comment is
  actionable, so it lives here, not in Part C.)_
- **`cliState.ts:30-35`** header still claims it "mirrors the webview's
  progressState shape … a port, not a rewrite". The shapes have forked: CLI = one
  monolithic 22-field `StreamSlice` (`:102-147`) in one `streams` Map; extension =
  6 separate per-stream Maps + `mutative` structural sharing (`store.ts:79-95`,
  `progressState.ts:64-68/339/355`) deliberately for Lit re-render skipping.
  Rewrite the comment to state the divergence is intentional (Ink re-renders the
  tree on any change since `App.tsx` subscribes to the whole map at the root;
  `patchStream` already preserves refs). Comment-only. **Rejected trap:** splitting
  `StreamSlice` into ~10 slices "for parity" is net-add churn with zero benefit
  under Ink's root-subscription model.

---

## Part B — Run/session data-model, flow-engine, agents & storage/FS layering debt

Ranked by leverage, highest-leverage net-deletions first.

### B1. Live per-step KV dual-write of todos + conversation duplicating the transcript sidecars, sustaining an mtime reconciler (HIGH; ~−60 to −80 LoC; R1 dual-state)

**R1 dual-state — code-to-code dual-write, resting; no open deletion PR; pending
#7246 D1 (R2 decision). Two of the ten known duals (completed-run todos dual-owner +
tool-use per-step KV dual-write, fewer-elements:58).**

**Pins.** Todos written to BOTH stores per tool-use round:
`ToolUseCycleNode.ts:95-108` `onTodosUpdate` fires `emitRunFact('updateTodos')`
(→ `StreamSnapshotStore.setTodos:783-787` → `workPlan.json`) AND `persistTodos`
(`runToolUseFlow.ts:183` → `kv.writeTodos` → `ExecutionKVStore.ts:523-525` →
`todos.json`). Conversation written to BOTH per reflection persist step:
`runReflectionFlow.ts:317-319` `pf.setProjection` → `conversation.json`
(`ExecutionKVStore.ts:527-532`), duplicating the streamLogs sidecar that
`completedRunArchive` reconstructs. `completedRunArchive.ts` arbitrates both via
**mtime** (todos `:113-116`, conversation `legacyFirst` `:516-521`). #7500 removed
only the tool-use _projection_, not `persistTodos` nor the reflection write.

**Mechanism.** Two stores flush asynchronously on the same hot path and race on
mtime, so `completedRunArchive` cannot trust either copy and must stat-compare
mtimes with a tie-break-toward-legacy heuristic + empty-result fallback. This is
the code-to-code R1 dual-write, **not** the age-based external-data exception.

**Fix (execute #7246 Decision 1 by deletion).** Ownership is already decided in
code comments + docs (`2026-07-03-session-scoped-runtime-architecture.md`: "Deleted; display
reads the sidecar facade"). Remove `persistTodos` wiring + the reflection
`writeConversation` projection; drop `writeTodos`/`writeConversation`
(iface+impl) and the `todos/conversationModifiedAt` accessors; collapse
`completedRunArchive`'s mtime arbitration to a straight sidecar-else-legacy read.
**Corrected cost:** ~300 LoC of `completedRunArchive` (`:168-457`) is the
streamLogs→conversation _reconstructor_ (needed regardless); only ~40-50 LoC is
the race-driven mtime arbitration → realistic net ≈ −60 to −80 LoC (not −150).

**Rejected trap.** Do not merge the two stores or add an "archive writer"
abstraction (net-add). Do **not** delete the legacy READ arm — pre-sidecar
on-disk runs need it (legitimate R1 external-data exception; keep as a dated
age-based #6981 row). Stop the WRITE, not the store.

### B2. Bag↔RunContext split-brain half-collapsed: 4 per-run fields still dual-declared + dual-read (MED; net-delete via per-field collapse; R1 dual-state)

**R1 dual-state — internal core dual (not host coupling); single write owner
(`agentContextToRunContext`) so no value divergence — maintenance tax only; no
in-flight deletion PR. This is the corpus B6 residual after streamId/executionId/
runtimeHost were collapsed (see C).**

**Correction (2026-07-10, #7713).** This finding originally also listed
`workingDirectory` (claimed at `BaseFlowServices.ts:45`) as a fifth dual-declared
field. Verified independently at origin/main `4363b4089` (2026-07-10): `BaseFlowServices.ts` is 35 lines and its
`AgentCore`/`BaseFlowContextInit` interfaces have no `workingDirectory` field at
all — the claim doesn't match the code. Removed from the list below; the other
four fields did check out at the audit pin `54c3bed25`.

**Resolved (2026-07-10, codex review on #7922).** Since the audit pin, the
RunScope single-carrier train finished the collapse: at origin/main `9694f42aa`
(post-#7838/#7841), `BaseFlowServices.ts` declares none of the four fields and
`ResponseCycleFlow.ts` reads them from `runContext` directly. The remaining
multi-declaration (executeAgent options -> RunContext carrier) is the sanctioned
resolve-once-at-boundary shape, not a bag dual. This finding is now historical;
the R1 dual-state row for it should be counted as closed.

**Pins.** Four fields declared on BOTH the flow-service bag and `RunContextCommon`:
`BaseFlowServices.ts:31,33` (`delegationDepth`/`approvalPromptsUnavailable`, inside
`DelegationPolicy`), `:48` `runtimeUnavailableTools`;
`ToolUseServices.ts:27` `stopAfterCycle`; re-declared at `RunContext.ts:13-17`;
single copy site `AgentLaunchContext.ts:156-170`. Flows read the bag
(`ResponseCycleFlow.ts:216,220`; `runToolUseFlow.ts:164/169/170/185`;
`ToolUseWaitNode.ts:101,108`) while tools read the ALS RunContext
(`subagentExecution.ts:134/172/205/270/206/271`, `bash.ts:145`,
`DiagnosticsTool.ts:120`). `ToolUseWaitNode.ts:58` destructures the launch
RunContext yet reads `stopAfterCycle` from the bag at `:101/108` — same node, two
access paths for the same category.

**Mechanism.** Every new per-run flag must be declared on the bag type AND on
`RunContextCommon` AND added to the copy, and each reader must know whether it is a
flow node (bag) or a tool (ALS RunContext). The corpus B6 do-now was executed only
for streamId/executionId/runtimeHost, so the tree now carries both the collapsed
pattern and the dual pattern side by side.

**Fix (finish the per-field read-collapse — net-delete, 0 new elements).** Point
the ~7 flow read sites at `useLaunchRunContext()` (`ToolUseWaitNode` already holds
it at `:58`; `core/flows` already imports the helper) and delete the fields from
`AgentCore`/`DelegationPolicy`/`ToolUseServices`, re-homing the projection-source
ones on `AgentLaunchContext` (`stopAfterCycle` already lives there at `:85` = a
clean −1). `delegationDepth`'s `?? 0` normalization is idempotent at every reader,
so switching to the raw RunContext value is behavior-preserving.

**Rejected trap.** Do **not** build the target `RunScope` frozen object
(2026-07-03-session-scoped-runtime-architecture.md:416-424) as a new shared construct to
"unify" the two paths — mints an element + an adapter hop. Do **not** introduce
ISP-narrowed node interfaces (#6945) — adds interfaces, the opposite of the
single-owner-deletion cure.

### B3. `TaskState` is a derived-only parallel agent-config shape kept as the progress/snapshot currency after `RunDescriptor`+`run.config` landed (LOW; interim net ~0/−; R1 dual-state)

**R1 dual-state — one of the ten known duals (`setTaskState` compat emissions,
fewer-elements:58); no open deletion PR; full delete gated on the CLI JSON freeze
(R2 decision 3).**

**Pins.** `TaskState.ts:29-74` + `agentConfigToTaskState.ts:12-37` +
`taskStateProgressPayload.ts:4-8` = a parallel shape over `AgentConfig`.
`StreamSnapshotStore.ts:861-876` `setTaskState` unwraps `agentConfig` and
**discards `activeFiles`**; `:889-892` `getTaskState` re-wraps via
`agentConfigToTaskState` — an information-free round-trip. `meta.json` emits
`taskState` only when `runDescriptor===undefined` (`:830-831`); new writes always
carry `runDescriptor` (SSOT, `runDescriptor.ts:6,18-25`, landed #7164), so legacy
`taskState` is read-only fallback (`:1199-1200`). 6 wrap producers
(`ProgressFactApplier.ts:218`, `StreamSnapshotStore.ts:270`,
`sessionProgressSubscription.ts:85`, `historyHandlers.ts:92`,
`toolUseResumeData.ts:23`, `sessionResume.ts:54`); ~15 non-test importers.

**Mechanism.** Three representations of "which agent/model/files this run uses"
coexist (AgentConfig SSOT, RunDescriptor ref, TaskState wrapper). Every
`run.config` fact allocates a TaskState only for the store to unwrap it back to
config. Live half-migration: new source landed, old shape not retired.

**Fix (interim, net ~0/−).** Give `StreamSnapshotStore` a `setRunConfig(config)`
(rename of `setTaskState`, both callers migrate) consuming `run.config`'s
`AgentConfig` directly; delete the write-path `agentConfigToTaskState` wrap at
`ProgressFactApplier:218` and `StreamSnapshotStore:270`. Retire
TaskState/agentConfigToTaskState/SetTaskStatePayload only after the ~15 read
consumers migrate and the frozen CLI vocab is handled — removes only 2 of ~6 wrap
sites now.

**Rejected trap.** Deleting TaskState outright now is wrong — the public CLI NDJSON
output emits the `setTaskState` event with a TaskState payload (frozen host
vocabulary, additive-only) and ~15 read consumers speak TaskState. Only the
internal ext/desktop/snapshot wrap↔unwrap is safely removable at this stage.

### B4. `ResolvedAgent` is a trivial identity wrapper whose two "resolution" fields are byte-identical copies of `AgentEntry.path`/`.name` (LOW; pure net-delete ~−15 LoC)

**Pins.** `agentEntry.ts:27-34` `ResolvedAgent { entry, definitionPath,
resolvedName }` ("Simple, flat, no redundant fields"); `agentRegistry.ts:432-434`
`toResolvedAgent()` returns `{ entry, definitionPath: entry.path, resolvedName:
entry.name }` — both extra fields exact copies. Consumers read only
`entry`/`entry.path`-copy/`entry.name`-copy (`agentLoad.ts:100/105/112`,
`AgentLaunchContext.ts:422`, `yamlCommands.ts:40-41/92/102`).

**Mechanism.** The "Trivial identity factories" anti-pattern CLAUDE.md bans;
contradicts `agentEntry.ts`'s own "derive what you need" rule. Maintenance cost:
two names for one fact, a reader must know `definitionPath===entry.path`.

**Fix (pure net-delete).** Delete `ResolvedAgent` + `toResolvedAgent`; make
`resolveAgent`/`resolveAgentForLaunch`/`getAgentPath` return `AgentEntry |
undefined`; rewrite consumers to `entry.path`/`entry.name`/`entry`. ≈ −15 LoC,
−1 interface, −1 function. The recursive parent-resolution path
(`agentLoad.ts:122`) works unchanged.

**Rejected trap.** Keeping `ResolvedAgent` "for future resolved-only metadata" —
it has carried only path/name copies since inception; add any future field to
`AgentEntry`, not a wrapper.

### B5. Queued-follow-up injection loop (append + try/finally transcript log) duplicated near-byte-for-byte across the core round-prep node and the impl wait node (LOW; ~−15 to −20 LoC; R5-compliant)

**Pins.** `ToolUseRoundPrepNode.ts:79-111` and `ToolUseWaitNode.ts:188-214`
contain near-identical for-loops
(`try { result = await appendFollowUpAsUserMessage(shared.messages, followUp,
this.services); shared.messages = result.messages; } finally { if (!synthetic)
logUserMessage(...); }`); deltas are only the synthetic source and the logger ref.
`followUpMessages.ts:38` `appendFollowUpAsUserMessage` + `:26` `followUpDisplayText`.
`onFollowUpConsumed` fires _before_ the loop in `ToolUseWaitNode` (`:184-186`) and
_after_ in `ToolUseRoundPrepNode` (`:108-110`).

**Mechanism.** Two flow nodes in different packages (core/flows vs
implementations/flows) independently maintain the same follow-up-injection +
transcript-logging invariant; a fix to one (e.g. attachment-kind handling on throw)
silently diverges the drain-during-round path from the resume path.

**Fix (net-delete).** Extract the inner loop into
`appendFollowUpsAsUserMessages(messages, followUps, synthetic, services)` in
`followUpMessages.ts` (2 loop callers — R5-compliant); both `post()` methods call
it. Leave the differing `onFollowUpConsumed` timing at each site. Net ≈ −15 to −20.

**Rejected trap.** Do not merge the two nodes or build a "follow-up injection
framework". Do **not** fold in `ToolUseProcessNode.ts:206` — it injects a single
synthetic `BLANK_TOOL_RESULT_CONTINUATION` with no log loop (a genuinely different,
non-logging pattern; it would not use the plural helper).

### B6. `FlowTransition.FINALIZE` is a dead vocabulary member that logs a spurious "Flow ends" warning on every reflection-flow failure (LOW; net −1 vocab member; log-noise bug-yield)

**Pins.** `FlowTransitions.ts:5` defines `FINALIZE: 'finalize'`; the ONLY producer
is `ResponseCycleNode.ts:174` (returns it only when `execRes.outcome==='failed'`);
ZERO consumers (`grep` for `.on(FlowTransition.FINALIZE)`/`.on('finalize')` = 0).
`node/index.ts:13` `TERMINAL_ACTIONS = new Set(['complete'])` — `'finalize'` is
not terminal; `:92-97` logs `Flow ends: 'finalize' not found in [default]` when an
action has no successor, is non-terminal, and the node has ≥1 successor. On the
failure path `getNextNode('finalize')` hits that branch.

**Mechanism.** Every reflection-flow failure logs a misleading routing-warning
during exactly the failure the operator is debugging. `RoundPersistedFlow.run`
returns a derived `RunOutcome` (FAILED via `shared.lastError`), not the raw
action, so `COMPLETE` (which IS terminal) ends the pass identically — skips
`OutputNode`, finalizes to FAILED — with no warning.

**Fix (net-delete).** In `ResponseCycleNode.ts:174` return `FlowTransition.COMPLETE`
instead of `FINALIZE`, then delete `FINALIZE` from `FlowTransitions.ts`. Net −1
vocabulary member, −1 LoC.

**Rejected trap.** Do not add a `.on(FlowTransition.FINALIZE)` edge or add
`'finalize'` to `TERMINAL_ACTIONS` — both re-legitimize a redundant synonym for
`COMPLETE`.

### B7. `RetryableInvocationNode` reads node retry config twice — the constructor read is dead work, always overwritten before use (LOW; net −1 LoC dead work)

**Pins.** `RetryState.ts:87-90` constructor: `getNodeRetryConfig()` then
`super(config.maxRetries, config.wait)`. `:214-224` `_exec` re-reads the config,
applies `BACKGROUND_MODE_MIN_RETRIES`, sets `this.maxRetries`/`this.wait`, then
`super._exec`. `getNodeRetryConfig` (`:24-32`) does 2 `getConfig` reads. The only
production subclass, `ModelInvocationNode` (`:53`), does not override `_exec`, so it
routes through `RetryableInvocationNode._exec`. The only readers of
`this.maxRetries`/`this.wait` (`node/index.ts:187/193/216`) run inside
`super._exec`, _after_ the override overwrites both.

**Mechanism.** Every construction (once per cycle) reads the config to seed
`maxRetries`/`wait`, but `_exec` unconditionally re-reads and overwrites both
before `Node._exec` consumes them — the constructor read never influences behavior
and is a misleading second owner of the retry-config fact.

**Fix (net-delete).** Call `super(1, 0)` (or bare `super()` — Node defaults are
`maxRetries=1, wait=0`) and remove the constructor's `getNodeRetryConfig()` call,
leaving `_exec` the sole owner.

**Rejected trap.** Do not remove the `_exec` read instead — it is authoritative
(applies `BACKGROUND_MODE_MIN_RETRIES` + re-reads live config after clone). Do not
cache the config on the instance; the point is one owner at exec time.

### B8. `WorkspaceStorageProvider.getStoragePath()` runs migrate + `mkdirSync` + sidecar-write + 3× sha256 as side effects on every call, on the hot path of every StorageFS op (MED; +8 LoC memo, no new element)

**Pins.** `workspaceStorage.ts:184-194` `getStoragePath()`:
`migrateLegacyWorkspaceStorage` + `resolveWorkspaceStoragePath` + `mkdirSync`
(`:191`) + `writeWorkspaceSidecar` (`:192`) — no memoization (class fields:
only `getWorkspacePath`). Per steady-state call: 3 sha256, 2 `existsSync`, 1
`mkdirSync` (a _write_ syscall on read paths). Chain: `storageFS.ts:18-20`
`getBasePath()`→`getStoragePath()`; `relativeFS.ts:19-25` per op; `baseFS.ts:39-43`
`preparePath` on every read/write/stat/readDir/exists. `executionListing.ts:126-159`
`listExecutions` `pMap`s `readMeta`+`readConfig` = 2 `getStoragePath`/execution.
CLI + desktop pay (`cliStateStores.ts:22`, `desktop platform/index.ts:102`);
`vscodeStorage.ts:13-20` returns a cheap `fsPath`, so VS Code is exempt.

**Mechanism.** Listing an N-run history ≈ 2N `getStoragePath` ≈ 6N sha256 + 4N
`existsSync` + 2N `mkdirSync`, just to enumerate. The dominant real cost is the
redundant syscalls (`mkdirSync`/`existsSync`), not the trivially-cheap sha256:
migrate/mkdir/sidecar are init-time concerns mis-owned onto a per-op path getter.

**Fix (single-owner memo).** Memoize inside `WorkspaceStorageProvider`: read
`wp=getWorkspacePath()`; if `wp===this.preparedForWorkspace` return the cached
path; else run migrate+mkdir+sidecar once and cache
`(preparedForWorkspace, preparedPath)`. Same one-shot memo for
`getGlobalStoragePath`. Keying on the current `workspacePath` keeps desktop
workspace-switch correct (all three side effects are idempotent-per-workspace). ≈
+8 LoC, 0 new files/exports/classes — a memo, not an abstraction (there is no
net-delete alternative for "a getter does redundant work per call").

**Rejected trap.** Do not add a new LRU/path-cache element, and do not move the
work into `initPlatform` only — an `initPlatform`-only `mkdir` breaks desktop
workspace switching (path is re-derived from a live `getWorkspacePath`).

### B9. `RESTART_REPAIR_PHASES` duplicated: shared exported set + a byte-identical private copy in `desktopStreamSnapshot` (LOW; net −4 LoC)

**Pins.** `restartRepair.ts:54-57` exports `RESTART_REPAIR_PHASES = new Set([RUNNING,
WAITING])` (used `:192`). `desktopStreamSnapshot.ts:38-41` declares a byte-identical
private copy, used `:231` to gate `lastKnownStatus` (in-flight → keep, else demote
to COMPLETED). A sibling desktop file already imports the shared const
(`desktopAgentExecution.ts:79`).

**Mechanism.** Two definitions of "which phases count as in-flight for restart
repair". If the shared set gains a phase, the desktop classifier at `:231` silently
keeps the old set and demotes a newly-in-flight ghost to COMPLETED on relaunch — a
latent divergence exactly on the resumability decision.

**Fix (net-delete).** Delete the private copy (`desktopStreamSnapshot.ts:38-41`)
and import `RESTART_REPAIR_PHASES` from `@shared/progressView/backend/restartRepair`
(already a desktop-main dependency; no cycle — shared cannot import desktop).

**Rejected trap.** Do not mint a new shared constants file to hold the set (net
+1 file/element) — it is already exported from `restartRepair`.

### B10. Dual run-storage directory names (`executions/` + legacy `taskRuns/`) are both live — every lookup MISS probes both (LOW; ledger row; R1 dual-state)

**R1 dual-state — resting; CLAUDE.md-endorsed accept-legacy-on-read backcompat, but
no forward migration and no dated ledger row.**

**Pins.** `workspaceStorage.ts:20` `LEGACY_RUNS_STORAGE_DIR='taskRuns'`; `:85-89`
`resolveLegacyRunStoragePath`; `:115-124` `resolveExistingRunStoragePath` probes
`executions/` first (`:119-120`) then falls back to `taskRuns/` (`:121-122`) _only
on a primary miss_. `grep 'taskRuns'` confirms NO rename/move exists — the legacy
branch is load-bearing for reads AND deletes (`runDirOps.ts:76-82` `runCleanRunDir`
cleans the legacy location too). 9 call sites across housekeeping/tools/latex/
controllers/cli.

**Mechanism.** Two directory conventions for one concept coexist indefinitely.
Because there is no one-time rename, the legacy branch cannot simply be deleted for
users with pre-rename data — yet it carries no dated ledger row, so the dual
persists silently and every `executions/` miss pays one extra `exists()` on
`taskRuns/`.

**Fix.** Add a dated #6981 row; either commit to keeping the read-fallback
permanently (documented) or ship a one-time `taskRuns→executions` rename during
`migrateIfNeeded`, then delete the fallback on a scheduled date (net −15 LoC later).

**Rejected trap.** Do not delete the `taskRuns` fallback now — with no forward
migration, removal strands pre-rename run data. Rename-then-delete or document as
permanent; don't leave it as an undated dual.

### B11. Undated pre-KV `index.json` + `workspaceState` migration (~95-105 LoC) on the first-call path of `listExecutions`, no ledger row or persisted done-marker (LOW, PLAUSIBLE; ledger row)

**Pins.** `executionListing.ts:116-119` `migrateIfNeeded()` runs on first
`listExecutions()` per workspace/process, guarded only by module-global `migrated`
(`:59`, reset on workspace change). `migrateIndexJson` (`:224-244`) deletes
`INDEX_PATH` after backfill; `migrateWorkspaceState` (`:247-262`);
`backfillEntries` (`:275-320`); `LEGACY_HISTORY_KEY='texra.agentHistory'` (`:32`).
Because `migrated` is process-scoped, every fresh process re-runs it once → one
`readJson(INDEX_PATH)` ENOENT (caught) + one `workspaceState.get` returning `[]`.

**Mechanism.** A one-shot self-deleting migration with no persisted done-marker;
cost is a sub-ms wasted probe per process, and ~95-105 LoC of undated legacy
backfill bolted onto a core listing module with no scheduled removal.

**Fix.** Add a dated #6981 row committing a removal date for the ~95 LoC block,
then delete on that date. **Skip** the persisted global-state done-marker — it
net-adds a state key + guard for a sub-ms gain; the process-scoped flag is fine
until removal.

**Rejected trap.** Do not delete the migration outright now — a user upgrading
across the gap may still hold `index.json`/`workspaceState`. Schedule via ledger.

### B12. `registerExecution` `Promise.all` can leave a half-registered execution on disk (LOW; ordering fix, net-0)

**Pins.** `executionLifecycle.ts:120-135` builds `writes = [writeConfig, writeMeta,
(writeChild)]` then `await Promise.all(writes)` — non-atomic. `executionListing.ts:131-136`
gates on `if (!meta) return null` (config-without-meta invisible); `:143-144`
surfaces a meta-without-config partial as an `agent:'unknown'` row.

**Mechanism.** If one write rejects, the others may already have landed, leaving a
partial dir. Both partials are benign display artifacts, not corruption; not a
session-scoping race.

**Fix (cheaper than corpus C5d).** Sequence the writes so `meta.json` (the listing
read-gate) is written _last_, so any partial has no meta and stays
invisible/cleanable; or add a catch that deletes the partial dir on failure. No
new element.

**Rejected trap.** Do not introduce a generic transactional KV wrapper for this
one 3-write call site — ordering or a local cleanup catch suffices.

### B13. C1c still open, but its corpus-proposed fix net-adds — keep the four capability name-sets centralized (LOW; do-nothing structural)

**Pins.** Four sets: `APPROVAL_GATED_TOOL_NAME_LIST` (20 names,
`approvalGatedTools.ts:7-28`, `satisfies readonly RegisteredToolName[]`);
`SLOW_TOOLS` (5), `DEFERRED_LOG_TOOLS` (3), `STREAMABLE_TOOLS` (1) at
`ToolUseDispatchNode.ts:38/47/50`. The one genuine per-tool axis, `parallelSafe`,
is read at `:274`.

**Mechanism.** Small, centralized, readable in two files; the corpus C1c fix
(capability flags on `ToolDefinition`) scatters ~29 flag declarations across ~56
tool files to save editing 4 co-located sets — the "extract shared abstraction
across divergent call sites nets positive here" anti-pattern.

**Fix.** Do nothing structural. If a fifth set ever appears, only then reconsider.
Optionally move the four sets into one adjacent module for one-file discovery (a
lateral move, not required).

**Rejected trap (R6).** Adding capability flags to `ToolDefinition` net-adds
elements across every tool file to remove a 4-line central edit — banned under
net-element accounting.

### B14. CLI-only fields (`cliOutputFile`, `cliMultiAgentPresetId`) baked into the host-agnostic core `AgentConfig`, carried by every host + persisted + trace (LOW; ownership smell, no code change)

**Pins.** `AgentConfig.ts:37-45` declares both fields on the core
`AgentConfigFieldsSchema`, self-labelled "CLI-only". Actual readers are
exclusively `packages/cli/**` (`history.ts:419/439/497`,
`workflowOutput.ts:324-325`, `chatSessionController.ts:93/103/113`,
`chatDefaults.ts:107`, `orchestrate.ts:198`, `multiAgent.ts:221`,
`workflow.ts:108`). Hand-duplicated into `executeMessage.ts:26-27` and
`traceDataSchema.ts:55-56`.

**Mechanism.** `core/definition` is the host-agnostic agent-config SSOT yet
hard-codes two CLI-runtime concerns; every host, every persisted `config.json`,
the `run.config` trace fact, and the trace-viewer schema carry fields only the CLI
consumes, and they drift (copied by hand into two other schemas).

**Fix (guardrail, not a refactor).** Leave the single schema but stop the smell
spreading: do not add further host-specific fields to core `AgentConfig`; if it
grows, carry CLI extras in a cli-owned extension type merged only at the CLI
boundary.

**Rejected trap (R6).** Immediately splitting into a CLI-only config schema
threaded through launch net-adds a schema + a parse hop for two optional strings.

### B15. Effective-rounds rule `max(configuredRounds, userRequestCount)` duplicated in the registry scanner (display) and the reflection flow (run), no shared owner (LOW, PLAUSIBLE; likely not worth)

**Pins.** `agentYamlScanner.ts:224` `rounds = Math.max(parsedRounds,
userRequestTemplateCount(rawPrompts))`; `runReflectionFlow.ts:152` `totalRounds =
Math.max(setting.rounds ?? 2, requestCount)`. They agree by the same default
constant (`AgentDataclass.ts:40` `prefault(2)`). `AgentEntry.rounds` is `undefined`
for inheriting agents and cleared on tool-use override (`agentRegistry.ts:185`).

**Mechanism.** Two layers compute the same fact with the same formula, different
inputs, no owner; agree today by identical constants; a change to the default or
the max rule in one site silently desyncs the displayed total from the executed
total.

**Fix.** Likely **not worth doing**: the proposed extraction net-adds a trivial
`Math.max` helper (+function +2 imports) and does _not_ close the drift it names
(the default-2 constant still lives in both the schema prefault and the flow's
`?? 2`). If pursued, an `effectiveRoundCount(...)` owner must also own the default
constant; at minimum do not extract a bare `Math.max`.

**Rejected trap.** Making the run read `AgentEntry.rounds` for one value is wrong —
it is `undefined`/cleared for inheriting and tool-use-override agents; the flow
must compute from the loaded setting.

### B16. Agent YAML parse/validation failures silently drop the agent from the registry with no UI signal; `AgentDefinition` has no `schemaVersion` (LOW, PLAUSIBLE; net-adds — advisory)

**Pins.** `agentYamlScanner.ts:108-124` `readYamlDefinition` catch → `logger.warn`
→ `return null` → filtered; same catch-and-drop at `:241-247` and `:45-76`.
`AgentDirectoryIssueReporter.report` fires only for directory-config problems
(`AgentDirectoryService.ts:152,166`), never a malformed agent file.
`AgentDefinitionSchema` (`AgentDataclass.ts:160-166`) has no `schemaVersion`
(contrast the machine-persisted `RunDescriptor`, `runDescriptor.ts:6,19`).

**Mechanism.** A user's custom agent with invalid YAML never appears in the
dropdown — the only trace is a log line, so "my agent vanished" is undiagnosable
from the UI. No `schemaVersion` means a future breaking schema change manifests as
the same silent drop rather than a targeted migration.

**Fix (advisory; honestly net-adds).** For `source==='custom'` only, surface failed
loads through a runtime notification (needs new wiring — `agentYamlScanner` is a
VS-Code-free zone with no `runtimeHost` handle, and the existing reporter is
directory-scoped). Prefer the repo's `z.union`+`.transform` backward-compat idiom
over a `schemaVersion` literal for the human-authored `AgentDefinition` (the
`schemaVersion` sub-claim is apples-to-oranges: a human-authored YAML is not a
machine artifact).

**Rejected trap.** Throwing on a bad YAML to make it loud is wrong — one malformed
file must not abort the scan; the `pMap`+filter-null design is correct. Only add a
targeted diagnostic for custom files.

---

## R1 dual-state accounting

Per fewer-elements R1, no dual-system may rest without an open delete PR or a dated
#6981 row. This audit's live duals:

| #   | Finding                                         | Kind                        | Open delete PR                   | #6981 row        | Note                                                       |
| --- | ----------------------------------------------- | --------------------------- | -------------------------------- | ---------------- | ---------------------------------------------------------- |
| A2  | tool-edit approval fallback                     | triple-wired routes         | none                             | none             | target design prescribes deletion; stage 2-then-3          |
| A3  | CLI synthetic-entry machinery                   | old+new for one message     | issue #7086 → in-flight PR #7601 | none             | gated on recorder stable-id upsert                         |
| A5  | `AgentRuntimeHost.interactions`                 | dual access path (identity) | none                             | none             | cannot diverge in prod                                     |
| A6  | 6 phantom emit arms                             | types-only zombie           | none                             | none             | relocate to CLI-local map                                  |
| A10 | `Shared*` singletons / `defaultSession()` alias | identity alias              | none                             | none             | **one of the ten known duals**                             |
| A12 | dead CLI `removeStream` arm                     | dead migration leftover     | none                             | none             | not truly divergent                                        |
| A14 | `TaskGroup.index/total`                         | dead write-only duplicate   | none                             | none             |                                                            |
| A15 | `TaskGroupList` `/^r\d+$/`                      | string-vs-typed encoding    | none                             | none             | inert on HEAD runs                                         |
| A16 | `ApprovalRequestHandler` replay                 | complementary registries    | none                             | none             | **won't-do closure** (justified split)                     |
| B1  | KV dual-write todos+conversation                | code-to-code dual-write     | none                             | pending #7246 D1 | **two of the ten known duals**                             |
| B2  | bag↔RunContext 4 fields                         | internal core dual          | none                             | none             | corpus B6 residual; single write owner                     |
| B3  | `TaskState` parallel shape                      | derived-only shape          | none                             | none             | **one of the ten known duals**; delete gated on CLI freeze |
| B10 | `executions/` + `taskRuns/`                     | dual dir names              | none                             | none             | external-data-adjacent; needs dated row                    |

**Mapping to the ten known duals (fewer-elements:58-60).** Given full treatment
here: `setTaskState` compat (B3), completed-run todos dual-owner + tool-use
per-step KV dual-write (B1), `defaultSession()` aliasing (A10). **Still-open,
unchanged corpus duals** (scheduled by Sweeps 1-3, not re-explained): dual status
vocabulary `STREAM_STATUS`↔`StreamPhase` (Sweep 2 / D1 #6982); session-fact→
progress-event projection (Sweep 1 / #6968); tier-3 read shims (Sweep 2, dated
retention window unset — R2 decision 2); frozen CLI JSON fields (R2 decision 3,
one-minor deprecation); v1/v2 flow-record replay (age-based, external-data
exception); TUI usage-echo guard (Sweep-1-adjacent).

---

## Corpus items reconfirmed RESOLVED (do not re-raise)

Confirmed at HEAD `54c3bed25`; each proposes no code — only tracker/doc closure.

- **Coupling-audit #6887 / #6889 / #6890** — all closed by the session migration.
  #6887 desktop restart-repair fires via `desktopAgentExecution.ts:777/861/964`
  (shared owner `restartRepair.ts:142`, also used by the extension); #6889 the bus
  is gone (`src/eventBus/`=`AppSignals.ts` only; zero `ProgressEventBus`/`bus.emit`
  non-test hits; `StreamSnapshotStore.ts:261` subscribes `session.events`); #6890
  `setToolEditApprovalHandler` gone (`RunContext.ts:27` field +
  `toolEditApproval.ts:245-246` `context?... ?? platform()`). **Actionable:** update
  `2026-07-03-agent-runtime-ui-coupling-audit.md:3/21` ("Partially landed / 4 of 5 open" is
  stale) and close the trackers. _(surviving OC1)_
- **B5 design-table trio** — `InterruptRegistry` deleted (#7593 / `902daeb65`, 0
  refs); `deriveResumability` is the single owner (`resumability.ts:92`); the
  `sendFollowUp` decision-then-act window is closed (`ToolUseFollowUp.ts:195-205`
  synchronous, no yield). _(runtime-core RC3)_
- **fewer-elements §5/§8 coordinator multiplication** — folded into
  `session.interactions` (#7504 / `18098a7ff`); no `runCoordinators`/
  `RunCoordinatorBridge`/`*Coordinator` in `src/agent/runtime`;
  `HostInteractions.ts:196-271` is a thin forwarder. _(interactions-plane RC1)_
- **A2 "command→handler mapping authored twice"** — closed by the shared
  `*CommandActions` contracts (`SettingsViewCommandHandlers.ts:24/252`,
  `ProgressViewHost.ts:73`; both hosts fill one contract). The per-host action
  _bodies_ are the deliberate transport seam. _(host-wiring HW4)_
- **Resumability 5-way host disagreement** — one storage-owned
  `deriveResumability` (`resumability.ts:92`); every consumer routes through it.
  _(transcript-persistence RC2)_
- **Per-host crash-repair duplication + self-inconsistency** — one owner
  (`restartRepair.ts:142` `repairRestartedStreams`; `:102-132` writes terminal
  status; comment `:134-141` owns the three consistent writes). _(transcript-persistence RC3)_
- **Tab-delete orphaning + no retention/GC** — `SessionStores.ts:44` `deleteStream`
  reaps streamLogs+snapshot+execution dir; startup GC wired
  (`ProgressViewState.ts:365` `sweepOrphanedStreams`). _(transcript-persistence RC4)_
- **C1a ToolResult status contract** — source-declared discriminated union
  (`toolResult.ts:177-181`); `NormalizedToolResultSchema` + `ToolResultPayloadSchema`
  deleted (0 hits). _(tools-runtime-contract RC1)_
- **C1b two child-run drivers** — unified into `startChildRunLoop`
  (`childRunLoop.ts:454`) + 4 strategies + shared `deliveryEnvelope`;
  `agentCliSessionLoop.ts` deleted (#7523/`e907e6b01`). _(tools-runtime-contract RC2)_
- **Corpus B6 streamId/executionId/runtimeHost dual-read** — resolved to one read
  path (`AgentRunIdentity` on `AgentLaunchContext.ts:78` only; 0 bag reads; all via
  `useLaunchRunContext()`). The live residual is B2's _different_ field set.
  _(flows-di RC2)_
- **Corpus B6 "shared keys far exceed typed fields" (184/41/10)** — no longer
  holds; 84 accesses / 18 keys, all typed (`ToolUseRunShared` 8 fields +
  Zod-schematized `ToolUseRoundShared`); one runtime narrow via
  `assertPreparedShared`. _(flows-di RC3)_
- **C5a fire-and-forget `sendFollowUp`** — both chains now `.catch`
  (`ExecutionSubscriptionBinder.ts:153-175`, `StreamSubscriptionRegistry.ts:114-136`).
  _(async-races AR2)_
- **C5b desktop transcript-flush at quit** — awaited
  (`desktopAgentExecution.ts:709-711` `state.flush()`; before-quit
  `index.ts:906-915`; per-window `StreamLogStore` = `session.transcripts`).
  _(async-races AR3)_
- **C5c goalStore index mutation** — serialized under `indexMutex.runExclusive`
  (`goalStore.ts:20/93-105`; concurrent `start` touches independent keys).
  _(async-races AR4)_

---

## Healthy — do not churn

Verified sound in passing; fixes here would be net-negative churn.

- **Emit rail is single-owner.** `emitRuntimeEvent.ts:28` routes only to
  `session.events`; no process-bus fallback; zero `bus.emit`/`ProgressEventBus`
  under `src/agent/runtime`. Host/RPC events go through `AgentRuntimeHost.emit`
  directly, by design.
- **`ToolResult`, child-run driver, resumability, crash-repair, coordinator
  fold** — all consolidated (see Part C); do not re-open.
- **`ExecutionRegistry` tracking/waiter/stop clusters** are one cohesive object
  (`streamStatus.set` re-enters synchronously via `onDidChange`); a full split
  adds abstraction without isolating anything (corpus B5).
- **`StreamApprovalController` pending registry is genuinely live for tool-edit**
  (`nativeToolEditApproval.ts:217`, `desktopToolEditApproval.ts:103`) — only the
  bash half is dead (A7). Do not split the type.
- **`ApprovalRequestHandler` surface is fully live** (`replay`/`pendingSize`/
  `hasPendingForStream`/`releaseForStream`); the settle-map vs replay-registry
  split is justified (A16).
- **`roundStage` is the single owner of round position** (`ProgressFactApplier.ts:298-306`
  reads the trace event directly); the `TaskGroup`/`r<N>` copies (A14/A15) are the
  dead siblings, not `roundStage`.
- **`agentConfigToTaskState`, the legacy `completedRunArchive` READ arm, the
  `taskRuns` read-fallback, and the pre-KV migration** are legitimate
  external-data/backcompat readers — keep the reader, stop the writer / schedule a
  dated row (B1/B10/B11).
- **`ExecutionKVStore` execution-checkpoint store** (used by `texra resume`/
  `history`) is unaffected by the display-sidecar debts.
- **`shared→tools` layering is clean** — `src/shared` has no `@tools` import;
  preserve it (A9 enriches at the goalStore source rather than importing
  `@tools/goal` into `shared`).
- **CLI monolithic `StreamSlice` is correct under Ink's root-subscription model**
  (`App.tsx` subscribes to the whole map; `patchStream` preserves refs) — the
  extension's 6-map fragmentation is a Lit-only optimization (A18); do not port
  either way.

---

## Suggested priority

1. **A1 desktop `removeStream` leak** — highest bug-yield net-delete; a live
   resource leak on a shipping host, the exact per-host mis-ownership class the
   maintainer flagged, fixed by making the shared applier the single owner (−7 LoC,
   no new port).
2. **A2 tool-edit approval fallback deletion** — largest net-deletion in the audit
   (~−300 to −450 LoC, −1 port, −1 context field); dead in production, target
   design already prescribes it; stage 2-then-3 so the noop-host test migrates first.
3. **B1 KV dual-write (execute #7246 D1 by deletion)** — retires a code-to-code R1
   dual-write + its mtime reconciler (~−60 to −80 LoC); make the R2 decision, then
   delete the writes (keep the legacy read arm as a dated row).
4. **A4 resume-guard ownership** — correctness fix restoring a dead desktop safety
   guard; net-neutral (thread the session through `ResumeStreamPorts`).
5. **A5 / A6 / A7 interactions-plane deletions** — `AgentRuntimeHost.interactions`
   dual owner, 6 phantom emit arms, dead `bashApprovalController` sweeps; each
   net-delete or net-neutral, all shrinking the core→host contract.
6. **B2 finish the bag↔RunContext per-field collapse** — the maintainer's explicit
   split-brain concern; do the zero-risk subset (`stopAfterCycle`, already homed on
   `AgentLaunchContext`) first; **not** via a new `RunScope` construct.
7. **A3 synthetic-entry deletion** — lands with issue #7086's fix (in-flight PR #7601, recorder stable-id); −120
   LoC of the most fragile CLI state code.
8. **B4 `ResolvedAgent`, B5 follow-up loop, B6 `FINALIZE`, B7 retry double-read,
   A9 goalStateChanged, A11–A15 constant/vocabulary/dead-arm cleanups** — small,
   high-safety net-deletions; batch as as-touched sweeps (R3), each with R6
   net-element accounting.
9. **B8 `getStoragePath` memo, B12 `registerExecution` write ordering** — cheap
   correctness/perf fixes on the CLI/desktop storage hot path (memo is +8 LoC with
   no new element; ordering is net-0).
10. **Ledger hygiene (R1/R3):** file dated #6981 rows for B10 (`taskRuns`), B11
    (pre-KV migration), A10 (`defaultSession` alias); make R2 decisions 2 (tier-3
    retention window) and 3 (CLI JSON freeze), which unblock B3 and the corpus
    Sweeps.
11. **Doc closures (no code):** mark #6887/#6889/#6890 resolved in the coupling
    audit; formally close the `ApprovalRequestHandler` merge (A16) and C1c (B13) as
    won't-do; record B14/B15/B16 as ownership guardrails, not refactors.

**Cross-cutting priority — Parts C/D/E (error handling, dual-systems, design), in the companion docs:**

12. **EP-2 OpenRouter uncapped retry** (Part C) — real user-visible hang: a transient 5XX backs off up to ~1h inside one "attempt"; +1–3 LoC `retryConfig:{strategy:'none'}` and let the flow own 5XX. Highest error-side bug-yield.
13. **EP-1 `maxAttempts` inert for Anthropic/OpenAI/OpenAIResponse** (Part C) — `texra.model.retry.maxAttempts:0` is silently ignored (the SDK default of 2 owns it); correct the setting description + align the `RetryState` fallback default. Net-neutral, removes a false promise.
14. **UICPL-02 headless failure-as-crash + UICPL-03/01 duplicate error rows** (Part C) — a routine provider failure prints as a "please report this bug" CLI crash and renders 2–3 transcript rows per failure; consume the classified terminal error at the CLI boundary and demote one emitter. Net-delete.
15. **Firm dual-state R1 violations** (Part D): DUAL-2 (`setTaskState` projection), DUAL-4 (`conversation.json` write-only dual), DUAL-6 (on-disk status shims — needs the R2(2) dated window), DUAL-9 (`ApprovalRequestHandler` residual), DUAL-10 (`RESTART_REPAIR_PHASES` dup, −4 LoC do-now). DUAL-10 is a trivial do-now; the rest each need a dated #6981 row or an open delete PR to stop resting.
16. **APoSD net-deletes** (Part E): PT-2 (delete `SessionHandle.useHostInteractions` pass-through, retarget 13 callers), DI-1 dead `attachedMemoryMisses` bag field — overlaps B2; single-digit-LoC deepenings that narrow an interface toward what the code does. (L1/L2 retracted, #7713 — their premises didn't match the code.)
17. **EP-3 `requestShowInstruction` single-consumer leak** (Part C) — CLI/desktop silently drop actionable instructions (missing-API-key, missing-outputs) and `@shared` hardcodes "extension settings"; add the missing per-host consumer on the existing `runtimeHost.emit` path, de-hardcode the string.
18. **TC-2 CLI bundle `keepNames`** (Part C) — +1 build-config line; the published CLI mis-classifies untagged errors after minification. Trivial.

**Already in flight — do NOT open competing PRs:** #7601 covers A3 (finalized-message stable id → synthetic-entry deletion); #7603 (`claude/issue-6945-step1-widen-cycle-services`) is in the B2 / DI-1 service-bag vicinity (#6945). Coordinate with those rather than duplicate.
