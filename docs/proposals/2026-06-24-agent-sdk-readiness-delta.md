# Agent SDK Readiness — Delta Audit (2026-06-24)

**Status:** Audit addendum. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](./2026-05-30-agent-sdk-readiness.md) (last refreshed 2026-06-20)
and its ledger [`../dev/audits/2026-05-29-agent-sdk-readiness-audit.md`](../dev/audits/2026-05-29-agent-sdk-readiness-audit.md)
(§1–§21). This pass does **not** restate those; it records only what is _new_
since the sixteenth ledger pass, and re-confirms the standing verdict.

**Scope re-audited:** `src/agent/core/` + `implementations/flows/`,
`src/agent/modelHandlers/`, `src/logger/` + `src/agent/trace/` + `src/eventBus/`,
`src/platform/`, and the agent/team/subagent surface
(`packages/extension/resources/{agents,tool_use_agents}/`, `src/tools/delegation/DelegationTools.ts`).

**Method:** four independent fan-out audits (core flows, model handlers,
logger/platform, subagent boundaries), each run _without_ sight of the existing
ledger, then reconciled against it. As the ledger itself predicts (§"Re-rebutted
false positives", line 1627), an uninformed pass re-surfaces already-adjudicated
candidates; those are filtered out below and listed under "Already adjudicated"
so they are not re-litigated.

---

## Update (2026-06-24, second pass) — deeper verification + refactor applied

Each finding was re-traced to ground truth before any edit. Two of the first
pass's claims changed materially:

- **P1 is _latent_, not an active bug.** The only `onRoundFinalized`
  implementation is `createUsageRecordingCallback` → `UsageMonitor.recordUsage`,
  whose entire body is already wrapped in `try/catch` (`UsageMonitor.ts:111-197`,
  no rethrow). So the callback cannot throw today, and the double-`recordRound`
  window is currently unreachable — it is defended _by luck_ (an external
  callee's exception-safety), not by structure. The first pass's "drop the
  catch-side `recordRound`" fix was also **wrong**: the catch is load-bearing for
  the _other_ path — a pre-finalize `BaseNode` (`ResponsePrepNode`/`ProcessNode`/
  `ContinuationNode`) throwing before the finalize node runs (verified: `Flow._orchestrate`
  → `BaseNode._run` has no try/catch, so those throws propagate straight to the
  catch, which is the only finalization for that round).
- **P2a (MiniMax dedup) is a TRAP — rejected.** The shared
  `extractTextFromReasoningDetails` is **not** a superset: its `getReasoningItemText`
  only reads text when `type === 'reasoning.text'`/`'reasoning.summary'`
  (OpenRouter's tags), while MiniMax's `reasoning_details` items carry
  `type: 'thinking'` and the local helper reads `.text` **unconditionally**
  (`modelHandlerMiniMax.ts:15-22,105`). Swapping in the shared function would
  silently return empty reasoning for MiniMax. Leave the local helper.

**Applied this pass** (typecheck ×4 ✓, eslint ✓, 52 targeted tests ✓ —
`FakePlatform`, `desktopWorkspacePath`, `ResponseCycleTools`, `ReflectionOutputLocation`):

1. **P1 — structural hardening.** `ResponseCycleFinalizeNode.exec` now wraps
   `onRoundFinalized?.(run)` in `try/catch` (warn-logs on failure), making it the
   single finalization point that cannot throw _after_ `recordRound` has mutated
   run state. Behavior-identical today; closes the double-count footgun for any
   future throwing callback. The outer `ResponseCycleNode` catch is unchanged
   (still the safety net for genuine pre-finalize node throws).
   (`ResponseCycleFlow.ts`)
2. **P2b — dead-code removal.** Deleted the `WorkspaceProvider.watch` port method
   (never called anywhere in repo history — `git log -S` over `workspace.watch(`
   returns only the doc commit). Removed it from the interface, both host impls
   (`vscodeWorkspace`, `nodeWorkspace`), and the test fake — including ~130 LOC of
   now-unreachable recursive-watcher machinery in `nodeWorkspace.ts`.

**Deferred (intentionally not applied):**

- **P3b (`withModelClient` DRY):** the duplicated closure exposes `client` via a
  **getter** with live rebinding for the relay-401 token-refresh path. Extracting
  it to a helper and spreading the result would evaluate the getter eagerly and
  **break liveness** (silent auth-refresh regression). Not worth the risk for a
  ~15-line DRY; leave the two copies.
- **P3a (empty-`FlowParams` aliases) / cross-provider message-builder
  unification:** real but low-value/large-churn; tracked, not landed.

---

## TL;DR — verdict unchanged, one latent bug worth eyes

**The codebase remains well-aligned and is _not_ drowning in abstraction.** The
PocketFlow spine (`Node.exec → createFlow().run`), the `AgentTrace` emit/subscribe
channel, the `platform()` composition root, the `createModelHandler` factory, the
tool-conversion layer, and the lead-and-specialists delegation model are all
already SDK-idiomatic. This confirms the existing audit rather than overturning it.

The four audits surfaced **six genuinely new items** (none present in the
ledger). One is a **latent double-count bug**, the rest are trivial-to-small
cleanups. They are ranked below.

---

## New delta findings (not in the existing ledger)

### P1 — Latent double `recordRound` on the reflection error path _(bug candidate)_

- **Files:** `src/agent/implementations/flows/reflection/nodes/ResponseCycleNode.ts:131-132`
  (catch block) vs. `src/agent/core/flows/ResponseCycleFlow.ts:445-449`
  (`ResponseCycleFinalizeNode.exec`).
- **What:** The inner response-cycle flow routes _every normal exit_ through
  `ResponseCycleFinalizeNode`, which calls `recordRound(run, round)` then
  `await onRoundFinalized?.(run)` — the documented "single finalization point, no
  guard flags needed." The outer `ResponseCycleNode.exec` `catch` block (reached
  only if `flow.run()` **throws**) _also_ calls `recordRound(prepRes.run, prepRes.round)`
  - `await this.services.onRoundFinalized(prepRes.run)`.
- **Why it matters:** In the common case these are mutually exclusive (either the
  flow finalizes normally, or it throws before reaching the finalize node), so no
  double count occurs. **But there is one reachable double-record path:** if
  `recordRound` (line 447) succeeds inside the finalize node and then
  `onRoundFinalized?.()` (line 448) _throws_, the flow propagates, the outer catch
  fires, and `recordRound` runs a **second** time for the same round — double-counting
  into the usage accumulator. The ledger knows `recordRound` has exactly these two
  callers (audit §line 2222-2223) but only classified it as a "trivial forwarding
  wrapper" — it never analyzed the dual-call ordering. `ToolUseCycleNode` has **no**
  symmetric catch-side metrics call, confirming the asymmetry is unintended.
- **Recommended fix — ⚠️ SUPERSEDED by the second-pass Update above.** The
  original recommendation here was to _delete_ the catch-side `recordRound` +
  `onRoundFinalized`. The "verify first" check it called for was carried out and
  **invalidated that approach**: a pre-finalize `BaseNode` (`ResponsePrepNode`/
  `ProcessNode`/`ContinuationNode`) _can_ throw before the finalize node runs, so
  the catch is the only finalization for that round and must stay. The fix that
  actually landed instead guards `onRoundFinalized` inside
  `ResponseCycleFinalizeNode` so it cannot throw after `recordRound` — see
  "Update (2026-06-24, second pass)" at the top of this document. This original
  text is retained only as an audit trail of the corrected reasoning.

### P2 — Duplicate `extractTextFromReasoningDetails` in the MiniMax handler

- **Files:** `src/agent/modelHandlers/openai/modelHandlerMiniMax.ts:15-24` duplicates
  the shared `src/agent/modelHandlers/utils/openRouterReasoning.ts:15`
  `extractTextFromReasoningDetails`.
- **What:** Both walk an array of `{ text }` reasoning items and join. The shared
  version is a strict superset (handles `reasoning.summary` and string input too);
  the MiniMax copy is the narrower one.
- **Fix:** import the shared util in MiniMax and delete the local copy. **Caveat
  (verify):** confirm the shared util's `ReasoningDetailUnion` input type accepts
  MiniMax's looser `{ text }` shape, or add an `unknown`-input overload rather than
  coupling MiniMax to the `@openrouter/sdk` type. Trivial, isolated, no behavior change.

### P2 — Dead platform port method `WorkspaceProvider.watch`

- **Files:** `src/platform/interfaces/workspace.ts:20` (declaration) +
  `src/platform/defaults/nodeWorkspace.ts`,
  `packages/extension/src/frontend/vscode/vscodeWorkspace.ts` (impls) + 3 test fakes.
- **What:** `platform().workspace.watch(...)` has **zero** production callers (grep
  for `.workspace.watch(` is empty); every real file-watch site calls
  `vscode.workspace.createFileSystemWatcher` directly (e.g.
  `AgentDirectoryManager.ts:285`). Contrast `ConfigProvider.watch`, which _is_
  consumed via `configUtils.watchConfig`.
- **Why:** dead surface area on a host-capability port — every host must satisfy a
  contract no agnostic consumer uses. This narrows the SDK-exported port surface.
- **Fix:** drop `watch` from the interface, the two host impls, and the test fakes
  (~6 sites). Re-add with a real caller if a future agnostic consumer needs it.

### P3 — Empty-type re-export aliases `ToolUseFlowParams` / `ReflectionFlowParams`

- **Files:** `src/agent/implementations/flows/tooluse/ToolUseServices.ts:52` and
  `.../reflection/ReflectionServices.ts:38` each `export type` an alias of
  `FlowParams` (`= Record<string, unknown>`, `BaseFlowServices.ts:80`).
- **What:** Both name an _empty_ param bag per flow; the param slot is never read by
  any node (the graphs thread `CycleParams`). They are imported across ~10 node
  files but carry no distinct type information — exactly the anti-shim shape the
  repo flags.
- **Fix (optional, cosmetic):** type the nodes' param slot directly as `FlowParams`
  and delete the two aliases. Low value; bundle only if touching these files anyway.

### P3 — DRY the model-client closure shared by the two cycle wrapper nodes

- **Files:** `ResponseCycleNode.ts:100-116` and
  `.../tooluse/nodes/ToolUseCycleNode.ts:79-92`.
- **What:** Both wrapper nodes perform the identical service-bridging dance before
  `flow.run()`: `let client = await modelHandler.getClient()`, then
  `flow.setServices({ ...this.services, get client(){…}, async refreshClient(){…}, run, workspace })`.
  The `client` / `refreshClient` getter pair is byte-identical.
- **Important distinction from the ledger:** the ledger (line 1633) already rejected
  _"inline the wrapper nodes"_ — that rebuttal stands and is **not** what this is.
  This is a narrower DRY: extract a `withModelClient(services, modelHandler)` helper
  returning the `{ client, refreshClient }` slice (the `ModelClientServices` contract,
  `CycleServices.ts:25`), so the live-rebinding closure has one home instead of two
  copies. Keeps the mandated `Node.exec → createFlow → flow.run` shape intact.
- **Fix:** extract the helper; each node spreads it into `setServices`. ~15 lines of
  duplicated closure removed per site, no behavior change.

### Larger / tracked — cross-provider user-message & media block construction

- **Files:** compare `anthropic/modelHandlerAnthropic.ts:720-820,863-942`,
  `openrouter/modelHandlerOpenRouterNative.ts:334-440,473-510`, and the OpenAI base
  equivalents.
- **What:** `initializeMessages` / `createRoundMessages` / `createUserFollowUpMessages`
  and `createMediaContent` are structurally parallel across all four providers —
  same `[prefix?, media?, request?]` assembly, same media-capability gating, same
  "append-to-last-user-or-push-new" logic — differing only in the emitted block
  shape. ~150–250 LOC of removable skeleton.
- **Fix (medium effort):** a shared `buildUserMessageContent` / media-iteration
  scaffold parameterized by a small per-provider block adapter (the pattern already
  proven by `support/openAiCompatiblePrefill.ts`). This is the **largest remaining
  unification** in the handler layer and complements — does not conflict with — the
  ledger's §3.3 shared-stream-finalize item (`finalizeOpenAIResponse`). Both are the
  "thin per-provider adapter over shared scaffold" direction. Track as a design item,
  not a quick win; the provider abstraction itself is justified (four real SDK shapes)
  and must survive.

---

## Already adjudicated — re-confirmed, do NOT re-litigate

The uninformed passes re-surfaced these; the ledger's rulings hold at HEAD:

| Re-surfaced candidate                                                                                | Ruling (source)                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Remove `IModelHandler` as a duplicate of `ModelHandler`"                                            | **Trap.** Optional `createBatchedToolUseFollowUpMessages` makes it load-bearing; removal breaks `tsc`. (proposal "Rejected findings"; ledger §re the non-optional constructive angle, line 2226) |
| "Inline the `ResponseCycleNode`/`ToolUseCycleNode` flow-wrappers / the `createXCycleFlow` factories" | **Keep.** This _is_ the mandated `Node.exec → createFlow → flow.run` shape. (ledger line 1633)                                                                                                   |
| "Merge `CycleServices` into `BaseFlowServices`"                                                      | **Keep.** Thin ≠ redundant; carries flow-specific fields. (ledger line 1640)                                                                                                                     |
| "Split `modelHandlerOpenAIResponse.ts` (god-file) into collaborators"                                | **Real smell, not a quick win** — shared mutable state + background polling + test subclassing. Tracked design migration. (proposal "Rejected findings")                                         |
| "Merge `ModelHandlerOpenRouterNative` into the OpenAI base"                                          | **Trap.** Two real SDK type families; the merge was deliberately deleted in PR #2962. (proposal "Rejected findings")                                                                             |
| "`AgentState.recordRound` is a trivial forwarding wrapper"                                           | Noted trivial; **but see P1 above** — the dual-call _ordering_ was never analyzed. (ledger line 2222)                                                                                            |
| UsageMonitor `updateStreamUsage` + `logger.usage` "double emit"                                      | **Documented dual-sink** (sidebar vs. transcript stats), agentCategory-gated, intentional. (ledger §4; `UsageMonitor.ts:162-165`)                                                                |
| `@logger` not routed through `platform()`                                                            | **Intentional, documented** exception — logging is its own host-injected subsystem. (`platform.ts:23-28`)                                                                                        |

---

## Subagent split points — confirms the proposal, plus one internal angle

The existing proposal's subagent table (lead/specialists = SDK main+subagents;
`delegate_agent`/`delegate_workflow` = the delegation primitive;
`executeSubagent` = isolated-context `query()`) is re-confirmed: TeXRA's YAML
agent profiles are near-isomorphic to the SDK `AgentDefinition`
(`{ name, description, settings.tools, prompts.systemPrompt }`), teams
(`AGENT_MODE_PRESETS`) are the "available subagents" roster, and read-only-by-tool
reviewers (`changeReviewer` ships with **no bash**) already model SDK tool-scoping.

**One angle worth adding:** the cleanest _new_ extractions are the **internal
multi-phase workflow agents** — `devise` (draft→revise), `verifyFix`
(expand→critique→fix), `elevate`/`humanize`/`enhance` (annotate→apply) — which
fuse _generate / critique / apply / verify_ into one conversation across reflection
rounds. The `criticize`→`apply` agent _pair_ already proves the split works across
agent boundaries; the multi-round single-agent versions are the monoliths. A
dedicated **Verifier** subagent (tools: `wolfram`, `bash`, read-only file ops —
which the prose-only workflow rounds lack today) inserted between draft and
acceptance is the lowest-risk extraction, and largely already exists as the
`review` tool-use agent. Effort to formalize: low (wire existing `review` as a
post-draft delegation) → high (decompose the in-agent round phases into hand-offs,
which requires threading intermediate `<documents>` output as the next subagent's
input — gated by the same per-run-handle state-isolation work the proposal already
sequences for concurrent sessions).

---

## Recommendation

> **Superseded in part by the second-pass _Update_ above** — that pass re-traced
> each finding to ground truth and acted on two. This section is kept for the
> first-pass record; read it through the Update. Net of this PR:
>
> - **Applied here:** the P1 finalize-guard (a `try/catch` around the catch-side
>   `onRoundFinalized` — _not_ the first pass's "drop the catch-side record",
>   which the Update shows was wrong) and the dead `WorkspaceProvider.watch`
>   removal.
> - **Rejected:** P2a MiniMax `extractTextFromReasoningDetails` dedup (a trap; see
>   Update).
> - **Still backlog:** P3, Track, and Subagents below.

The original first-pass framing follows (treat as backlog on top of the existing
plan; behavior-neutral, adversarially-verified PR discipline):

1. **P1:** the `ResponseCycleNode` catch double-record — _applied as a guard_ (see
   Update; the first pass's "drop the catch-side `recordRound`" was wrong).
2. **P2:** MiniMax `extractTextFromReasoningDetails` dedup _(rejected — trap)_;
   remove dead `WorkspaceProvider.watch` port method _(applied)_.
3. **P3:** the two empty-type param aliases and the `withModelClient` closure DRY —
   bundle opportunistically.
4. **Track:** cross-provider user-message/media scaffold unification, alongside the
   ledger's existing `finalizeOpenAIResponse` item.
5. **Subagents:** wire `review` as a post-draft Verifier delegation (low effort) as
   the first concrete subagent-boundary win; defer in-agent round decomposition to
   the per-run-handle isolation track.

## Verified (files opened first-hand this pass)

- `ResponseCycleNode.ts` (full), `ResponseCycleFlow.ts:420-480` (`ResponseCycleFinalizeNode`),
  cross-checked `recordRound` callers via grep.
- `modelHandlerMiniMax.ts` + `utils/openRouterReasoning.ts` (dup confirmed),
  `modelHandlerOpenRouterNative.ts` importer.
- `src/platform/interfaces/workspace.ts` + grep for `.workspace.watch(` (empty) and
  the host/fake impl sites.
- `ToolUseServices.ts` / `ReflectionServices.ts` alias exports + ~10 node importers.
- Existing ledger §line 1627-1644, 2215-2234, and the canonical proposal's
  Rejected-findings + subagent tables (reconciliation).
