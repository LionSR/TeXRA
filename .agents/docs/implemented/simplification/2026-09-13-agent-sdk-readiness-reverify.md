# Agent-SDK readiness — re-verification pass (2026-09-13)

Status: implemented

> **Status.** Re-derived by direct inspection at HEAD `a7cd2ab`
> (`refactor(platform): resolveLatexDir takes FileSystem from context (#12375)`).
> Every fact below carries a `file:line`, config path, or count checked at
> that HEAD. This is the **eleventh consecutive green** (`-08-19` through
> `-09-13`): the structural alignment holds. Unlike the prior ten
> record-only passes, this firing carried an explicit "refactor where
> appropriate / commit and push" mandate, so it **acted on one item** — the
> single genuinely-dead field the model-handler audit surfaced (§4) — and
> recorded everything else. The item was gated green end-to-end before push
> (§5).

## 0. Verdict

**The standing structural verdict holds: no genuinely redundant abstraction
was found to remove, and no speculative refactor is warranted.** Four
independent area audits this pass — agent core, model handler, logger, and
the declared (built, not published) `@texra-ai/agent` package surface — each
re-derived the banned-pattern candidates (pass-through wrappers, convenience
barrels, one-impl interfaces, single-caller extractions, re-export shims) and
each converged on the same finding the prior ten passes recorded: every layer
re-checked is load-bearing, and the removals the ratified direction will make
(PocketFlow node/graph kernel, the `IModelHandler` port) are **consequences of
re-expressing the runtime onto Effect**, not redundant-indirection deletions
available today.

The task's four analytic asks are, in this repo, already institutionalized:

- **Identify the surface areas** (ask 1) — done and *frozen*: the SDK's two
  entries (`@texra-ai/agent`, `@texra-ai/agent/effect`) plus `/schemas` and
  `/node`, enumerated in the Tier-1 manifest
  ([`proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md`](../../proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md)).
- **Audit for unnecessary abstraction** (ask 2) — machine-enforced, not a
  one-off: `eslint.config.mjs` VS Code-free zones + browser-safe allowlist,
  eight shrink-only baselines in `config/ratchets/`, the kernel architecture
  ratchets, and `check:dead-code-ratchet`.
- **Plan / align with SDK patterns** (ask 3) — the ratified Effect-4 program
  (one ledger, two loops, no graph) and its delivery plan already own this.
- **Subagent boundaries** (ask 4) — already first-class (§5b).

## 1. Agent core (`src/agent/core`, `src/agent/runtime`)

`core` is a documented three-module domain model (`definition/state/tools`,
`src/agent/core/README.md`) with a single inward edge (`state → definition`)
and *no* top-level barrel, by design, so edges stay explicit and no re-export
shim survives a move. `runtime` is a deliberately flat ~50-file layer whose
`README.md` is its module map; the README states why splitting it into
subdirectories would be churn disproportionate to a doc change, given the
direct internal import graph. Neither shows a collapsible pass-through layer.

## 2. Model handler (`packages/llm`, `src/agent/runtime/ModelInvoker.ts`, `run/modelBinding.ts`)

The `Model` interface (`packages/llm/src/turn.ts:1622`) is a five-member
executable value — *"it owns neither conversation nor retry policy"* — over a
~1660-line Zod contract (`TurnRequest`/`ResolvedTurn`/`TurnResult`/`TurnEvent`)
that is a genuine single source of truth, consumed by both providers and app.
The three-layer stack is three real responsibilities, each documenting its
seam in prose:

- `modelRoutes.ts` — which credential/endpoint/format (routing SSOT).
- `run/modelBinding.ts` — build the protocol config, construct the `Model`,
  carry the runtime facts the package deliberately does not own (`BoundModel`).
- `ModelInvoker.ts` — *"the one service that touches the llm `Model`"*: billed
  attempts, ledger rows, trace bridging, the two retry owners.

Provider duplication is **low and the shared shape is real**: one
`openaiChatModel` constructor serves seven Chat-Completions-compatible
protocols (`modelBinding.ts` `constructModel`), and cross-cutting helpers
(`completedTurn`, `readerAbortSignal`, `prefixFingerprint`, `openaiError`) are
already at the right seams. Each provider's own SSE/wire parsing is
irreducibly provider-specific. No re-export shim, no `index.ts` barrel.

One cosmetic micro-duplication is recorded but **not** acted on (below the
worthwhile-change bar, and touching five provider files for near-zero payoff):
the one-liner `generateTurn: (turn) => completedTurn(streamTurn(turn))` repeats
across the five providers (`openaiChat.ts:1683`, `anthropicMessages.ts:973`,
`googleInteractions.ts:1072`, `openrouterChat.ts:1249`, `openaiResponses.ts:1431`).

## 3. Logger (`src/logger/`)

