# Agent-SDK readiness — re-verification pass (2026-09-08)

Status: implemented

> **Status:** Written 2026-09-08 against branch HEAD `13218da`
> (`Merge pull request #12069 … fix/arxiv-download-interruption-repair`). The
> scheduled audit routine re-ran the standing question — "review the agent
> core, model handler, logger, and surface for unnecessary abstraction and
> unready surface; design subagent boundaries" — against the plan of record
> ([`2026-07-09-agent-sdk-north-star.md`](../../archived/architecture/2026-07-09-agent-sdk-north-star.md))
> and the most recent prior pass
> ([`-09-04`](../../archived/simplification/2026-09-04-agent-sdk-readiness-reverify.md),
> whose inspected snapshot was `4579625`, the eighth consecutive green pass).
> This pass re-derived each tracked fact from fresh direct inspection at
> `13218da` — **229 commits** past the prior pass's snapshot — and reached the
> **same top-line verdict: the alignment holds.** Every claim below carries a
> `file:line`, config path, or count checked at `13218da`.

## 0. Verdict

**The standing verdict holds: the codebase is well-aligned with an Agent-SDK
shape, and no structural refactor is warranted.** The pass-through wrappers,
convenience barrels, and single-caller trivial factories the standing question
hunts for are not present. The one trivial single-caller factory the series
tracks remains the same justified survivor — `createRunScope`
(`src/agent/runtime/RunScope.ts:28`, a one-line immutability freeze), still with
exactly **one** production caller (`AgentLaunchContext.ts:565`; all other
`createRunScope(` sites are under `src/test-kernel/`).

This is the **ninth consecutive** green pass (`-08-19` through `-09-08`), and,
consistent with the routine's default (no maintainer request accompanies a
scheduled firing), it is **recorded, not acted on**. The two `-08-25` removals
are the only ones in the series that landed, and only because a follow-up ask
carried them.

The one change in emphasis since `-09-04`: the "abstractions to remove / surface
to simplify / subagent split points" that steps 2–4 of the standing question
call for are **no longer an open blank** — they are now the subject of a fresh,
actively-owned wave of architecture proposals (§4). The re-verification's job
this pass is to confirm the code is still clean *and* to point at that wave
rather than duplicate it.

## 1. The `4579625..13218da` interval — 229 commits, net −19,221, zero new pass-through abstraction

`git rev-list --count 4579625..13218da` = **229 commits**. By subject prefix
(`git log --format='%s'`, non-merge): **61 `refactor`, 43 `fix`, 34 `chore`,
23 `docs`, 13 `feat`, 3 `test`, 3 `style`** — dominated, as ever, by refactor
and fix. The whole-interval diffstat is
`1588 files changed, 104751 insertions(+), 123972 deletions(-)` — **net
−19,221**. The interval is dominated by the Effect-4 runtime migration and the
persistence-substrate cutover landing; both are readiness-positive by
construction (they replace ad-hoc Promise/`AsyncLocalStorage` seams with typed
Effect services at owned boundaries).

**Audited-area touches — none introduces a pass-through abstraction:**

- **`src/agent/**`** net **−694** (5068 ins / 5762 del). The added
  `export class` matches in the interval are all Effect-native, not the
  wrapper/indirection species the question hunts: `ExecutionBusy`
  (`runtime/executionLanes.ts:16`), `RemoteAgentListError`
  (`remote/errorData.ts:10`), and `AgentCatalogLoadError`
  (`index/agentRegistry.ts:43`) are `Data.TaggedError` typed failures — the R1
  destination the promise-boundary audit names — and `AgentExecutionHandle`
  (`runtime/ExecutionHandle.ts:120`) is an execution handle, not a pass-through.
  No `export function create[A-Z]…` factory is added anywhere in `src/agent/**`
  across the interval.
- **`ModelHandler.ts`** touched once, net **−72** (15 ins / 87 del) — down to
  **1954 LoC** (`wc -l`), continuing the steady shrink (2043 → 2030 → 1954 across
  the last three recorded snapshots). Still genuinely shared behavior, no
  per-provider copy-paste.
- **Logger** gained one file: `effectDiagnostics.ts` (+95/0, 95 LoC). It is
  *integration*, not a new layer: it routes Effect's native `Logger`/`Tracer`
  output through the host's existing secret-redacting sink
  (`createLog('Effect')`), honoring debug-mode gating and attribute caps. This
  is the "loud, not silent" principle applied to the framework's own logs, not
  an abstraction to remove. `logUtils.ts` / `redaction.ts` are unchanged from
  `-09-04`.
- **`packages/agent/src/**`** (the published SDK surface) grew the Effect
  boundary the R1 ruling requires: `effect.ts` (+57), `effect/errors.ts` (+48),
  `effect/runtime.ts` (+219), `effect/sessions.ts` (+553) are the
  `@texra-ai/agent/effect` surface; `index.ts` is net **−8** (250 ins / 258 del)
  and remains the Promise-only rim, with its provider-type-leak guard intact
  (`AgentFlowResult` still imported from its own module, not the runtime barrel,
  per the documented `validate-artifacts.mjs` `@anthropic-ai/sdk` check).

## 2. Structural end-state at `13218da` — every tracked invariant holds

