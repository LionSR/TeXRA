# Agent SDK Readiness — Verification Checkpoint (2026-07-10)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the plan of record
[`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-09` checkpoints (most recently
[`-2026-07-09`](./2026-07-09-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against the working tree at HEAD
`685f9fb` (branch `claude/eager-noether-pthtf7`, tracking `main`; `ee9c10f`
— the 07-09 checkpoint HEAD — is an ancestor). As on every prior pass it ran a
**fresh, uninformed multi-way fan-out audit** — four separate readers for (1)
`agent/modelHandlers/`, (2) `agent/core` + `implementations/flows`, (3)
`agent/runtime` + `logger`, and (4) `logger` + `platform` + the public
host↔core surface — then reconciled every finding against the adjudicated
rulings and re-checked the tracked candidates against the current tree.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The four fresh readers independently re-reached the
standing conclusion: the SDK-aligned spine is unchanged in shape —
`createModelHandler` + `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts:51`,`:376`),
`IModelHandler` still a `Pick<ModelHandler>`, `src/agent/core/index.ts` still
absent (no barrel regression), `emitRuntimeEvent` still retired (sole grep hit
is the retirement guard test), `RunScope` still the single identity carrier
(`RunScope.ts:15-18`), and the `Node.exec → createFlow().run` shape intact
(`ResponseCycleNode.ts:97,111`; `ToolUseCycleNode.ts:78,124`). Every
substantive candidate the fan-out surfaced maps onto an **already-adjudicated
trap** (ruling held), an **already-tracked reviewed-train / strategic** item,
or — new this pass — **an item the maintainers' PR train has already resolved
since 07-08** (three of them; see below).

## What the PR train resolved / advanced since 07-09

The tree is **cleaner** than at 07-09. The window `ee9c10f..685f9fb` is mostly
CI / dependabot / host-parity merges, but three of those merges moved standing
items materially — two of them the exact deltas the north-star (§2) and the
07-09 checkpoint tracked:

### 1. Tool-edit approval routed through sessions — the last ambient-approval module global is retired (coupling-audit finding #4 RESOLVED)

Commit `f325ea4` ("refactor: route tool edit approvals through sessions")
**retired `setToolEditApprovalHandler` entirely** — 0 production grep hits at
HEAD across `src/**` and `packages/**`. It also deleted the process-wide
`toolEditApproval` Platform port (`platform.ts` −3; `interfaces.ts` −18) and the
four host-side setter call sites (`packages/cli/.../approvalAdapter.ts`,
`packages/desktop/.../desktopToolEditApproval.ts`,
`packages/extension/.../extension.ts`, plus `initPlatform.ts`). Tool-edit
approval now flows through `session.interactions.requestToolEditApproval`
(`src/tools/approval/toolEditApproval.ts:245`, with an explicit guard at `:251`
if the session interactions port is unwired). This is the precise fix
`docs/proposals/2026-07-03-agent-runtime-ui-coupling-audit.md` finding #4 prescribed
("fold `setToolEditApprovalHandler` into a `SessionHandle`-scoped field"), now
landed. **This is why the surface reader's re-flag of it as "still open" is a
stale finding** (see below).

### 2. Launch stream status single-sourced (north-star D4 / TD-2(d))

Merged PR #7838 ("refactor: single-source launch stream status", issue #6968)
removes the launch stream-status field from `AgentLaunchContext.ts` (−3) and
routes it through a single owner (`AgentRunLifecycle.ts`, `executeAgent.ts`).
This is the north-star's §2 item 3(d) — "status leaves on a split dual rail …
complete atomically per D4" — advancing the acceptance metric "status rails to
a projector: 2 → 1."

### 3. Run-identity hardening continues (F4)

`#7835` ("run context satisfies") and `#7836` ("readonly run scope") harden the
exact `RunContext` / `RunScope` surface the 07-09 checkpoint tracked as the F4
convergence: `RunScope` is now `readonly` (`RunScope.ts:15-18`). Separately, the
provider contracts (`IModelHandler`, `ModelHandlerContracts`, `ProviderMessage`,
`ServerToolTypes`, `StopReasonTypes`) were relocated from
`agent/modelHandlers/types/` up to `agent/types/` — a structural tidy; the port
now lives at `src/agent/types/IModelHandler.ts` and is still a `Pick<ModelHandler>`.

## Applied this pass — the `runAgent`→`executeAgent` forwarding (on explicit request)

The **verification** pass found no _unattended-safe_ cleanup: the two
pure-deletion / pure-inline candidates the fan-out produced both cross
`packages/**` (see false positives below) — a verbatim repeat of the recurring
§7 methodology error the 07-09 checkpoint caught with `textConnection.ts`.

On an explicit maintainer instruction to refactor, the single cleanest,
lowest-risk candidate (new candidate #4 below) **was applied and verified**:
`runAgent` (`runAgent.ts:49`) no longer hand-forwards eight named options into
`executeAgent` one-by-one. It now destructures the three `runAgent`-only options
(`openWorkflowOutput`, `registerExecution`, `preferHelperModel`) and spreads the
rest — which is exactly the `Pick<ExecuteAgentOptions, …>` that `RunAgentOptions`
already extends — so a newly-picked option forwards with no edit here.

Why this one was unattended-safe once verified (unlike the reviewed-train items):
it is contained to `runAgent.ts` internals; the public `RunAgentOptions`
interface is unchanged (all five callers unaffected); it is behavior-preserving
(`executeAgent` reads its options by property access, does no `key in options`
presence checks — grep-confirmed — so spread-vs-literal is identical; the subset
omits `allowWaitingResult`, resolving to the same `Promise<AgentFlowResult>`
overload as before); and it is type-guaranteed by the existing `Pick`.
**Verified:** root `tsc --noEmit` clean, `eslint` clean on the file, and the
three `runAgent`-path suites green (`RunExecution`, `WorkflowScriptEngine`,
`DesktopAgentExecution` — 134 tests). Net +1 LOC (+14/−13 — the destructure
adds a line; the win is deleting the eight-field hand-forwarding, not LOC).

No other cleanup was applied — every remaining candidate is reviewed-train
(signature/structure change) or a verified false positive, and forcing one of
those unattended would violate the discipline.

### False positives caught this pass — record, do not re-flag

1. **`SessionHandle.hostChannel` is NOT unused dead code.** The runtime reader's
   top "remove the member" item claimed no production code reads
   `session.hostChannel`. It is true that no code _reads_ the member today — but
   it is **documented, deliberately-placed in-flight F-1 scaffolding** (the
   `SessionHandle` docstring: "SDK Step 7d follow-on F-1 … Unset ⇒ those stay on
   the bus" — the reader path is the not-yet-built F-1 consumer), and desktop
   **constructs and passes** a `hostChannel` into the `SessionHandle` ctor
   (`packages/desktop/src/main/desktopAgentExecution.ts:252`). Removing it is a
   maintainer decision about whether F-1 is still coming **plus** a desktop-side
   change — reviewed-train, not an unattended-safe deletion.

2. **`followUpResumeDetection.ts` is NOT safe to inline.** The runtime reader
   called it a "1-line, single-caller wrapper." Its one production caller is in
   `packages/extension/src/commands/agent/followUpCommand.ts:43`; it additionally
   has a **dedicated unit test**
   (`src/test-kernel/agent/FollowUpResumeDetection.vitest.mts`) and is a **named
   entry in the runtime README module map**. It is a tested, documented,
   named domain predicate (`shouldProbePersistedFlowForFollowUp`) consumed by a
   host command — inlining it deletes a tested seam and edits `packages/**`, not
   an unattended-safe move. (`src/`-only grep would have missed the extension
   caller.)

3. **The surface reader's `setToolEditApprovalHandler` "still open (Leak 3)" is
   STALE.** It was reasoning from the pre-`f325ea4` coupling-audit text; the
   setter is **gone** at HEAD (item 1 above). Its cited "live site"
   (`packages/cli/.../approvalQueue.ts`) references the _new_ session-scoped
   `ToolEditApprovalRequest` data type, not the retired global. Do not re-flag.

## Genuinely-new candidates — surfaced by this fan-out, absent from all prior docs

Grep-confirmed absent (0 hits) from the canonical doc, north-star, detailed
audit, delta, and the `-06-25` → `-07-09` checkpoints. **Reviewed-train, not
unattended-safe** — each is a signature/structure change, a documented seam, or
a doc-accuracy nuance. Record, don't sweep.

1. **The inner `ResponseCycle` / `ToolUseRound` flows earn neither retry nor
   resume** _(MEDIUM; structural, strategic — the sharpest observation this
   pass)_. Two facts together: (a) four of the five inner nodes
   (`ResponsePrepNode`, `ResponseProcessNode`, `ResponseContinuationNode`,
   `ResponseCycleFinalizeNode`) extend the **no-retry** `BaseNode`
   (`src/agent/node/index.ts:29`); only `ModelInvocationNode` (via
   `RetryableInvocationNode`) needs the retrying `Node`. (b) These inner flows
   run to completion inside a single non-persisted outer-node `exec()`
   (`ResponseCycleNode.ts:97-111`, `ToolUseCycleNode.ts:78-124`) — only the
   _outer_ flow is a `PersistedFlow`/`RoundPersistedFlow`. So the 5-node /
   4-node graph decomposition buys **neither** retry (one node needs it) **nor**
   resume (the outer flow owns that); the `.on(COMPLETE, finalizeNode)` wiring
   and `SkippableNodeResult` plumbing are pure structure. Collapsing the inner
   flows to plain `async` turn-loops (keeping only `ModelInvocationNode` as a
   real `Node`) would also delete `ResponseCycleFinalizeNode` (a graph-join-only
   node, `ResponseCycleFlow.ts:434`) and the documented double-`recordRound`
   hazard it creates. **This refines, does not overturn**, the standing
   "PocketFlow flow layer — do NOT refactor" ruling: the prior rebuttal
   (audit `:2059`) addressed the _outer_ wrapper node's orchestration; this is a
   distinct, sharper claim about the _inner_ graph. It is the largest single
   structure change proposed anywhere in the readiness program and collides with
   the deliberate "pure-exec / consistency-with-persisted-outer-flows"
   discipline — strategic, not a sweep.

2. **`RunContext`'s `launch | bare` union forces six branch accessors** _(LOW;
   downstream of F4)_. `getRunContext{RuntimeHost,StreamId,ExecutionId,AgentName,
WorkingDirectory,Session}` (`RunContext.ts:181-233`) are each an identical
   `context?.kind === 'launch' ? context.runScope.X : context.X` branch, existing
   only because `launch` nests a `RunScope` while `bare` inlines the same flat
   fields — and `bare` is documented as "exclusively for manually constructed
   test/one-shot contexts." So the union earns its keep largely for tests.
   Collapsing to a single always-`RunScope`-carrying shape (defaulted for
   bare/test) drops the six branch accessors in favor of `ctx.scope.X`. This is
   directly downstream of the F4 / `#7835`/`#7836` `RunScope` hardening train and
   should ride it; the accessors have ~heavy usage (`getRunContextStreamId` ×15+),
   so it is a signature sweep, not blind-safe.

3. **`IToolRegistry` is an interface over exactly one production implementation**
   _(LOW; cheap)_. `core/tools/ToolTypes.ts:36` — two methods (`get`/`has`); the
   only `implements IToolRegistry` is `MapToolRegistry` in the same file, and
   every construction (production + all 13 test sites) is `new MapToolRegistry`.
   The DI/mock rationale (line 35) is not exercised — tests inject the concrete
   class. `MapToolRegistry` could be the type. That said it is a genuinely clean
   `get`/`has` surface an SDK tool-lookup wants; cost of keeping it is ~4 lines.
   (`ITool`, by contrast, is a real multi-impl contract — keep.)

4. **`runAgent` hand-forwards eight options into `executeAgent`** _(LOW;
   drift-risk)_ — **APPLIED THIS PASS** (see "Applied this pass" above).
   `runAgent.ts` re-listed eight named options one-by-one even though
   `RunAgentOptions extends Pick<ExecuteAgentOptions, …>` already guarantees shape
   compatibility — pure boilerplate that had to be edited on every new option. Now
   destructures the three `runAgent`-only options and spreads the picked subset;
   verified type-safe + 134 tests green. (`runAgent` is otherwise a justified thin
   convenience layer — executionId gen + registration + helper-model swap +
   `openWorkflowOutput` — not a redundant wrapper; the dual-entry ruling holds.)

5. **`BaseReasoningStreamAggregator` doc-accuracy nuance** _(LOW; refines, does
   not remove)_. The detailed audit (`:497`) lists it among "genuinely shared"
   utilities. Precisely: it has **exactly one importer**
   (`openai/modelHandlerOpenAI.ts`) and **no subclasses** (`grep "extends
BaseReasoning"` → 0). It is cohesive single-caller stream state, not a shared
   base — the `Base` prefix and "shared" framing are both mildly overstated.
   Mirrors the 07-09 `IModelHandler` "cannot drift" doc-nuance: refine the
   characterization (single-caller cohesive helper), do not remove it.

## Reviewed-train / strategic candidates re-confirmed — already tracked

The fan-out independently re-derived the following; each is already recorded and
adjudicated. Rulings held, no new action.

| Re-derived this pass                                                                                                                                                                                                                                                | Already tracked at                                                                                                                                | Standing disposition                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retire the `Shared*` execution/subscription/status singletons → session-only ownership (`executionRegistry.ts:927`,`:301`; `StreamStatusService`; ~33 direct call sites)                                                                                            | 07-09 subagent split point #4 ("relocate the remaining module-global registries onto the per-session handle")                                     | **Strategic** — the Stage-5 session-ownership train is paying this down; dual-ownership is documented transitional debt.                                                                    |
| Relocate the helper-model / content-helper cluster (8 files: `helperModel*`, `polishModel`, `textEnhancement`, `sessionDescription`, `mediaVisionWarning`) out of `runtime/`                                                                                        | runtime `README.md:33-34` ("if a future refactor touches a whole group's call sites anyway, revisit turning that group into a real subdirectory") | **Reviewed-train** — a grouping decision the README explicitly anticipates; ~180 call-site churn if done alone.                                                                             |
| Replace `ProgressViewBridge` port+registry+default with an injected `() => boolean`                                                                                                                                                                                 | audit `:1290`,`:1313`                                                                                                                             | **Reviewed-train** — recently-reworked for "clearer ownership"; a deliberate port.                                                                                                          |
| Four single-core-caller, VS-Code-only `Platform` diagnostic ports (`linter`, `addCriticismSink`, `toolMissingHandler`, `toolNotificationHandler`)                                                                                                                   | 07-09 #4                                                                                                                                          | **Reviewed-train** — still present at HEAD (`platform.ts:54-72`); host-wiring signature change across three hosts.                                                                          |
| `SdkToolCall` 6-variant clone union → one generic `NormalizedToolCall<P,Raw,Input>`                                                                                                                                                                                 | 07-09 #2                                                                                                                                          | **Reviewed-train** — exported shared-contract surface (now at `agent/types/ModelHandlerContracts.ts`).                                                                                      |
| `IToolUseSession` single-impl port; `TaskState` `.refine(...) as` double-cast instead of a discriminated `AgentConfig` union                                                                                                                                        | audit (`IToolUseSession`); `TaskState.ts:40-62`                                                                                                   | **Reviewed-train** — the port keeps `core/flows` off the concrete follow-up queue (dependency-direction rule); `AgentConfig`-as-discriminated-union touches the persisted execution record. |
| No packaged entry / hosts deep-import ~30–45 `@agent/*` modules each (incl. `modelHandlers/*` and `implementations/flows/*` internals); no `@agent/runtime` barrel                                                                                                  | north-star §3 (MONO-1), Step 0 (R-a/R-b ratchets), Step 3 (packaging)                                                                             | **Strategic/gated** — packaging waits on a real external consumer + the import-boundary gate; barrels are banned before Stage-5 vocabulary freezes.                                         |
| No minimal / in-memory default `Platform` for an embedder (11 required ports)                                                                                                                                                                                       | north-star §2 NS-1 (the bootstrap incantation)                                                                                                    | **Strategic** — the CLI-as-canonical-example Step 2 folds the bootstrap into `nodeHost`.                                                                                                    |
| `getApiKey` credential/tier policy → `CredentialResolver`; a `runTurn`/`streamTurn` façade over the ~40-member `IModelHandler`; `createChannelTrace` → 4-method `ChannelLogger`; provider-identity getters → capability table; per-host `runSession()` choreography | 07-09 table (audit `:2546`, `-07-05`/`-07-06`/`-07-08`, `logger-surface-cleanup` PRD)                                                             | **Reviewed-train / strategic** — unchanged; the F6 / Stage-5 / #7560 train advances the choreography incrementally.                                                                         |

## Adjudicated traps the fan-out re-surfaced — rulings held

No change.

| Re-surfaced candidate                                                                                                                        | Ruling                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `ResponseCycleNode`/`ToolUseCycleNode` "`exec()` marshals state → runs inner flow → interprets outcome" wrapper is removable indirection | **Keep** (audit `:2059`) — the outer node owns real per-round orchestration (`getClient`/`refreshClient` closure pair, `workPlan.setOnUpdate` todo wiring, outcome→`shared` mapping). Distinct from new candidate #1, which is about the _inner_ graph. |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                                                                                    | **Trap** — `Pick<ModelHandler>` + optional `createBatchedToolUseFollowUpMessages`; removal breaks a real import cycle.                                                                                                                                  |
| Fold the single-caller flow factories `createResponseCycleFlow` / `createToolUseRoundFlow` into their Nodes                                  | **Keep** — this **is** the prescribed `Node.exec() → createFlow() → run()` shape (CLAUDE.md).                                                                                                                                                           |
| `runAgent` / `executeAgent` dual entry is redundant                                                                                          | **Keep** — two documented responsibilities (executionId+register+workflow-output vs the run).                                                                                                                                                           |
| Collapse OpenAI-compatible subclasses to a config table                                                                                      | **Trap** — each carries real per-provider overrides; DashScope alone is thin and is enum-mandated by the exhaustive route table.                                                                                                                        |
| Delete `bestConnectionMethodAnthropic` / the `openaiApiKey` branch in `textConnection.ts` as dead code                                       | **False positive (07-09)** — live in `packages/extension/.../connectionTests.ts`. Do not delete.                                                                                                                                                        |

## Subagent split points — re-confirmed, gating observation unchanged

No change to the canonical/delta ranking. The runtime reader independently
re-derived that delegation is a **mature strategy-pattern subsystem**, not
something to build: `childRunLoop.ts` (one driver for every child-run type) +
`ChildRunStrategy<TTurn>` (`childRunLoop.ts:78`) + the concrete strategies in
`src/tools/delegation/` + `executionRegistry` lineage tracking +
`detachSubagentsOnStop` are already the SDK spawn shape (prompt/config in →
`AgentFlowResult` out, with progress/cost/resume/interrupt/lineage). Ranked
split points unchanged from `-06-26` → `-07-09`:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation.
2. Introduce a typed `delegateTo(subagent, input, {maxDepth, tools})` over
   `childRunLoop` + `ChildRunStrategy` + `executeAgent`.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents into draft → Verifier → apply
   hand-offs — gated by #4.

**Gating observation (unchanged from 07-09, re-verified):** delegation depth is
tracked but never gated — `delegationPolicy.ts` computes depth for
observability / `isSubagent` only, `agentToolResolution.ts` has no depth-based
tool filtering, and there is still no `maxDelegationDepth` runtime setting
(grep: 0 hits). A real depth cap remains a prerequisite before exposing
recursive `delegateTo(...)` as a public SDK surface (split point #2).

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is cleaner
than at 07-09: the maintainers' PR train **resolved coupling-audit finding #4**
(tool-edit approval routed through `session.interactions.requestToolEditApproval`
via `f325ea4`; the last ambient-approval module global and the `toolEditApproval`
Platform port are gone), **single-sourced launch stream status** (#7838, the
north-star D4 / status dual-rail item), and **hardened `RunScope`/`RunContext`**
(#7835/#7836, F4). **One cleanup was applied this pass — on explicit request:**
the `runAgent`→`executeAgent` eight-field hand-forwarding (new candidate #4),
verified type-safe + lint-clean + 134 tests green, net +1 LOC, contained to
`runAgent.ts` internals. The verification pass otherwise found no _unattended-safe_
cleanup — both pure-deletion candidates (`SessionHandle.hostChannel`,
`followUpResumeDetection.ts`) are verified false positives that cross
`packages/**` (the recurring `src/`-only-grep error), and one fan-out finding
(`setToolEditApprovalHandler` "still open") was already resolved by the PR train.
Four remaining genuinely-new low/medium items are recorded as reviewed-train (the
inner-cycle-flow-earns-neither-retry-nor-resume structural observation — the
sharpest, strategic; the `RunContext` `launch|bare` six-accessor union — ride the
F4 train; the `IToolRegistry` single-impl interface; the
`BaseReasoningStreamAggregator` doc nuance). Everything else maps to
already-tracked reviewed-train / strategic items or adjudicated traps (held). Do
not re-open the traps; do not re-flag `hostChannel`, `followUpResumeDetection`,
`setToolEditApprovalHandler`, or `textConnection.ts`; do not sweep the
reviewed-train items unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `685f9fb` (branch `claude/eager-noether-pthtf7`;
  `ee9c10f` is an ancestor): `createModelHandler` + `PROVIDER_HANDLER_ROUTES`
  (`ModelFactory.ts:51`,`:376`), `IModelHandler` = `Pick<ModelHandler>` (now at
  `src/agent/types/IModelHandler.ts:54-60`), `src/agent/core/index.ts` **absent**
  (no barrel regression), `emitRuntimeEvent` **retired** (sole grep hit is
  `sessionFactAmbientHelperRetirement.vitest.ts`), `RunScope.ts:15-18` carries
  `streamId`/`executionId`/`agentName` (now `readonly`), `Node.exec →
createFlow().run` intact (`ResponseCycleNode.ts:97,111`;
  `ToolUseCycleNode.ts:78,124`), F4 flat identity fields **gone** from
  `AgentLaunchContext` (0 flat-field decls).
- PR-train advances verified in-tree: `f325ea4` deletes `setToolEditApprovalHandler`
  (0 grep hits `src/**`+`packages/**`), removes the `toolEditApproval` Platform
  port (`platform.ts` diff), and routes approval via
  `toolEditApproval.ts:245`; #7838 removes launch stream status from
  `AgentLaunchContext.ts`; #7835/#7836 make `RunScope` readonly; provider
  contracts relocated `modelHandlers/types/` → `agent/types/`.
- False positives verified: `SessionHandle.hostChannel` assigned
  (`SessionHandle.ts:144`) and passed by desktop
  (`desktopAgentExecution.ts:252`) — documented F-1 scaffolding, not dead code;
  `followUpResumeDetection` imported at `followUpCommand.ts:43` with a dedicated
  vitest and a README module-map entry — not inline-safe.
- New candidates verified in-tree and novel (0 grep hits across all prior
  readiness docs): inner cycle nodes extend no-retry `BaseNode` while only the
  outer flow persists (`ResponseCycleNode.ts:97-111`, `node/index.ts:29`);
  `RunContext` six branch accessors (`RunContext.ts:181-233`); `IToolRegistry`
  single `implements` (`ToolTypes.ts:42`); `runAgent` eight-field forward
  (`runAgent.ts:76-85`); `BaseReasoningStreamAggregator` single-importer /
  no-subclass.
- Delegation depth verified still tracked-but-ungated (`delegationPolicy.ts`;
  no `maxDelegationDepth`, 0 grep hits).
- Applied cleanup verified: `runAgent.ts` forwarding spread — root `tsc
--noEmit` clean, `eslint src/agent/runtime/runAgent.ts` clean, and
  `RunExecution` / `WorkflowScriptEngine` / `DesktopAgentExecution` suites green
  (134 tests). `executeAgent` does no `key in options` presence check on the
  forwarded keys (grep-confirmed); public `RunAgentOptions` interface unchanged,
  all five `runAgent` callers unaffected.
- The checkpoint doc itself is added under `docs/proposals/`, an internal
  directory excluded from the texra.ai publish allowlist — not a root-level doc.