A model of restraint: two producers — `Effect.log*` via
`effectDiagnostics`/`effectLog`, and the channel-keyed `logUtils` for
Promise-shaped subsystems — write **one** structured `LogEntry` to **one**
host sink (`logSink.ts`), which redacts once and lets the host render.
`logUtils` documents its own eventual deletion ("deleted with the last caller
that cannot yield an Effect"), and the `createLog` per-call namespace lookup is
a *deliberately* preserved test seam, not accidental indirection
(`logUtils.ts:120-148`). Nothing to remove.

## 4. The one acted item: a write-only `BoundModel` field

`BoundModel` (`src/agent/runtime/run/modelBinding.ts`) mirrored four capability
flags. The audit flagged three (`supportsNativePdf`, `supportsNativeAudio`,
`supportsReasoning`) as write-only. Verification corrected that:

- `supportsNativePdf` and `supportsNativeAudio` are **load-bearing via
  structural typing** — a `BoundModel` is passed where a `MediaCapabilities`
  (`{ supportsVision, supportsNativePdf, supportsNativeAudio }`,
  `run/mediaInput.ts:38`) is required, at four sites
  (`FollowUps.ts:152`, `loop/reflection.ts:505`, `loop/toolUse.ts:362`,
  `loop/toolUseDispatch.ts:858`). `tsc` rejects their removal. They are kept,
  now with a comment naming the coupling the audit had missed. **Lesson for
  future passes: a structural (duck-typed) consumer is invisible to a
  `grep .field` sweep; only the typechecker sees it.**
- `supportsReasoning` **is** genuinely dead on `BoundModel`: every read of that
  name is off `config.capabilities` / `routed.capabilities`, never off a bound
  model, and it is not part of `MediaCapabilities`. Removed from the interface
  and its three construction sites (net −2 lines).

This is the model-handler equivalent of the `-09-11` pass's "MH-1 mechanical
edit": the single genuinely-worthwhile mechanical deletion this pass, serving
the "shrinking the frozen lists" open work — one fewer write-only field.

## 5. Validation of the acted item

Gated green end-to-end before push, at the fresh-clone environment (deps via
`corepack pnpm install`):

- `npm run typecheck:workspace` — green (it is what caught the two
  false-positive removals; the final one-field removal passes).
- `npm run typecheck:llm`, `npm run typecheck:agent` (agent package build +
  artifact/provider-type-leak validation) — green.
- `npx eslint src/agent/runtime/run/modelBinding.ts` — clean.
- `npm run test:changed` — 159 files, 1992 tests passed.
- `npm run test:pure` (architecture ratchets included) — 175 files, 2129
  tests passed. No baseline moved: removing an object field touches none of
  the mechanisms the `effect-migration`, `architecture-edges`, or
  `store-public-surface` ratchets scan.

### 5b. Subagent boundaries (task ask 4) — already first-class

No new split points are proposed; the boundary the ask asks for already
exists and is well-drawn. `src/agent/runtime/childRunLoop.ts` is explicitly
*"one driver for every child-run type"* (agent-CLI codex/claude sessions,
native subagents of either category, workflow-script runs, background shells),
with a per-type `ChildRunStrategy` supplying only what varies and the loop
owning the invariant lifecycle (follow-up queue, one interrupt target,
per-turn delivery, the shared finalizer, and a single cost-accounting
contract). `childRunBudget.ts` bounds per-session concurrency;
`detachSubagentsOnStop.ts` owns the detach-vs-cascade policy. This is the
strategy-over-shared-driver shape the ask points at, already realized.

## 6. Already tracked — do NOT re-propose

Confirmed against `.agents/docs/` and `config/ratchets/` this pass:

- **Tier-1 public manifest** — enumeration exists
  (`2026-09-10-agent-sdk-tier-1-manifest.md`); ratification of what Tier-1
  keeps/seals and the shrinking of the frozen deep-import lists remain the
  named open work (`CLAUDE.md`, `AGENTS.md`).
- **Effect-4 migration + PocketFlow / `IModelHandler` retirement** — ratified;
  delivery plan (`2026-09-06-effect-runtime-delivery-plan.md`) and system
  design (`2026-09-10-effect-native-runtime-system-design.md`) exist.
- **One-run-model / collapse-duplicate-concepts / execution-ownership
  lane-and-lease** — all `proposed` 2026-09-10.
- **Carrier retirement** to shrink `effect-migration` ratchet rows
  (`effectRuntime()` 86, `ambient:asyncLocalStorage` 45 are the big remaining
  surfaces) — `2026-09-10-effect-native-injection-context-pipelines.md`.
- **No new lint rule / ratchet row** — explicitly declined
  (`2026-09-07-promise-boundary-audit.md`; `CLAUDE.md`).

The only genuinely-new headroom outside these is the 213-entry
`knip-baseline.json` dead-code list not already implied by 1.0 shim-deletion —
which this pass nudged by one (§4).
