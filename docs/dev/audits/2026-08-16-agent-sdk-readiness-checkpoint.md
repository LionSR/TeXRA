---
created: 2026-08-16
---

# Agent-SDK readiness re-check (agent core · model handler · logger · surface)

> **Status:** Audit note. Written 2026-08-16 at HEAD `25fe7d3`, every moving
> figure re-measured against the checked-in `config/ratchets/` baselines and the
> four architecture ratchet suites run green. This is a _current-state_
> re-measurement, not a new plan. It continues the near-daily checkpoint series —
> read alongside the immediately prior
> [`2026-08-10-agent-sdk-readiness-checkpoint.md`](./2026-08-10-agent-sdk-readiness-checkpoint.md)
> and the base audit
> [`2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
> under the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md).
> Its job is to confirm whether the standing conclusions still hold and to record
> what has landed since 2026-08-10. Nothing here overrides a maintainer ruling,
> reopens the retired TD-2(a) / package-fence / `ModelCell` proposals, or proposes
> splitting the deliberately-flat `runtime/` directory.

## Verdict

**Well-aligned. No structural refactor is warranted, and none was made.** The
four named areas — agent core, model handler, logger, and the `@texra-ai/agent`
package surface — remain converged on the Claude-Agent-SDK shape. The
`config/ratchets/` guardrails and the free-zone import fence are holding: all
four architecture ratchet suites are green at HEAD (22 tests, run below), and the
host `@agent/*` deep-import ratchet _tightened again today_ (§2). Two of the
minor items the 2026-08-10 checkpoint left open have since **landed** — the B1
shared-schemas deep-import drain (§3-1) and the stale `createChannelWriter`
docstring fix (§3-2). The abstractions this task asks us to hunt for are, once
again, load-bearing boundaries; the residue is down to two constrained
model-handler micro-cleanups and one tracked pass-through, none blocking.
Re-deriving the full argument here would duplicate ~26 prior docs; this note pins
the current numbers and the reconciliation.

## 1. Area confirmations (fresh evidence at `25fe7d3`)

- **Agent core.** Launch stays single-entry: `runAgent`
  (`src/agent/runtime/runAgent.ts`) assigns the `executionId` and registers the
  run; `executeAgent` is the lower-level path for callers that already own the id
  (subagent dispatch, resume). The split is intentional and documented in
  `src/agent/runtime/README.md`, not a pass-through wrapper. The local flow
  engine (`src/agent/node/index.ts`, ~250 LoC) remains the sole
  `BaseNode`/`Node`/`Flow` definition — no upstream-PocketFlow layer to collapse.
  No wrapper-only forwarder found.
- **Model handlers.** `abstract class ModelHandler` with one concrete
  implementation per provider family (`anthropic/`, `google/`, `openai/` + the
  OpenAI-compatible ladder, `openrouter/`, `vscodelm/`) — genuine provider
  polymorphism, not a redundant interface over a single implementation.
  `ModelFactory.PROVIDER_HANDLER_ROUTES` (`src/agent/runtime/ModelFactory.ts:79`)
  is still an exhaustive `Record<ModelProvider, …>` of lazy `import()`s that keeps
  every provider SDK out of the eager graph — the seam that already makes each
  provider directory extraction-ready. Keep as-is.
- **Logger / trace.** The tier separation holds: `platform().log` remains **0
  call sites under `src/agent`** (agent logging flows through `createChannelTrace`
  / `@logger/logUtils`, the intended host-agnostic path). The file-level
  `logUtils.ts` docstring flagged stale on 2026-08-10 now correctly names
  `channelTrace.ts` (§3-2).
- **Surface.** `@texra-ai/agent` still mirrors the Anthropic `Query` pattern
  one-for-one: a single `runAgent(input: RunAgentInput): AgentRun`
  (`packages/agent/src/index.ts:70,86`), `AgentRun extends
  AsyncIterable<AgentEvent>` with `result` + `interrupt()`, and a six-field
  `RunAgentInput` (`platform`, `agent`, `instruction`, `interactions`, optional
  `model`/`tools`). Three curated entry points, no `export *`, no barrel
  re-export. Unchanged.

## 2. Baseline re-measurement (at `25fe7d3`)

The host `@agent/*` deep-import ratchet
(`config/ratchets/host-agent-import-baseline.json`) counts **distinct top-level
`@agent/*` specifiers** reachable from each package (the set the vitest at
`src/test-kernel/architecture/hostAgentDeepImportRatchet.vitest.ts` enforces).
Live sets equal the checked-in baseline at HEAD, so the ratchet is green:

| Package (host)          | before #10712 | HEAD `25fe7d3` | Direction        |
| ----------------------- | ------------- | -------------- | ---------------- |
| extension               | 14            | **13**         | ↓ (−1 today)     |
| cli                     | 13            | **12**         | ↓ (−1 today)     |
| desktop                 | 11            | **10**         | ↓ (−1 today)     |
| agent (SDK pkg itself)  | 7             | **7**          | held             |

The one-per-host drop landed today via `ceba494` (#10712, "fold AgentConfig host
imports behind `@agent/runtime`"), on top of `dbcc87b` (#10650, which folded
`@agent/followUp` deep-imports behind a `followUp` barrel and introduced the
`runtime`/`followUp`/`storage` barrel index files). The north-star's "shrink,
never widen" invariant is intact and actively exercised.

The other three architecture ratchets are green at HEAD (suites run below):
`host-agent-mock`, `shared-schemas-deep-import`, and `architecture-edges`
(subsystem edges). Exact tallies for those three are best read from the baseline
files themselves rather than pinned here, since the count depends on the
class/leaf convention each file uses.

> **Measurement note for readers comparing to 2026-08-10.** The 08-10 table's
> `host-agent-import` figures (extension 34 / cli 31 / desktop 25 / agent 10)
> are a broader statement-reach count and are **not directly comparable** to the
> distinct-specifier ratchet reported here (which has stood in the low-teens
> range; the baseline file's per-host arrays are the ground truth). Both agree on
> direction — shrinking — and both are green. The pre-2026-08-16 baseline state
> is not reachable from this branch's collapsed history, so this note reports the
> two in-branch baseline commits (#10650, #10712) rather than asserting an
> unverifiable numeric delta against `0c6e2b9`.

## 3. 2026-08-10 minor items — reconciled at HEAD

| 08-10 item                                          | Status at `25fe7d3`                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.3 `@shared/schemas` gratuitous rewrite tail (36 specifiers / ~394 stmt / 302 files) | **Landed / drained** via `#10609` (B1, "empty the shared-schemas deep-import baseline") + `#10689`. `config/ratchets/shared-schemas-deep-import-baseline.json` now has `forced: {}` and `gratuitous: {}` both empty; only the single documented cycle **floor** remains — `@shared/schemas/log` ← `src/logger/logUtils.ts`, the exact deep import `logUtils.ts` annotates in its own comment. |
| §4.1 stale `createChannelWriter` docstring          | **Fixed.** The file-level JSDoc at `src/logger/logUtils.ts:5` now reads "Channel-trace infrastructure and callers in `src/agent/trace/channelTrace.ts` use `createChannelWriter`," not "Protocol adapters use `createChannelWriter`." No separate cosmetic PR was needed — it rode in with the schema/ratchet work. |
| §4.2 PT-2 `SessionHandle.useHostInteractions` pass-through | **Unchanged / still tracked.** Present at `src/agent/runtime/SessionHandle.ts:853`, still consumed by the package (`packages/agent/src/index.ts`). Worth clearing before the SDK surface is frozen; the churn is mostly tests. Not urgent, not executed here.                                     |
| §4.4a `utils/toolCallAccumulator.ts` inline candidate | **Unchanged.** Still single-consumer (`src/agent/modelHandlers/utils/channelStreamAggregator.ts`). Carries the real `compatibilityKey` session-resume identity constraint — flag, don't rush.                                                                                                       |
| §4.4b `modelHandlerValidation.ts` relocate/rename   | **Unchanged.** Still present (335 LoC, embedded hard-coded answers, named like a validation utility). Production-shipped validation gate — flag, don't rush.                                                                                                                                          |
| §4.5 / §3-D Tier-1 public manifest + public-contract `AgentEvent`↔`@shared/schemas` coupling | **Unchanged — strategic, maintainer-owned.** The de-facto manifest is still the union of the three entry files; declaring the manifest and sealing the SDK package's own 7-wide `@agent/*` seam behind it is packaging work, not abstraction cleanup. |

## 4. Subagent boundaries (task step 4) — already designed and shipped

Nothing to newly carve out; the "logical units that could run as independent
agents" already exist as first-class runtime concepts: `executeAgent` +
`childRunLoop` (subagent dispatch under an owned execution),
`AgentRosterController` (`src/agent/roster/`, the multi-agent roster), and the
`ChildRunStrategy` seams under `src/tools/delegation/` (`nativeSubagentStrategy`,
`workflowScriptStrategy`, `inBandSubagentExecution`, `detachedChildRun`).
`detachSubagentsOnStop` / `resumeQueuedToolUse` handle the lifecycle/resume. The
delegation _tools_ remain the closure that pulls in the heaviest import graph —
the real packaging seam for a multi-agent SDK, already tracked as a product-line
decision, not a boundary to invent here.

## 5. Guardrail verification (run at HEAD)

```
$ npx vitest run \
    src/test-kernel/architecture/hostAgentDeepImportRatchet.vitest.ts \
    src/test-kernel/architecture/hostAgentMockRatchet.vitest.ts
  Test Files  2 passed (2)   Tests  12 passed (12)

$ npx vitest run \
    src/test-kernel/architecture/sharedSchemasDeepImportRatchet.vitest.ts \
    src/test-kernel/architecture/subsystemEdgeRatchet.vitest.ts
  Test Files  2 passed (2)   Tests  10 passed (10)
```

## 6. Bottom line

Agent core, model handlers, logger/trace, and the package surface remain aligned
with the Agent-SDK direction; the guardrails are holding and, where measured,
still tightening (the host deep-import ratchet dropped one specifier per host
today via #10712, and the `shared-schemas` `forced`/`gratuitous` buckets have
drained to empty via #10609/#10689). There is no unnecessary abstraction to
remove beyond the already-tracked PT-2 pass-through and the two constrained
model-handler micro-cleanups, and no subagent boundary to newly design — the
`ChildRunStrategy` seams already are the boundaries. The remaining work continues
to belong to the packaging/legal track and the Tier-1 manifest, not to
abstraction cleanup.

---

_Method: read the plan-of-record and the two most-recent prior checkpoints
(2026-08-08, 2026-08-10), then re-measured each named area at HEAD `25fe7d3` with
`file:line` citations, grep'd caller counts, and the checked-in ratchet
baselines. Every "landed / drained / fixed" claim is backed by the current file
state plus the `git` commit that changed it (#10609, #10650, #10689, #10712). The
four architecture ratchet suites were run green. No production code was modified._
