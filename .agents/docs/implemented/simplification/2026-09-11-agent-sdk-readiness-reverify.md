# Agent-SDK readiness — re-verification pass (2026-09-11)

Status: implemented

> **Status.** Re-derived by direct inspection at HEAD `9e44649`
> (`fix: store enabled models as a delta … (1.0 clean slate) (#12235)`,
> 2026-09-11). Every fact below carries a `file:line`, config path, or count
> checked at that HEAD. This is the **tenth consecutive green**
> (`-08-19` through `-09-11`): the structural alignment holds. Two deltas
> since the [`-09-09` pass](./2026-09-09-agent-sdk-readiness-reverify.md) are
> worth recording — the standalone Tier-1 manifest that pass flagged as "the
> one concrete, low-risk artifact still missing" now **exists** (§3b), and the
> host deep-import baselines **shrank again** on two packages (§2). Consistent
> with the routine's default (no maintainer request accompanies this scheduled
> firing) and with the standing question's own "confirm briefly if already
> well-aligned" branch, the audit is **recorded, not acted on**; the three
> low-risk items §4 surfaces are noted for whenever the routine is asked to act.

## 0. Verdict

**The standing structural verdict holds: no genuinely redundant abstraction was
found to remove, and no speculative refactor is warranted.** Four independent
area audits this pass — agent core, model handlers, logger, and the published
`@texra-ai/agent` surface — each re-derived the banned-pattern candidates
(pass-through wrappers, convenience barrels, one-impl interfaces, single-caller
extractions, re-export shims) and each converged on the same finding the prior
nine passes recorded: every layer re-checked is load-bearing, and the removals
the ratified direction will make (PocketFlow node/graph kernel, the
`IModelHandler` port and its provider-class compatibility) are **consequences
of re-expressing the runtime onto Effect**, not redundant-indirection deletions
available today.