| Item | Prior state | `13218da` state |
| ---- | ----------- | --------------- |
| Node flow engine | 158 LoC, `BaseNode` + `Flow` only | **holds.** `src/agent/node/index.ts` = 158 LoC; classes are `BaseNode` (`:30`) and `Flow` (`:134`) only — no `BatchNode`/`ParallelBatchNode`. Matches CLAUDE.md. |
| `IModelHandler` port | derived `Pick<ModelHandler<…>>` | **holds.** `src/agent/types/IModelHandler.ts:36` still a derived `Pick` (78 LoC). |
| Logger de-exports (`-08-25 §8a`, L-3) | `OutputChannelFactoryOptions` internal; `redactSecrets` single-arg | **holds.** `logUtils.ts:49` `interface OutputChannelFactoryOptions` (no `export`, internal use `:191`); `redaction.ts:81` `export function redactSecrets(text: string): string`. |
| `SessionHandle` PT-2 (`-08-25 §8b`) | `useHostInteractions` removed | **holds.** `grep -rn useHostInteractions src/ packages/` → **0** hits. |
| Tier-1 doors | 4 of 8 present | **holds.** `src/agent/{export,review,templates,followUp}/index.ts` all present. |
| Provider-type-leak floor | four SDK message types in `ProviderMessage.ts` | **unchanged.** `ProviderMessage.ts:3-8` imports message types from the host `LanguageModelMessage` port (`:3`) plus `@anthropic-ai/sdk`, `@google/genai`, `openai` (chat + responses), and `@openrouter/sdk` (`:4-8`). Design-gated by the `@texra-ai/llm` extraction (§4), not a defect. |
| Host→`@agent` deep-import baseline | frozen, shrink-only | **shrank.** `config/ratchets/host-agent-import-baseline.json` net −1 over the interval (1 ins / 2 del) — a baseline narrowed, never widened. |
| `@texra-ai/agent` version | 0.40.9 (short of v0.41 gate) | **0.41.0** — the v0.41 retirement gate the prior passes flagged as "not yet due" is now reached; the `runFact.` retirement it gates becomes eligible, but is design-work, not this pass's to act on. |

The ratchet set at `13218da`: `architecture-edges`, `effect-migration`,
`host-agent-import`, `host-agent-mock`, `knip`, `shared-schemas-deep-import`,
and the new `store-public-surface` baseline (the persistence cutover's store
surface). All present; the invariant "never widen a baseline" holds.

## 3. Core / model-handler / logger / surface — area findings

- **Agent core** (`src/agent/`): net deletion over the interval, no new
  pass-through node/flow/factory. The kernel (`node/index.ts`) is still the
  ~150-line local engine CLAUDE.md describes.
- **Model handlers** (`src/agent/modelHandlers/`): one bounded context per
  provider family, shared code at the root, no barrel, still shrinking.
  `IModelHandler` remains a derived `Pick`, deliberately anti-drift.
- **Logger** (`src/logger/`): clean; the one addition is redaction-preserving
  Effect integration, not new surface to trim.
- **Surface** (`packages/agent/src/`): the Promise rim stayed minimal and the
  Effect boundary R1 requires landed beneath it. The published rim adds no
  orchestration logic of its own.

## 4. What steps 2–4 now point to — active proposals, not this pass

The standing question's steps 2–4 (abstractions to remove, surface
simplification, subagent split points) are, as of this interval, under active
design in the `proposed/architecture/` tree (Sept 4–7, one to four days before
this pass). This pass defers to them rather than re-deriving overlapping
findings:

- [`2026-09-05-agent-sdk-architecture.md`](../../proposed/architecture/2026-09-05-agent-sdk-architecture.md)
  — one runtime, explicit ownership, direct consumers; **"introduce no SDK
  orchestration wrapper, second session registry, host projection, persistence
  mirror or generic plugin interpreter."** This is the surface-simplification
  charter; it settles ownership before expanding exports.
- [`2026-09-06-llm-package-architecture-study.md`](../../proposed/architecture/2026-09-06-llm-package-architecture-study.md)
  — extract `@texra-ai/llm` from the useful provider code in
  `modelHandlers/` and **retire `IModelHandler` and its superclass**. This is
  the plan that dissolves the provider-type-leak floor tracked in §2 and the
  `ModelHandler.ts` god-base — i.e. the largest single "abstraction to remove"
  the standing question could name, already owned.
- [`2026-09-06-agent-architecture-review.md`](../../proposed/architecture/2026-09-06-agent-architecture-review.md)
  — keep the reflection pipeline and the tool-use loop as **two first-class
  orchestration programs over shared Effect capabilities**; replace the
  PocketFlow composition machinery, not the programs. This is the
  subagent/program-boundary design (step 4); the delegation/subagent-dispatch
  seam (`ChildRunStrategy`) it builds on is unchanged this interval.
- [`2026-09-07-promise-boundary-audit.md`](../../proposed/architecture/2026-09-07-promise-boundary-audit.md)
  — classifies every production `Effect.tryPromise`/`Effect.promise` as a
  legitimate foreign edge or unconverted Promise surface, aiming the migration
  lanes at the second set. This is the running inventory of "indirection that is
  actually debt vs. an intended edge."

Because these are `proposed/` (nothing committed to) and carry their own source
pins and reproductions, the re-verification neither ratifies nor pre-empts them.
The relevant readiness fact is only that they exist and are moving: the
open work is precisely the Tier-1 public manifest and the shrinking of the
frozen lists that CLAUDE.md names, now with concrete owning proposals.

## 5. Minor cleanup opportunities (non-blocking, not acted on)

Nothing rises to a defect. The only genuinely open, non-design-gated items are
the standing ones, all already tracked elsewhere:

- The four remaining **Tier-1 doors** not yet cut (4 of 8 present, §2) — a
  manifest decision, owned by the SDK-architecture proposal, not a cleanup.
- **`ModelHandler.ts` size** (1954 LoC) — its reduction is the `@texra-ai/llm`
  extraction's job; piecemeal trimming ahead of that risks churn against the
  proposal. Leave it to the owned cutover.
- The **v0.41 `runFact.` retirement gate** is now version-eligible (§2); acting
  on it is a scoped follow-up, not part of a scheduled re-verification.

No independent structural change is warranted this pass.
