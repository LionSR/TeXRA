# Agent-SDK readiness — re-verification pass (2026-09-12)

Status: implemented

> **Status.** Re-derived by direct inspection at HEAD `03b7e4a`
> (`refactor(memory): one Effect leaf per memory file operation … (#12317)`,
> 2026-09-12). Every fact below carries a `file:line`, config path, or count
> checked at that HEAD. This is the **eleventh consecutive green**
> (`-08-19` through `-09-12`): the structural alignment holds. Unlike the ten
> prior passes, this one records **two tracked removals actually landing** in
> the window since the [`-09-11` pass](./2026-09-11-agent-sdk-readiness-reverify.md):
> the PocketFlow node/graph kernel is **deleted** (§0, §1), and the production
> run loop now binds the `packages/llm` `Model` rather than a `ModelHandler`
> (§0, §3a). Both were named by prior passes as *consequences of the Effect-4
> re-platform*, not redundant-indirection deletions available on their own —
> and that is exactly how they arrived. Consistent with the routine's default
> (no maintainer request accompanies this scheduled firing) and with the
> standing question's "confirm briefly if already well-aligned" branch, the
> audit is **recorded, not acted on**; the low-risk items §4 surfaces are noted
> for whenever the routine is asked to act.

## 0. Verdict

**The standing structural verdict holds: no genuinely redundant abstraction was
found to remove, and no speculative refactor is warranted.** Four independent
area audits this pass — agent core/runtime, model handlers, logger, and the
declared (built, not published) `@texra-ai/agent` package surface — each
re-derived the banned-pattern candidates (pass-through wrappers, convenience
barrels, one-impl interfaces, single-caller extractions, re-export shims) and
each converged on the same finding the prior ten passes recorded: every layer
re-checked is load-bearing.