**What changed since `-09-09` is progress along the already-ratified line, not
the verdict.** The Effect-4-native direction deepened: a cluster of `proposed`
architecture notes landed on 2026-09-10 — the
[one run model](../../proposed/architecture/2026-09-10-one-run-model.md)
(superseding the duplicate-concept families),
[collapse-duplicate-concepts](../../proposed/architecture/2026-09-10-collapse-duplicate-concepts.md),
[execution-ownership lane-and-lease](../../proposed/architecture/2026-09-10-execution-ownership-lane-and-lease.md),
[effect-native runtime system design](../../proposed/architecture/2026-09-10-effect-native-runtime-system-design.md),
and [effect-native injection/context/pipelines](../../proposed/architecture/2026-09-10-effect-native-injection-context-pipelines.md) —
and the "1.0 clean slate" commit run (#12235–#12242) continued deleting shims,
dead members, and re-export stubs. None of this reverses a standing fact; the
tracked metrics either held or improved (§1, §2).

## 1. Tracked structural facts re-verify at `9e44649`

| Item | Expected (`-09-09` @ `dff2602`) | `9e44649` state |
| ---- | ------------------------------- | --------------- |
| **Node flow engine** | 158 LoC, `BaseNode` + `Flow` only | **158 LoC** (`src/agent/node/index.ts`); only `class BaseNode` (`:30`) + `class Flow` (`:134`). No `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md. |
| **`ModelHandler.ts` polymorphic base** | 1,954 LoC | **1,922 LoC** (`wc -l`), **−32** — a continued reduction (2,026 → 1,954 → 1,922 across the last three passes), not growth. Still a cohesive base, `abstract class ModelHandler<M,U,T,C,Resp,Media>` (`:184`). |
| **`useHostInteractions` hook** | gone | **still gone.** `grep -rc useHostInteractions src/ packages/` returns zero live hits. |
| **Dead logger `export`** | `OutputChannelFactoryOptions` de-exported | **still gone** (`src/logger/logUtils.ts`); no logger re-export barrel exists. |
| **`createRunScope` survivor** | 1 production caller | **1 production caller** — definition at `src/agent/runtime/RunScope.ts:23`, sole production call at `src/agent/runtime/AgentLaunchContext.ts:503` (moved from `:552` as `main` advanced); all other call sites are `src/test-kernel/`. Still the one justified single-caller survivor (performs the `Object.freeze` the shared-mutable-literal rule requires). |
| **SDK version + surface** | 0.41.0, `['.', './schemas', './effect', './node']` | **0.41.0**, same four entries (`packages/agent/package.json`). Surface unchanged since `-09-09`; the provider-type-leak guard (`packages/agent/scripts/validate-artifacts.mjs`) still walks each entry's declaration graph per-entry. |

No new `export class` / `export function create*` reverses any standing fact.

## 2. Frozen host deep-import width — shrank again on cli and desktop

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package | `-09-04` | `-09-09` | `9e44649` |
| ------- | -------- | -------- | --------- |
| cli | 7 | 6 | **5** |
| desktop | 5 | 5 | **4** |
| extension | 9 | 9 | **9** |
| agent (SDK package) | 7 | 7 | **7** |

**cli 6→5 and desktop 5→4** — two more retired deep imports, the direction the
set-based ratchet rewards; no list widened. `agent`'s 7 stays at its realistic
floor (bounded by the provider-type-leak constraint) and is, by the baseline's
own semantics, "exactly the internal-coupling width a Tier-1 barrel must
re-export or seal." The extension list's two non-door leaf edges persist:
`@agent/core/state/runRequests` (renamed from `executionRequests` by the
run-request-barrel work, #12239, but still a leaf import — see §4 CORE-1) and
`@agent/implementations/agentCreator/agentCreatorFlow`.

## 3. The three standing deliverables — status at HEAD

Per `-09-09` §3, the standing question's three deliverables are owned by
current planning docs rather than re-derived here. Their status this pass:

- **(a) Abstractions to remove** — unchanged owner: the Effect-4 migration PRD
  and delivery plan and the 2026-09-06 study cluster's "what disappears"
  tables. The model-handler audit this pass confirms the target shape already
  exists as `packages/llm`'s uniform `Model` interface
  (`packages/llm/src/turn.ts:1651` — `prepareTurn`/`streamTurn`/`generateTurn`,
  no generics, provider variance pushed into a `ModelConfigurationSchema`
  discriminated union), with **zero production wiring** today (only
  `src/test-kernel/llm/*` and one test consume the factories). The leanness win
  is *completing the cutover* so `Model` replaces `ModelHandler`/`IModelHandler`
  and the legacy base is deleted wholesale — not adding a bridge, which would be
  the pass-through the repo bans.
- **(b) Surface simplification / Tier-1 manifest — the `-09-09` gap is now
  closed, with one caveat.** The standalone
  [Tier-1 manifest](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)
  the `-09-09` pass flagged as "the one concrete, low-risk artifact still
  missing" was **extracted on 2026-09-10** (#12200, `d8e231b`); it enumerates
  all four entries — `/effect` correctly included — 78 export bindings across
  66 distinct names, its actual consumers (external: none; in-repo
  consumer-shaped: one, `packages/agent/example/effectSession.mjs`), and the
  design-gated exclusions (`IModelHandler`, `AgentFinalResult`, a public
  interactive channel). **Caveat: it is already one rename behind code.** It was
  enumerated at `cf88d2d` and names `StreamView`, `ExecutionId`, and
  `ExecutionIdSchema` (§3.1–3.3), but the one-run-model S-step landed in code
  after it (#12206): the package now exports `RunView`
  (`packages/agent/src/effect.ts:31`, `index.ts:76`,
  `effect/sessions.ts:104`), `RunId`, and `RunIdSchema`
  (`packages/agent/src/schemas.ts:38,45`; `effect.ts:51`). This is documentation
  drift, not a code defect — the code is internally consistent — and the
  manifest's own §7.5 already anticipates re-enumeration "when [the re-platform]
  lands." So the deliverable now exists as a `proposed` file; ratifying what it
  keeps or seals, and re-enumerating it onto the `RunId`/`RunView` vocabulary,
  remain the open work.
- **(c) Subagent split points** — unchanged owner (the SDK-architecture doc's
  subagent section, the shipped `ChildRunStrategy` SPI, and the
  execution-interaction-ownership design). The core audit's separability map
  re-confirms the shape: cleanly separable units are the node/flow kernel, the
  helper-model one-shot cluster (four distinct production consumers), the result
  value objects, and `agentCreator`; the tightly-coupled clusters that must
  **not** be split are `runToolUseFlow` (one cohesive ~730-line engine) and the
  run-orchestration/session core (`runAgent`/`executeAgent`/`AgentRunLifecycle`/
  `runRegistry`/`SessionHandle`/`SessionEvents`). `agentCreator`
  (`src/agent/implementations/agentCreator/agentCreatorFlow.ts:433`) stays the
  one genuine "logical agent not yet running as one," still correctly blocked on
  a *public* interactive channel: the package hard-codes `HEADLESS_HOST`
  (`packages/agent/src/effect/sessions.ts:206`, used `:525`) and refuses
  approval-requiring tools, so the boundary is blocked on designing that channel,
  not on un-withholding an existing one.

## 4. Tracked small-item dispositions at HEAD

Carried-forward items:

- **C-3 (fat flow service bags → `Pick`-narrowed cycle services) — carried
  forward, unchanged.** `CycleRunServices`, `ResponseCycleServices`,
  `ToolUseRoundServices` (`src/agent/core/flows/CycleServices.ts:19,26,37`) each
  still `extends BaseFlowContextInit` (`BaseFlowServices.ts:66`, itself
  `extends AgentCore`), so nodes receive the whole launch bag. The `Pick<AgentCore, …>`
  narrowings that model the fix (`ModelInvocationNode`'s `InvocationServices`,
  `saveCycleDebug` at `CommonCycleTypes.ts:93`) are still only in helpers, not
  the node bags. Not a correctness issue; realistically subsumed by the Effect-4
  re-platform that rebuilds these bags. Leave alone.
- **L-1 (two parallel module-logger factories) — open, low value, shrinking.**
  `createLog` (≈**175** production call sites, down from 188 at `-09-09`) and
  `createChannelTrace` (**7**, unchanged) still both express "a module-level,
  run-less logger keyed by name." The logger audit this pass reclassifies the
  standing "platform().log vs @logger" framing as **stale**: there is no
  `platform().log` port (removed; documented absent at
  `src/platform/platform.ts:34-36`), so the tree has *one* logging spine — a
  Promise producer (`logUtils.ts`) and an Effect producer (`effectLog.ts`) that
  converge on one `writeLogEntry` → sink with a single central redaction gate
  (`logSink.ts:64-71`). The only faintly-actionable item is narrowing individual
  log-only `createChannelTrace` callers onto `createLog`, a per-caller change
  largely subsumed by the Effect logging re-platform. No action this pass.
- **Subagent boundary — unchanged.** `ChildRunStrategy` / `ChildRunPorts`
  (`src/agent/runtime/childRunLoop.ts`) remain a shipped, multi-implementor SPI,
  not a design task; `agentCreator` stays correctly open (§3c).

Low-risk items surfaced by this pass (verified, **noted not acted** — each is
mechanical and behavior-preserving, for whenever the routine is asked to act):

- **CORE-1 (extension bypasses the `@agent/runtime` door for symbols the door
  already exports).** `packages/extension/src/progressView/extensionHostRequests.ts:15-18`
  deep-imports `validateRunRequest` and `type RunRequest` from
  `@agent/core/state/runRequests`, while `:14` of the same file imports
  `SessionHandle` from the curated barrel `@agent/runtime` — which already
  re-exports exactly those symbols (`src/agent/runtime/index.ts:138-139`). It is
  the *only* extension importer of that deep path. Repointing the import to
  `@agent/runtime` removes the leaf edge entirely (extension baseline 9→8, with
  a matching removal of the now-stale specifier from
  `host-agent-import-baseline.json` that the set-based ratchet requires in the
  same change) at zero behavior cost. This is the single genuinely-worthwhile
  mechanical edit found this pass, and it directly serves the "shrinking the
  frozen lists" open work CLAUDE.md names.
- **MH-2 (provider-SDK type imports sit in the shared `src/agent/types/` dir).**
  `src/agent/types/ProviderUsage.ts:2-6` type-imports `@anthropic-ai/sdk`,
  `@google/genai`, `openai` (×2), and `@openrouter/sdk` to build
  `ProviderUsage`. Its non-test consumers are `openAIUsage.ts` and
  `modelHandlerOpenAI.ts` (both inside `modelHandlers/`) plus
  `src/agent/types/ModelHandlerContracts.ts` (also in `types/`). The file is
  type-only and already contained (no core-flow consumer; the published
  `@texra-ai/agent` surface imports `modelHandlers` zero times, so nothing leaks
  to the SDK today), but relocating `ProviderUsage` under
  `src/agent/modelHandlers/support/` — moving `ModelHandlerContracts.ts`'s
  dependency with it — would keep five provider-SDK type-imports out of the
  shared `types/` dir and tighten the boundary the provider-type-leak rule
  targets. Low severity; do only if touching these files anyway.
- **Nit.** `src/agent/runtime/index.ts:97` carries a stray `// textEnhancement`
  comment header with no export beneath it — a leftover from when
  `polishTextWithAI` was on the barrel (now consumed directly by its definer).
  Delete the dead comment.

## 5. Bottom line

Ten consecutive passes (`-08-19` through `-09-11`) find a green top-line
verdict, now corroborated by four independent area audits that each looked for
the banned patterns and found none. Re-derived at HEAD `9e44649`: the node
engine holds at 158 LoC; the model-handler base continues shrinking (1,954 →
1,922, −32); the logger is a single-sink spine with one central redaction gate
and the old `platform().log` port already deleted; `createRunScope` stays the
one justified single-caller survivor; and the host deep-import baselines held or
shrank on every package (cli 6→5, desktop 5→4). Two deltas since `-09-09`: the
standalone Tier-1 manifest that pass flagged as missing now exists (#12200) —
though already one `RunId`/`RunView` rename behind code and awaiting ratification
— and the Effect-4-native direction deepened with the 2026-09-10 one-run-model
cluster. Nothing found is a defect; the three items §4 surfaces are mechanical,
behavior-preserving cleanups noted for whenever the routine is asked to act.
Absent a maintainer request, the audit is recorded, not acted on.
