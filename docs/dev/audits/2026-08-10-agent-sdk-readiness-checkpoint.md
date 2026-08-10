---
created: 2026-08-10
---

# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-10 at HEAD `0c6e2b9` from four parallel
> evidence passes (agent core, model handlers, logger/trace, package surface),
> every claim backed by `file:line` and grep'd caller counts. This is a
> _current-state_ re-measurement, not a new plan. It continues the near-daily
> checkpoint series — read alongside the immediately prior
> [`2026-08-08-agent-sdk-readiness-checkpoint.md`](./2026-08-08-agent-sdk-readiness-checkpoint.md)
> and the base audit
> [`2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
> under the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Its job is to confirm whether the standing conclusions still hold and to
> record what has landed since 2026-08-08. Nothing here overrides a maintainer
> ruling, reopens the retired TD-2(a) / package-fence / `ModelCell` proposals, or
> proposes splitting the deliberately-flat `runtime/` directory.

## Verdict

**Well-aligned. No structural refactor is warranted, and none was made.** The
four named areas remain converged on the Claude-Agent-SDK shape; the
`config/ratchets/` guardrails and the free-zone import fence are holding and, in
two measured dimensions, have _tightened_ since 2026-08-08. This re-check
reproduces the standing conclusion of the `-05-29 → -08-08` chain with fresh
citations and confirms that **two of the four `§3` deltas the 2026-08-08
checkpoint named have since landed** (§3-B barrel-publish, §3-D comment fix).
The abstractions this task asks us to hunt for are, once again, load-bearing
boundaries — the only fresh item is one stale docstring (§4.1). Re-deriving the
full argument here would duplicate ~25 prior docs; this note pins the current
numbers and the reconciliation.

## 1. Area confirmations (fresh evidence at `0c6e2b9`)

- **Agent core.** Launch is single-entry and the four-level launch/resume
  layering is justified, not pass-through — production caller counts
  `runAgent` 7 (`src/agent/runtime/runAgent.ts:73`), `executeAgent` 2
  (`:380`), `resumeToolUseFromResumeData` 3 (`executeAgent.ts:506`),
  `resumeQueuedToolUseFromResumeData` 3 (`resumeQueuedToolUse.ts:75`); each
  level owns distinct executionId / lease / lineage semantics. The local flow
  engine (`src/agent/node/index.ts`, ~250 LoC) is the sole `BaseNode`/`Node`/
  `Flow` definition and every override hook has ≥1 real override — no dead
  machinery, no upstream layer to collapse. The only near-duplication in scope
  — `AgentFlowResult` vs `AgentFinalResult` — is purposeful (internal runtime
  result vs the stable post-artifact SDK result) and DRY-linked by `.pick`/
  `.extend` schema derivation, not copy-paste. No wrapper-only forwarder found.
- **Model handlers.** Unusually well-consolidated. `toolConversion.ts` (620 LoC)
  is the single provider tool-format source; usage normalization is
  config-driven via `support/UsageNormalizer`; the per-provider `*SdkError.ts`
  taggers are deliberate SDK-import isolation (`ModelHandler.ts:118-124`), not
  removable wrappers; the OpenAI-compatible inheritance ladder is thin with real
  quirks per concrete class. `ModelFactory.PROVIDER_HANDLER_ROUTES` is an
  exhaustive `Record<ModelProvider,…>` of lazy `import()`s that keeps every
  provider SDK out of the eager graph — the seam that already makes each
  provider dir extraction-ready. Every remaining `#7101`-annotated base
  predicate was verified to diverge from the nearest capability read.
- **Logger / trace.** The three-rail model holds — run facts on `AgentEvent`
  (trace SSoT), `SessionFact` on `SessionEventHub`, app-lifecycle on
  `AppSignals` — with the hub a documented superset multiplex of trace events +
  session facts (`SessionHandle.publishRunEvent:794`), not a competing
  vocabulary. `platform().log` remains **0 call sites** repo-wide (matches only
  docs); agent logging flows through `createChannelTrace` (34 callers) and
  `@logger/logUtils`. No `default: return` event drops; the in-scope `catch {}`
  blocks are the sanctioned diagnostic-guard exception.
- **Surface.** `@texra-ai/agent` still mirrors the Anthropic `Query` pattern
  one-for-one (`runAgent(input): AgentRun`, `AgentRun extends
  AsyncIterable<AgentEvent>` + `result`/`interrupt`, six-field `RunAgentInput`).
  Three curated entry points (`.`, `./schemas`, `./node`), no `export *`, no
  barrel re-export. The `import X as Y` aliasing in `index.ts` is genuine
  boundary translation (the package redeclares its own minimal `HostInteractions`
  and owns the public streaming `runAgent`), not a smell.

## 2. Baseline re-measurement (the moving numbers, at `0c6e2b9`)

| Ratchet (`config/ratchets/`)          | 2026-08-08                | HEAD `0c6e2b9`                          | Direction |
| ------------------------------------- | ------------------------- | --------------------------------------- | --------- |
| `host-agent-import` — extension       | 34                        | **34**                                  | held      |
| `host-agent-import` — cli             | 31                        | **31**                                  | held      |
| `host-agent-import` — desktop         | 25                        | **25**                                  | held      |
| `host-agent-import` — agent (SDK pkg) | 10 (newly added §3-A)     | **10**                                  | frozen    |
| `shared-schemas-deep-import` forced   | 10 specifiers / ~182 stmt | **0** — barrel-published (#9899)        | ↓ retired |
| `shared-schemas-deep-import` gratuit. | —                         | **36 specifiers / ~394 stmt / 302 files** | mechanical tail |
| `host-agent-mock`                     | 38                        | **38**                                  | held      |
| `architecture-edges`                  | 96                        | **96**                                  | held      |

Against the 2026-08-04 review's 39/32/25, the host deep-import width has held at
its lowered 34/31/25 — the north-star's "shrink, never widen" invariant is
intact. The one material change is the `shared-schemas` **`forced` bucket
draining to 0**: see §3.

## 3. 2026-08-08 §3 deltas — reconciled at HEAD

| 08-08 item                                              | Status at `0c6e2b9`                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| §3-A — ratchet the SDK package's `@agent/*` width       | **Landed** (in the 08-08 PR). `agent: 10` is a scanned, frozen member of `host-agent-import`.           |
| §3-B — `@shared/schemas` `forced` barrel shrink         | **Barrel-publish half landed** via `80be67e` (#9899): `forced` 10 → **0**; debt reclassified to the mechanical `gratuitous` rewrite tail (§4.3). |
| §3-C — relocate `isOReasoningModel` off the core base   | **Landed** (in the 08-08 PR). Now on `OpenAICompatibleModelHandler`.                                     |
| §3-D — stale `DomainEvent` `missingOutputs` comment      | **Landed** via `1758fa7` (#9898, "clarify domain event run-fact carve-out"). Comment absent at HEAD; the six `RunFactEvent` arms stay first-class discriminants by design (`RUN_FACT_EVENT_TYPES` / `SessionFactApplier` depend on them). |

The one real, still-open sub-item under §3-D is unchanged: several public
`AgentEvent` arms tie their shape to internal `@shared/schemas` host types
(`RunConfigEvent.config: AgentConfig`, `StatusEvent`), which a published `.d.ts`
would drag along — a public-contract call reserved for the maintainer, not a
refactor.

## 4. Fresh / still-open minor items (small, non-urgent, none blocking)

1. **`createChannelWriter` carries a stale docstring — NEW (cosmetic).**
   `src/logger/logUtils.ts:135` claims "Protocol adapters use
   `createChannelWriter`," but there are **no protocol adapters left**: its only
   two production callers are both inside `channelTrace.ts` (`:34`, `:57`). Fix
   is a one-line comment correction (or acknowledge it as a single-module seam),
   not an inline — the two call sites are distinct (`createChannelTrace` vs
   `attachChannelSubscriber`). Flag, not executed, per the series' flag-then-
   focused-PR discipline.
2. **PT-2 `SessionHandle.useHostInteractions` per-concern pass-through** — still
   present (`SessionHandle.ts:642`), still tracked in the tech-debt / SSOT
   proposals, still used by the package itself (`packages/agent/src/index.ts`).
   Worth clearing before the SDK surface is frozen; ~90 call sites, mostly tests.
   Unchanged since 08-08.
3. **`@shared/schemas` gratuitous rewrite tail** — 36 specifiers / ~394
   statements / 302 files, now all `gratuitous` (0 forced), i.e. mechanically
   rewritable to the `@shared/schemas` barrel with no barrel change. Hot spots:
   `toolResult`, `settingsViewMessages`, `agent`. Pure mechanical debt, best done
   per-specifier in reviewable slices — a decrease, never a widen.
4. **Two constrained model-handler micro-cleanups.** `utils/toolCallAccumulator.ts`
   (single consumer, `channelStreamAggregator.ts:17`) could inline; the
   `modelHandlerValidation.ts` mock (334 LoC with embedded hard-coded answers,
   named like a validation utility) could relocate/rename. Both carry real
   constraints (`compatibilityKey` session-resume identity; production-shipped
   validation gate) — flag, don't rush.
5. **Tier-1 public manifest still does not exist.** The de-facto manifest is the
   union of the three entry files; `CLAUDE.md`'s named open item (declare the
   manifest, seal the SDK package's own 10-wide `@agent/*` seam behind it)
   remains the strategic work — packaging, not abstraction cleanup.

## 5. Bottom line

Agent core, model handlers, logger/trace, and the package surface remain aligned
with the Agent-SDK direction; the guardrails are holding and, where measured,
still tightening (the `shared-schemas` `forced` bucket drained to 0 since
2026-08-08). Two of the four 08-08 `§3` deltas have landed (§3-B barrel-publish
via #9899, §3-D comment via #9898); §3-A and §3-C landed in the 08-08 PR itself.
There is no unnecessary abstraction to remove beyond the already-tracked PT-2
pass-through and one stale docstring (§4.1), and no subagent boundary to newly
design — the `ChildRunStrategy` seams already are the boundaries. The remaining
work continues to belong to the packaging/legal track and the mechanical
`@shared/schemas` / deep-import shrink, not to abstraction cleanup.

---

_Method: four parallel evidence-gathering passes (agent core, model handlers,
logger/trace, package surface), each required to back every claim with
`file:line` and grep'd caller counts and to state clean areas explicitly rather
than invent problems. Findings cross-checked against the ratchet baselines at
HEAD `0c6e2b9` and reconciled against the 2026-08-08 checkpoint's `§3` deltas via
`git` history (#9898, #9899). No production code was modified._
