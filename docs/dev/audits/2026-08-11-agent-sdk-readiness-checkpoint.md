---
created: 2026-08-11
---

# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-11 at HEAD `ce28f88` from four parallel
> evidence passes (agent core, model handlers, logger/trace, package surface),
> every claim backed by `file:line` and grep'd caller counts. This is a
> _current-state_ re-measurement, not a new plan. It continues the near-daily
> checkpoint series — read alongside the immediately prior
> [`2026-08-10-agent-sdk-readiness-checkpoint.md`](./2026-08-10-agent-sdk-readiness-checkpoint.md)
> and the base audit
> [`2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
> under the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Its job is to confirm whether the standing conclusions still hold and to record
> what has landed since 2026-08-10. Nothing here overrides a maintainer ruling,
> reopens the retired TD-2(a) / package-fence / `ModelCell` proposals, or proposes
> splitting the deliberately-flat `runtime/` directory.
>
> **Run context (honesty note).** Unattended scheduled run, no external
> adversarial reviewer available. Per the series discipline for such passes,
> findings are flagged, not landed — see [§6](#6-no-code-change-lands-this-pass-by-design).

## Verdict

**Well-aligned. No structural refactor is warranted, and none was made.** The four
named areas remain converged on the Claude-Agent-SDK shape; the
`config/ratchets/` guardrails and the free-zone import fence are holding, and the
26 commits since the 2026-08-10 checkpoint (`0c6e2b9`, confirmed an ancestor of
`ce28f88`) _reduced_ indirection in this scope rather than adding any. Four
independent readers reconverged on the standing conclusion of the `-05-29 →
-08-10` chain. **The fan-out surfaced zero genuinely-new actionable
abstraction.** The one open cosmetic item the 2026-08-10 checkpoint named (§4.1,
the stale `createChannelWriter` docstring) has since **landed as fixed** (#9936);
what remains are the same already-tracked packaging/mechanical items, none
blocking and none an abstraction cleanup.

## 1. Area confirmations (fresh evidence at `ce28f88`)

- **Agent core.** Spine intact. The sanctioned `Node.exec → createFlow().run`
  shape holds — `ResponseCycleNode.exec()` builds and runs the flow inline
  (`reflection/nodes/ResponseCycleNode.ts:97,101,108`; factory at
  `core/flows/ResponseCycleFlow.ts:611`). `node/index.ts` remains the **sole**
  `BaseNode`/`Node`/`Flow` definition (`:28,:103,:251`); no competing production
  definition and **no `src/agent/core/index.ts` barrel** (grep for
  `export … from` across `core/`+`runtime/` returned nothing). The launch/resume
  layering is justified, not pass-through: `runAgent` (`runAgent.ts:77`) mints
  the `executionId` and delegates to `executeAgent` (`executeAgent.ts:357-374`)
  at `runAgent.ts:143`; `executeAgent` production callers are
  `nativeSubagentStrategy.ts:241` + `runAgent.ts:143` + the resume path; the rest
  are `test-kernel/` mocks. `agentCreator/` is still one linear `runAgentCreator`
  function (`agentCreator/agentCreatorFlow.ts:378`), one file, no wrapper split.
- **Model handlers.** Unusually well-consolidated and unchanged in shape.
  `IModelHandler = Pick<ModelHandler<…>>` (still an explicit ~50-member allowlist,
  `types/IModelHandler.ts:41-86`); `PROVIDER_HANDLER_ROUTES` still an exhaustive
  `Record<ModelProvider,…>` of 12 lazy `import()`s (`ModelFactory.ts:78-153`);
  `createModelHandler` exactly 3 production callers (`AgentLaunchContext.ts:311`,
  `helperModel.ts:52`, `runToolUseFlow.ts:312`). The 2026-08-08 relocation held:
  `isOReasoningModel` sits on `openai/OpenAICompatibleModelHandler.ts:40` with
  **0** occurrences in the base `ModelHandler.ts` — no provider-identity leak
  returned to the base. `toolConversion.ts` (single tool-format source) and the
  per-provider `*SdkError.ts` taggers (SDK-import isolation) are unchanged.
- **Logger / trace.** The three-rail model holds — run facts on `AgentEvent`
  (`runFactEvents.ts:32-38`; `RUN_FACT_EVENT_TYPES` a frozen 12-arm list
  `satisfies readonly AgentEvent['type'][]` at `events.ts:390-403`), `SessionFact`
  on `SessionEventHub` (docstring explicitly excludes run facts,
  `SessionEventHub.ts:26-63`), app-lifecycle on `AppSignals`
  (`eventBus/AppSignals.ts:10-50`); `SessionHandle.publishRunEvent:794` is the
  documented superset multiplex, not a competing vocabulary. `platform().log`
  remains **0 call sites** repo-wide (the `Platform` interface carries no `log`
  member by design, `platform.ts:29-35`); agent logging flows through
  `createChannelTrace`. **No** stray `bus.emit`/`appSignals.emit` from a VS
  Code-free zone; **no** `default:return` event drop (`SessionFactApplier`
  falls through to `assertNever`, `:179-216`); the in-scope `catch`/`??` sites are
  the sanctioned diagnostic-guard / optional-normalization exceptions, not silent
  degradation.
- **Surface.** `@texra-ai/agent` still mirrors the Anthropic `Query` pattern
  one-for-one — `runAgent(input): AgentRun` (`index.ts:206`), `AgentRun extends
  AsyncIterable<AgentEvent>` + `result`/`interrupt` (`index.ts:69-72`), six-field
  `RunAgentInput` (`index.ts:53-60`), approval-requiring tools refused at the
  boundary (`index.ts:208-216`). Three curated entry points (`.`, `./schemas`,
  `./node` — `package.json:26-39`), all named exports, no `export *`, no barrel
  re-export.

## 2. Subagent boundaries (task step 4) — already designed and shipped

Unchanged. `ChildRunStrategy<TTurn>` (`runtime/childRunLoop.ts:103-198`) unifies
all four child-run types behind the single `startChildRunLoop` driver (`:629`),
consumed by `nativeSubagentStrategy`, `workflowScriptStrategy`, and the agent-CLI
path via `agentCliShared.ts`; its `launch`/`runTurn`/`resolveDeliveryTarget`/
`buildResultMeta` seams _are_ the independent-agent units. Lineage lives on
`ExecutionHandle` (`:202-217`), detach policy is single-sourced
(`detachSubagentsOnStop.ts:17-24`), and `AgentRosterController` (`src/agent/roster/`)
is the multi-agent roster. Nothing new to carve out.

## 3. Baseline re-measurement (the moving numbers, at `ce28f88`)

| Ratchet (`config/ratchets/`)          | 2026-08-10          | HEAD `ce28f88` | Direction |
| ------------------------------------- | ------------------- | -------------- | --------- |
| `host-agent-import` — extension       | 34                  | **34**         | held      |
| `host-agent-import` — cli             | 31                  | **31**         | held      |
| `host-agent-import` — desktop         | 25                  | **25**         | held      |
| `host-agent-import` — agent (SDK pkg) | 10                  | **10**         | frozen    |
| `shared-schemas-deep-import` forced   | 0                   | **0**          | held (drained) |
| `shared-schemas-deep-import` gratuit. | 36 specifiers       | **36 specifiers** | held (mechanical tail) |
| `host-agent-mock`                     | 38                  | **38**         | held      |
| `architecture-edges`                  | 96                  | **96**         | held      |

The north-star's "shrink, never widen" invariant is intact across the board; no
ratchet moved this pass. Boundary hygiene re-confirmed: **0** `vscode` imports
across all declared VS Code-free zones.

## 4. 2026-08-10 open items — reconciled at HEAD

| 08-10 item                                                | Status at `ce28f88`                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| §4.1 — stale `createChannelWriter` docstring              | **Landed as fixed** via `7262d94` (#9936, "logger docs"). `logUtils.ts:1-7` now names the two `channelTrace.ts` callers accurately; no "protocol adapters" claim remains. |
| §4.2 — PT-2 `SessionHandle.useHostInteractions` pass-through | **Unchanged** (`SessionHandle.ts:642`). Still tracked in the tech-debt / SSOT proposals; ~90 call sites, mostly tests. Worth clearing before the SDK surface is frozen. |
| §4.3 — `@shared/schemas` gratuitous rewrite tail          | **Unchanged** (36 specifiers, all `gratuitous`, 0 `forced`). Pure mechanical debt, best done per-specifier in reviewable slices — a decrease, never a widen. |
| §4.4 — `toolCallAccumulator.ts` / `modelHandlerValidation.ts` micro-cleanups | **Unchanged**. Both carry real constraints (`compatibilityKey` session-resume identity; production validation gate). Flag, don't rush. |
| §4.5 — Tier-1 public manifest still absent                | **Unchanged**. De-facto manifest = union of the three entry files. Packaging/strategic work, not abstraction cleanup. |

## 5. Positive delta: the recent sweeps _removed_ indirection

The 26-commit range since `0c6e2b9` is net-negative for abstraction in this scope:

- **#9942 `586ad9b` (Fleet simplification sweep, 46 areas)** removed four shallow
  indirections inside the model handlers alone: the `getClient → createOpenAIClient`
  pass-through (collapsed across `OpenAICompatibleModelHandler` + the `codex`/`xAI`
  overrides), an identity `thinkingLevelConfig` getter and a one-line
  `isBackgroundPending` in `google/modelHandlerGoogleInteractions.ts`, and a
  constant `usageProvider` getter in `openrouter/modelHandlerOpenRouterNative.ts`.
  Grep for newly-added `export function`/`export const` in the touched runtime
  files found none — the sweep only deleted/inlined.
- **#9943 `ce28f88` (delegate_multi_agents deep-clean)** removed the
  `persistChildRunTurnState` delegation wrapper from `childRunDelivery.ts` and
  inlined the direct store call (`childRunLoop.ts:458-470`), and cut
  `workflowControlRegistry.ts` by ~71 lines — **without disturbing any
  `ChildRunStrategy` seam**. The bulk of the change landed in CLI TUI and
  `workflowScript/`, outside the strategy boundary.
- **#9925 `8c188dd`** extracted a shared agent-CLI dispatch skeleton
  (`agentCliShared.ts`) consumed by **two** dispatchers (`claudeAgent.ts`,
  `codex.ts`) — a multi-caller consolidation, net-negative in its callers, not a
  single-caller extraction.
- New model-handler `support/` files (`serverToolResultEmission.ts` 2 callers,
  `mediaClassification.ts` 4 callers) are legitimate multi-caller shared
  extractions, not new debt.

## 6. No code change lands this pass (by design)

Per the maintainer's standing "raise the bar every day" directive, this pass
considered whether to land a verified improvement. **It deliberately does not**,
for the same reason the `-07-22`/`-07-23` checkpoints record: the one zero-risk,
previously-flagged one-liner that existed (§4.1's stale docstring) was **already
fixed** by #9936, and every remaining tracked item is either a large-blast-radius
change (PT-2, ~90 call sites), a mechanical shrink that requires regenerating a
ratchet baseline in the same PR (the `@shared/schemas` tail), or a pre-publish
packaging decision reserved for the maintainer (Tier-1 manifest, type twins).
Landing any of those in an unattended run with no external reviewer would repeat
the precise setup that produced the documented 07-22 revert, with the safety net
removed. Record it, do not apply it.

## Bottom line

Agent core, model handlers, logger/trace, and the package surface remain aligned
with the Agent-SDK direction; the guardrails are holding and the recent
simplification sweeps have _tightened_ the tree (five shallow indirections removed
across #9942/#9943, one previously-flagged docstring corrected via #9936). There
is no unnecessary abstraction to remove beyond the already-tracked PT-2
pass-through and the mechanical `@shared/schemas` tail, and no subagent boundary
to newly design — the `ChildRunStrategy` seams already are the boundaries. The
remaining work continues to belong to the packaging/legal track and the
mechanical deep-import shrink, not to abstraction cleanup.

## Verified (this checkpoint)

- Spine invariants at HEAD `ce28f88`: `src/agent/core/index.ts` **absent** (no
  barrel regression); `IModelHandler = Pick<ModelHandler>`
  (`types/IModelHandler.ts:41`); the `Node.exec → createFlow().run` shape intact
  (`ResponseCycleNode.ts:97,101,108`); `isOReasoningModel` on
  `OpenAICompatibleModelHandler.ts:40`, 0 in base `ModelHandler.ts`.
- Boundary hygiene: **0** `vscode` imports across all declared VS Code-free
  zones (`src/agent`, `model`, `latex`, `tools`, `controllers`, `shared`,
  `replacement`, `eventBus`, `hosts`, `logger`, `platform`); no agnostic-zone
  `bus.emit`/`appSignals.emit` rule violation; no `default:return` event drop.
- Ratchets present and enforcing at held baselines: `host-agent-import` (extension
  34 / cli 31 / desktop 25 / agent 10), `shared-schemas-deep-import` (forced 0 /
  gratuitous 36), `host-agent-mock` 38, `architecture-edges` 96.
- Reconciliation: §4.1 docstring fixed by #9936 (`git log 0c6e2b9..HEAD --
  src/logger/logUtils.ts` = `7262d94`); PT-2 present at `SessionHandle.ts:642`;
  gratuitous tail steady at 36.
- Commit range: `git log 0c6e2b9..HEAD` = **26** commits; `0c6e2b9` confirmed an
  ancestor of `ce28f88`.
- This checkpoint is added under `docs/dev/audits/`, an internal directory
  excluded from the texra.ai publish allowlist — not a root-level doc.

---

_Method: four parallel evidence-gathering passes (agent core, model handlers,
logger/trace, package surface), each required to back every claim with `file:line`
and grep'd caller counts and to state clean areas explicitly rather than invent
problems. Findings cross-checked against the ratchet baselines at HEAD `ce28f88`
and reconciled against the 2026-08-10 checkpoint's open items via `git` history
(#9936, #9942, #9943). No production code was modified._