**What changed since `-09-11` is the re-platform reaching two milestones the
series has tracked for months, not a reversal of the verdict.** Both arrived as
the runtime was re-expressed onto Effect (runtime lane PR2, #12314), exactly the
route prior passes predicted:

1. **The node/flow engine is gone.** `src/agent/node/` — `index.ts`
   (`BaseNode` + `Flow`), `persistedFlow.ts`, `ExecutionKVStore`, the graph
   cursor — no longer exists. The two run programs are now plain Effect loops
   over the run ledger (`src/agent/runtime/loop/toolUse.ts:1`,
   `reflection.ts:1` both open "one plain Effect loop over the run ledger, no
   cursor and no graph"). Ten passes tracked this kernel at 158 LoC as a
   removal *pending the re-platform*; it landed.
2. **The production run loop binds the `llm` `Model`.** `modelBinding.ts:22-26`
   resolves the concrete provider model from `@llm/anthropicMessages`,
   `@llm/googleInteractions`, `@llm/openaiChat`, `@llm/openaiResponses`,
   `@llm/openrouterChat`, and `ModelInvoker.ts:50` invokes through
   `@llm/turn`'s `Model` (`packages/llm/src/turn.ts:1612`). The `-09-11` pass
   recorded the llm factories as having "no production consumers yet"; the
   agent-execution half of the cutover is now wired on the live run path.

Neither is a redundant-indirection deletion that was available independently;
both are the ratified direction executing. The remaining leanness win is the
same one every pass has named — **finishing** the model-provider cutover so the
old `ModelHandler`/`IModelHandler` stack is deleted wholesale (§3a), not bridged.

## 1. Tracked structural facts re-verify at `03b7e4a`

| Item | Expected (`-09-11` @ `9e44649`) | `03b7e4a` state |
| --- | --- | --- |
| **Node flow engine** | 158 LoC, `BaseNode` + `Flow` only | **Deleted.** `src/agent/node/` directory is gone (no `index.ts`, no `persistedFlow.ts`). Removed by #12314. The run loops are Effect loops over the ledger (`runtime/loop/toolUse.ts:1`, `reflection.ts:1`). A landed delta, not a regression. |
| **`ModelHandler.ts` polymorphic base** | 1,922 LoC | **1,598 LoC** (`wc -l`), **−324** — continued reduction (2,026 → 1,954 → 1,922 → 1,598 across the last four passes) as the run loop moved off the handler stack. Still a cohesive base (`abstract class ModelHandler<…>`, `:184`), now serving chiefly the helper one-shot path. |
| **SDK surface** | 0.41.0, `['.', './schemas', './effect', './node']` | **0.41.0**, same four entries (`packages/agent/package.json`). Provider-type-leak guard (`packages/agent/scripts/validate-artifacts.mjs`) still walks each entry's declaration graph per-entry; the `@texra-ai/agent` surface imports `modelHandlers` zero times. |
| **Dead logger `export`** | none; no logger re-export barrel | **still none** under `src/logger/`; the spine is two producers (`logUtils.ts`, `effectLog.ts`) → one `writeLogEntry` → sink, with one central redaction gate (`logSink.ts:64`). `platform().log` remains absent (`src/platform/platform.ts:34-36`). |
| **`createRunScope` survivor** | 1 production caller | **1 production caller** — definition `src/agent/runtime/RunScope.ts:30`, sole production call `src/agent/runtime/AgentLaunchContext.ts:576` (moved from `:503` as `main` advanced); all other sites are `src/test-kernel/`. Still the one justified single-caller survivor (performs the `Object.freeze` the shared-mutable-literal rule requires). |
| **`-09-11` §4 stray-comment nit** | `// textEnhancement` header at `runtime/index.ts:97` | **resolved.** No `textEnhancement` reference remains in `src/agent/runtime/index.ts`; line 97 is now the live `selectAutoOpenFinalOutput` export. |

No new `export class` / `export function create*` reverses any standing fact.

## 2. Frozen host deep-import width — extension shrank 9→8; others held

`config/ratchets/host-agent-import-baseline.json` (distinct `@agent/*`
deep-import specifiers per package, past the `@agent` barrel):

| Package | `-09-09` | `-09-11` | `03b7e4a` |
| --- | --- | --- | --- |
| cli | 6 | 5 | **5** |
| desktop | 5 | 4 | **4** |
| extension | 9 | 9 | **8** |
| agent (SDK package) | 7 | 7 | **7** |

**extension 9→8** — one more retired deep edge, the direction the set-based
ratchet rewards; no list widened. The two non-door leaf edges the series tracks
persist: `@agent/core/state/runRequests` (CORE-1 below, still the only extension
importer of that deep path) and
`@agent/implementations/agentCreator/agentCreatorFlow`. `agent`'s 7 stays at its
realistic floor, bounded by the provider-type-leak constraint.

## 3. The three standing deliverables — status at HEAD

- **(a) Abstractions to remove — the model-provider cutover crossed its first
  half.** The target shape (`packages/llm`'s uniform `Model`,
  `packages/llm/src/turn.ts:1612`, no generics, provider variance in a config
  discriminated union) is now a **production run-path consumer**, not just a
  tested interface: `modelBinding.ts`/`ModelInvoker.ts` bind and invoke it
  (§0). The old stack recedes accordingly — within `src/agent/runtime/`, only
  `ModelFactory.ts` and `helperModel.ts` still import `modelHandlers`, i.e. the
  helper one-shot path plus launch-context/settings wiring, consistent with the
  [1.0 plan](../../proposed/architecture/2026-09-09-texra-1-0-implementation-plan.md)'s
  retirement boundary ("Old model-handler hierarchy → Retire after both agent
  execution **and helper calls** use the new provider contract"). The leanness
  win remains *completing* the cutover so `Model` replaces
  `ModelHandler`/`IModelHandler` and the ~1,598-LoC base is deleted wholesale —
  not adding a bridge, which would be the pass-through the repo bans. Owner
  unchanged: the Effect-4 migration plan and the 2026-09-06 study cluster.
- **(b) Surface simplification / Tier-1 manifest — unchanged since `-09-11`.**
  The standalone
  [Tier-1 manifest](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)
  (#12200) exists; ratifying what it keeps or seals, and re-enumerating it onto
  the `RunId`/`RunView` vocabulary (it was enumerated before the one-run-model
  S1 rename), remain the open work. The package README still carries the same
  example drift the `-09-11` pass flagged (`StreamView` listed as exported; the
  Effect example uses the removed `Run` members `executionId`/`streamId`), plus
  the new version-pin drift noted in §4.
- **(c) Subagent split points — unchanged owner, shape re-confirmed.** Cleanly
  separable units: the helper-model one-shot cluster (distinct production
  consumers), the result value objects, and `agentCreator`
  (`src/agent/implementations/agentCreator/agentCreatorFlow.ts`) — still the one
  genuine "logical agent not yet running as one," correctly blocked on a
  *public* interactive channel (the package hard-codes `HEADLESS_HOST`,
  `packages/agent/src/effect/sessions.ts:211`, and refuses approval-requiring
  tools via `admitTools`, `:244`). Must **not** be split: the two run loops
  (each a cohesive engine now that the node kernel is gone) and the
  run-orchestration/session core (`runAgent`/`executeAgent`/`SessionHandle`/
  `SessionEvents`). `ChildRunStrategy`/`ChildRunPorts` remain a shipped,
  multi-implementor SPI, not a design task.

## 4. Tracked small-item dispositions at HEAD

Carried forward (open, low value, verified at HEAD):

- **CORE-1 (extension bypasses the `@agent/runtime` door for `runRequests`).**
  `packages/extension/src/progressView/extensionHostRequests.ts:18` still
  deep-imports from `@agent/core/state/runRequests`, the only extension importer
  of that deep path; the curated `@agent/runtime` barrel already re-exports
  those symbols. Repointing the import removes the leaf edge (extension 8→7,
  with the matching removal of the now-stale specifier from
  `host-agent-import-baseline.json` the set-based ratchet requires). Still the
  single genuinely-worthwhile mechanical edit, directly serving the "shrinking
  the frozen lists" open work CLAUDE.md names.
- **MH-2 (provider-SDK type imports in the shared `src/agent/types/` dir).**
  `src/agent/types/ProviderUsage.ts:2-6` still type-imports `@anthropic-ai/sdk`,
  `@google/genai`, `@openrouter/sdk`, and `openai`. Type-only and contained (no
  core-flow consumer; the SDK surface imports `modelHandlers` zero times, so
  nothing leaks today), but relocating `ProviderUsage` under
  `modelHandlers/support/` would keep those provider-SDK type-imports out of the
  shared `types/` dir. Low severity; do only if touching these files anyway.
- **L-1 (two module-logger producers).** `logUtils.ts` (Promise/sync) and
  `effectLog.ts` (Effect) still both express "a module-level, run-less logger,"
  converging on one `writeLogEntry` → sink with one redaction gate. Not
  redundant layering — the split exists because pre-Effect subsystems cannot
  `yield* Effect.log*` (`logUtils.ts` header) — and it collapses naturally as
  subsystems convert. 161 files still depend on `logUtils`; no action this pass.

New this pass (verified, **noted not acted** — mechanical, behavior-preserving):

- **SURF-1 (package README effect version pin is stale).** `#12303` moved the
  Effect family to `4.0.0-rc.115` (`packages/agent/package.json:120,125`), but
  `packages/agent/README.md:26` and its install example at `:32`
  (`"effect": "4.0.0-rc.112"`) still name `rc.112`. A consumer copying the
  README's `dependencies` block pins a version one RC behind the package's peer
  requirement — exactly the "two copies of `effect`" hazard the surrounding
  README paragraph warns against. One-line doc fix; fold into the same README
  update the §3b `StreamView`/`executionId` drift already needs.
- **Dead redaction export (baselined, not new).** `PROVIDER_KEY_REDACTION_RULES`
  (`src/logger/redaction.ts:28`) has no production reader outside its own module
  and one test; it is already carried in `config/ratchets/knip-baseline.json`.
  Could be made module-private (keeping the behavior test against
  `redactSecrets`), but it is tracked headroom, not a defect — leave unless
  touching the file.

## 5. Bottom line

Eleven consecutive passes (`-08-19` through `-09-12`) find a green top-line
verdict. Re-derived at HEAD `03b7e4a`, this is the first pass to record tracked
removals *landing* rather than pending: the node/flow engine is deleted
(#12314) and the production run loop now binds the `packages/llm` `Model`, both
arriving — as every prior pass predicted — as consequences of the Effect-4
re-platform, not as standalone indirection deletions. The model-handler base
continues shrinking (1,922 → 1,598, −324); the logger remains a single-sink
spine with one redaction gate and no `platform().log` port; `createRunScope`
stays the one justified single-caller survivor; the extension deep-import
baseline shrank 9→8 and no list widened; and the `-09-11` stray-comment nit is
resolved. Nothing found is a defect. The open leanness win is unchanged —
*finish* the model-provider cutover and delete the legacy `ModelHandler` stack
wholesale — and the items §4 surfaces are mechanical, behavior-preserving
cleanups noted for whenever the routine is asked to act. Absent a maintainer
request, the audit is recorded, not acted on.
