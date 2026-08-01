# Agent SDK Readiness — Verification Checkpoint (2026-07-09)

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` → `-2026-07-08` checkpoints (most recently
[`-2026-07-08`](./2026-07-08-agent-sdk-readiness-checkpoint.md)).

This pass re-verified the standing audit against the working tree at HEAD
`ee9c10f` (branch `claude/eager-noether-gnmi5a`, tracking `main`). The
SDK-aligned spine (`createModelHandler` / `PROVIDER_HANDLER_ROUTES`,
`IModelHandler` as `Pick<ModelHandler>`, `src/logger/**`, `src/agent/trace/**`
`emit`/`subscribe`, the `platform()` composition root, the
`Node.exec → createFlow().run` shape) is unchanged in shape. As on every prior
pass, this ran a **fresh, uninformed multi-way fan-out audit** — four separate
readers for (1) `agent/core` + `runtime` + `implementations/flows`, (2)
`modelHandlers/`, (3) `logger` + `platform` + public surface, and (4) the
multi-agent / subagent boundary map — then reconciled every finding against the
adjudicated rulings and re-checked the tracked candidates against the current
tree.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The four fresh readers independently re-reached the
standing conclusion: no `Node.exec → wrapper → coreFunction → createFlow →
flow.run` ladders, no trivial identity factories, no two-layer
`buildX`-only-from-`createX` factories, `IModelHandler` still `Pick<ModelHandler>`,
`src/agent/core/index.ts` still absent (no barrel regression), and the
lead-and-specialists delegation model intact. Every substantive candidate the
fan-out surfaced maps onto an **already-adjudicated trap** (ruling held) or an
**already-tracked reviewed-train / strategic** item — with one exception noted
below that resolved itself in the maintainers' PR train.

## What the PR train resolved / advanced since 07-08

The tree is **cleaner** than at 07-08. Two items the standing docs tracked have
moved materially in-tree via the maintainers' Stage-5 run-scope train (merged
PRs #7665 / #7666 / #7668):

### 1. `emitRuntimeEvent` fully retired — the runtime-event surface is now just `SessionEventHub`

The 07-08 checkpoint recorded `emitRuntimeEvent.ts` as a single generic 32-LOC
emit path (already the resolved form of the earlier `SessionFact` triplication).
That file is now **gone from production entirely** — the only remaining grep hit
is the architecture guard test
`src/test-kernel/architecture/sessionFactAmbientHelperRetirement.vitest.ts`
(which exists precisely to keep it retired). Run-scoped facts now flow through
`SessionEventHub` (`SessionEventHub.ts:27` — the `SessionFact` union;
`:71` — the `{ scope: 'session'; event: SessionFact }` arm) with no ambient
helper in between. The core reader confirmed the file the brief still names
(`runtime/emitRuntimeEvent.ts`) **does not exist**; this is why.

### 2. F4 run-identity convergence (`AgentLaunchContext` flat fields → `RunScope`) is actively landing

The fresh core reader independently re-derived what the standing audit tracked as
the "three overlapping run-identity shapes" concern
(`AgentLaunchContext` flat fields ⊃ `RunScope`, re-projected to `RunContext`).
The maintainers are **paying this down right now**: commit `367dd45`
("refactor: delete launch context flat identity fields", merged as #7668)
removes the flat identity fields from `BaseFlowServices.ts` (−16 LOC) and
`AgentLaunchContext.ts` (22 → 2 LOC), and `d51ea5e` ("read tool run context
through run scope", #7666) routes tool run context through `RunScope`. `RunScope`
now carries `streamId` / `executionId` / `agentName` as the single identity
carrier (`RunScope.ts:17-20`). This is the exact convergence direction the audit
recommended, delivered incrementally by the maintainers — **not a gap to act on
this pass.**

## Applied this pass — none (and why that is correct)

**No code cleanup was applied this pass.** Every prior checkpoint applied one
_unattended-safe_ cleanup only because a clean dead-code deletion or type-only,
zero-external-effect rename happened to be available (07-08:
`CycleServices → WorkspaceScopedCore` private-alias rename; 07-06:
`markdownFences.ts` dead-wrapper deletion; 07-05: `ModelFactory.ts` dead
re-export). **This pass, the single pure-deletion candidate the fan-out produced
turned out to be a false positive** (see below), and everything else is
already-adjudicated reviewed-train — which the discipline says _record, don't
sweep unattended_. Forcing a cleanup where none is unattended-safe would violate
that discipline, so nothing was changed.

### False positive caught this pass — `textConnection.ts` "dead code" is live in `packages/**`

The core reader's highest-ranked, "pure deletion, zero risk" item was:
delete `bestConnectionMethodAnthropic` (claimed "zero callers") and the
`openaiApiKey`/`n` branch of `bestConnectionMethod` (claimed "unreachable")
from `src/agent/runtime/textConnection.ts` (~70 LOC). **Both claims are wrong.**
`packages/extension/src/commands/tests/connectionTests.ts` imports **both**
functions (`:6-8`) and calls them from the `handleTestConnection` VS Code
command — `bestConnectionMethod` at `:44` and `bestConnectionMethodAnthropic`
at `:49`, each via `runConnectionTests(...)`. The audit reached its conclusion by
grepping `src/**` only; the live callers are in `packages/extension/**`.

This is a **verbatim repeat of the methodology error §7 of the detailed audit
called out** ("audits of `src/` must also grep `packages/**` (desktop, cli,
extension) before declaring a symbol unused" — the same lesson as the
`redactSecrets` false positive). Recorded here so `textConnection.ts` is **not
re-flagged as dead code** on a future pass. `bestConnectionMethodAnthropic` is
the Anthropic connection-test path exercised by the extension's "Test
Connection" developer command; it is intentionally kept.

## Genuinely-new candidates — surfaced by this fan-out, absent from all prior docs

Grep-confirmed absent (0 hits) from the canonical doc, the detailed audit, the
delta, and the `-06-25` → `-07-08` checkpoints. **Reviewed-train, not
unattended-safe** — each is a broad type-surface change, a documented extension
point, or a deliberate maintainer decision. Record, don't sweep.

1. **The `<C>` model-client generic is threaded-but-always-`unknown`** _(LOW,
   reviewed-train — and arguably a deliberate extension point)_. `C` is threaded
   through `AgentCore<C>` → `BaseFlowContextInit<C>` → `CycleRunServices<C>` →
   `{ResponseCycle,ToolUseRound}Services<C>` → every flow node → the two flow
   factories → `runReflectionFlow<C = unknown>` / `runToolUseFlow<C = unknown>`
   across ~12 files. No production call site supplies a concrete `C`
   (`executeAgent` calls the flow runners with no type arg), so it degrades to
   `unknown` universally. **However**, `ResponseCycleFlow.ts:582` documents
   `createResponseCycleFlow<MyContext>()` as intended usage — the generic is a
   designed-in extension seam, not accidental. Stripping it is a mechanical,
   behavior-preserving 12-file readability win **but** removes a documented
   extension point; leans _keep-or-defer_, and either way is a signature sweep
   across 12 files, not an unattended-safe move.

2. **`SdkToolCall` is a 6-variant clone union** _(LOW; DRY)_.
   `types/ModelHandlerContracts.ts:119-174` — `OpenAIToolCall`,
   `DeepSeekToolCall`, `OpenAIResponseToolCall`, `GoogleToolCall`,
   `AnthropicToolCall`, `OpenRouterToolCall` are structurally identical
   (`{provider, callId, name, input, raw}`), differing only in the `provider`
   literal and the `raw`/`input` types; the union's own comment (`:176-178`)
   notes narrowing is by `provider` alone. Collapsible to one generic
   `NormalizedToolCall<P, Raw, Input>` + six one-line aliases (~30 LOC). Exported
   shared-contract type surface consumed across handlers → reviewed-train.

3. **`SessionEventHub` re-broadcasts the trace's own run-event stream**
   _(MEDIUM; structural, strategic)_. `SessionHandle.attachRunTrace`
   (`SessionHandle.ts:177-194`) re-emits every `AgentEvent` already fanned out by
   `TraceEmitter.subscribe` onto `SessionEventHub` as a `scope:'run'` arm, where
   progress backends re-subscribe with type filters. Two `Set<subscriber>`
   fan-outs + two guard layers for the same events. Candidate: give
   `TraceEmitter.subscribe` an optional type filter, keep `SessionEventHub` for
   **session-scoped facts only**, drop the `scope:'run'` arm (~60–100 LOC). This
   is the run-event half of the standing "one streamed-message SSoT" goal;
   strategic, sequenced behind the session-choreography (`runSession()`) work.

4. **Four single-core-caller, VS-Code-only `Platform` ports** _(LOW–MEDIUM;
   extends the §21 `agentResume` single-use-port line)_. `linter`
   (→ `DiagnosticsTool.ts:132`), `addCriticismSink` (→ `DiagnosticsTool.ts:177`),
   `toolMissingHandler` (→ `toolUtils.ts:49`), `toolNotificationHandler`
   (→ `toolUnavailableNotification.ts`) are each one core call site, no-ops on
   CLI/desktop, and are pure presentation side effects. Candidate: fold the two
   notification ports into `RuntimePresentationEvent`s on `runtimeHost.emit`, and
   collapse `linter` + `addCriticismSink` into one optional `DiagnosticsHost`
   port (16 ports → ~12). Reviewed-train (host-wiring signature change across
   three hosts).

5. **`RoundPersistedFlow.run()` duplicates `PersistedFlow`'s step loop**
   _(LOW; drift-safety, net-LOC-neutral)_. `node/roundPersistedFlow.ts:144-193`
   reimplements the `while (step.hasMore)` loop rather than sharing
   `PersistedFlow.run()`'s (`node/persistedFlow.ts:154-163`), because it needs
   per-round staging. A legitimate template-method divergence, but the two loops
   can drift; a shared `protected async runSteps()` would let both share one
   implementation. Not a deletion.

6. **`IModelHandler`'s `Pick` key-set is manually maintained** _(LOW; doc
   accuracy nuance, not a removal)_. The model-handler reader correctly notes
   that `types/IModelHandler.ts`'s doc claim that it "can never drift from the
   base class" is **overstated**: the `Pick<ModelHandler, ...>` member list is a
   hand-written string union, so _adding_ a public method to `ModelHandler` does
   **not** auto-surface it here. What cannot drift is member _types_ (a renamed
   base member breaks the `Pick`); what is manual is the exposed _set_. This
   **refines, does not overturn**, the standing "remove `IModelHandler`" trap
   ruling (removal still breaks a real import cycle — keep the port). Suggested:
   soften the doc comment to say "member types cannot drift; the exposed set is
   curated," nothing more.

## Reviewed-train / strategic candidates re-confirmed — already tracked

The fan-out independently re-derived the following; each is already recorded and
adjudicated. Rulings held, no new action.

| Re-derived this pass                                                                                                                                      | Already tracked at                                                    | Standing disposition                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extract `getApiKey` rule-table / credential+tier policy out of the adapter base into a `CredentialResolver` (symmetry with `ProxyConfigResolver`)         | audit `:2546-2547`, `:2928`; checkpoints `-06-26`, `-06-30`, `-07-08` | **Reviewed-train** — placement/signature change, not blind-safe.                                                                                                                                       |
| No single `runTurn()` entry over the ~40-member `IModelHandler` port                                                                                      | `-07-05`, `-07-06`, `-07-08`                                          | **Strategic** — add a thin `runTurn`/`streamTurn` façade over the primitives; keep the port internal.                                                                                                  |
| Narrow `createChannelTrace` to a 4-method `ChannelLogger` (drops the ~10 inert `AgentTrace` members across ~25 module singletons)                         | `-07-05` #7, `-07-08`; `logger-surface-cleanup` PRD                   | **Reviewed-train** — ~25 call sites; deliberate polymorphism tradeoff.                                                                                                                                 |
| Provider-identity combinator getters in `ModelHandler` base → capability profile table                                                                    | audit §7/§8; `-07-08`                                                 | **Reviewed-train** — behavioral gates already converted; base retains the display allow-list, guarded by the `#7101 triage` rationale in-file.                                                         |
| Per-host session choreography duplicated 3× + `AgentRuntimeHost.emit` interaction arm parallel to the typed `interactions` port → a `runSession()` façade | `-07-03` (`toolHostUi`); surface B2/B5; `-07-08`                      | **Strategic** — the F6 / Stage-5 / #7560 train is paying this down incrementally.                                                                                                                      |
| `ModelHandlerGoogleGenAI` is a feature-frozen duplicate of `ModelHandlerGoogleInteractions`                                                               | README `:14`, `ModelFactory.ts:194-204` (#7097)                       | **Deliberate** — kept as an explicit stateless fallback for the Interactions flag; documented "not tracked for behavioral parity." Not dead weight; collapse only if the fallback is formally dropped. |
| `OpenAIResponse` WebSocket path + dual compaction inflate the handler vs the Anthropic reference                                                          | `2025-06-04-openai-responses-api.md`; prior handler passes            | **Strategic** — WS is a gated optional transport; removal is a feature decision measured on value, not a sweep.                                                                                        |

## Adjudicated traps the fan-out re-surfaced — rulings held

No change.

| Re-surfaced candidate                                                                                       | Ruling                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                                                   | **Trap** — `Pick<ModelHandler>` + optional `createBatchedToolUseFollowUpMessages`; removal breaks a real import cycle. (Doc-accuracy nuance recorded above, ruling unchanged.)               |
| Inline `createResponse → withCreateResponseGuard → withSdkErrorTag → createResponseImpl`                    | **Keep** — each hook has distinct real overriders (impl ×6, tagger ×5, guard ×2).                                                                                                            |
| Inline the single-caller `executeAgent` wrappers `runReflectionAgent` / `runToolUseAgent`                   | **Keep** — each owns category-specific wiring; inlining bloats `executeAgent`.                                                                                                               |
| Fold the single-caller flow factories `createResponseCycleFlow` / `createToolUseRoundFlow` into their Nodes | **Keep** — this **is** the prescribed `Node.exec() → createFlow() → run()` shape (CLAUDE.md), the same shape the deleted `ResponseCycle.ts`/`ToolUseCycle.ts` wrappers were refactored into. |
| `runAgent` / `executeAgent` dual entry is redundant                                                         | **Keep** — `runAgent` owns executionId + register + workflow-output; `executeAgent` owns the run. Two documented responsibilities.                                                           |
| Collapse OpenAI-compatible subclasses (DeepSeek/Kimi/MiniMax/GLM/DashScope) to a config table               | **Trap** — each carries real per-provider overrides; only DashScope is thin, and it is enum-mandated by the exhaustive route table.                                                          |
| Delete `bestConnectionMethodAnthropic` / the `openaiApiKey` branch in `textConnection.ts` as dead code      | **False positive (new this pass)** — both are live in `packages/extension/.../connectionTests.ts`. Do not delete.                                                                            |

## Also persisting unchanged — the three 07-08 genuinely-new candidates

Verified still present, still reviewed-train, none swept:

- `modelHandlerXAI.extractResponse` diagnostic-only override
  (`openai/modelHandlerXAI.ts:23-38`) — overrides solely to `logger.debug` the
  reasoning-token count; no behavioral effect.
- Duplicated `INTERNAL`-suppression rule (`logger/channelTrace.ts:33` +
  `logger/logUtils.ts:236`) — two copies of one drop-`MESSAGE_TYPES.INTERNAL`
  policy.
- `TextConnectionService` single-member exported interface
  (`core/flows/CycleServices.ts:63`, extended only by `ResponseCycleServices` at
  `:87`).

## Subagent split points — re-confirmed, with one new gating observation

No change to the canonical/delta ranking. The three highest-confidence
already-isolated units a formal decomposition would draw on
(`ModelFactory.createModelHandler`, `assembleAgentLaunchContext`,
`agentToolResolution`) are unchanged, and the F6 `childRunLoop` /
`ChildRunStrategy<TTurn>` substrate (`childRunLoop.ts:78`) remains the concrete
spawn primitive to expose a typed `delegateTo(...)` over. Ranked split points
unchanged from `-06-26` → `-07-08`:

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation.
2. Introduce a typed `delegateTo(subagent, input, {maxDepth, tools})` primitive
   over `startChildRunLoop` + `ChildRunStrategy` + `executeAgent` — the
   substrate is already the SDK shape (prompt/config in → `AgentFlowResult` out,
   with progress/cost callbacks, resume, interrupt, lineage).
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors with
   typed I/O contracts.
4. Relocate the remaining module-global registries onto the per-session handle.
5. Decompose in-agent multi-phase workflow agents into draft → Verifier → apply
   hand-offs — gated by #4.

**New gating observation (recorded, not a blocker):** the subagent reader
confirmed delegation **depth is tracked but never gated**
(`runtime/delegationPolicy.ts` computes `parentDelegationDepth + 1` for
observability / `isSubagent` detection only; `agentToolResolution.ts` contains no
depth-based delegation-tool filtering, and there is no `maxDelegationDepth`
runtime setting). Depth tracking without a cap is fine for the current
tool-call-driven delegation, but **a real depth cap is a prerequisite before
exposing recursive `delegateTo(...)` spawning as a public SDK surface** (split
point #2). This complements, and does not change, the existing ranking — it names
the one guard the public primitive must add over the existing plumbing.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** The tree is cleaner
than at 07-08: the maintainers' Stage-5 run-scope train retired
`emitRuntimeEvent` entirely (run facts now flow through `SessionEventHub` alone)
and is actively deleting the `AgentLaunchContext` flat identity fields the core
reader independently re-flagged (F4 convergence, landing via #7666 / #7668).
**No cleanup was applied this pass** — the one pure-deletion candidate
(`textConnection.ts`) was a verified false positive (live in
`packages/extension/**`, the recurring `src/`-only-grep error), and every other
candidate is already-adjudicated reviewed-train. Six genuinely-new low/medium
items are recorded as reviewed-train (the always-`unknown` `<C>` generic — likely
a deliberate extension seam; the `SdkToolCall` clone union; the `SessionEventHub`
run-event re-broadcast; four single-caller diagnostics/notification ports; the
`RoundPersistedFlow` step-loop duplication; the `IModelHandler` "cannot drift"
doc nuance). Everything else maps to already-tracked reviewed-train / strategic
items (`getApiKey`→resolver, `runTurn` façade, `ChannelLogger` narrowing,
provider-identity→capability table, `runSession()` choreography, GoogleGenAI
fallback, OpenAIResponse WS path) or adjudicated traps (held). Do not re-open the
traps; do not re-flag `textConnection.ts` as dead code; do not sweep the
reviewed-train items unattended.

## Verified (this checkpoint)

- Spine re-confirmed at HEAD `ee9c10f` (branch `claude/eager-noether-gnmi5a`):
  `createModelHandler` + `PROVIDER_HANDLER_ROUTES` (`ModelFactory.ts:51`,`:376`),
  `initPlatform` / frozen `platform()` accessor, `AgentTrace` `emit`/`subscribe`
  (`trace/index.ts`), `src/agent/core/index.ts` **absent** (no barrel
  regression), `Node.exec → createFlow().run` shape intact
  (`ResponseCycleNode.ts:99`, `ToolUseCycleNode.ts:80`).
- 07-08 `emitRuntimeEvent` path verified **retired**: 0 production grep hits
  (`src/**`, `packages/**`); sole reference is the retirement guard test
  `sessionFactAmbientHelperRetirement.vitest.ts`. `SessionEventHub.ts:27` carries
  the `SessionFact` union; `:71` the `scope:'session'` arm.
- F4 convergence verified landing: `git show 367dd45` deletes the flat identity
  fields from `BaseFlowServices.ts` (−16) and `AgentLaunchContext.ts` (22→2);
  `RunScope.ts:17-20` carries `streamId`/`executionId`/`agentName`.
- False positive verified: `bestConnectionMethod` (`connectionTests.ts:44`) and
  `bestConnectionMethodAnthropic` (`:49`) are both imported (`:6-8`) and called
  from the `handleTestConnection` VS Code command. `textConnection.ts` is **not**
  dead code.
- New candidates verified in-tree and novel (0 grep hits across all prior
  readiness docs): the `<C>` generic threading (`BaseFlowServices.ts:34` et al.,
  no concrete production supplier), `SdkToolCall` 6-variant union
  (`ModelHandlerContracts.ts:119-174`), `SessionHandle.attachRunTrace` re-emit
  (`SessionHandle.ts:177-194`), the four single-caller `Platform` ports
  (`platform.ts:55-73`), `RoundPersistedFlow.run` (`roundPersistedFlow.ts:144`),
  and delegation-depth-tracked-but-ungated (`delegationPolicy.ts`).
- No source files changed this pass; no build/typecheck run required (documentation
  only, added under `docs/proposals/`, an internal directory excluded from the
  texra.ai publish allowlist — not a root-level doc).
