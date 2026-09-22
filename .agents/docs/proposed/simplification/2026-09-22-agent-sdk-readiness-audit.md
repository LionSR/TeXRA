# Agent SDK readiness audit: core, model handler, logger, surface

Date: 2026-09-22
Status: proposed
Baseline: `claude/eager-noether-41eghs` off `main` at `281b9ac`.

Scope: an audit, requested as "review and refactor for Agent SDK readiness",
of the four areas named — the agent core, the model handler, the logger, and
the SDK surface. It flags abstractions to remove, surface simplifications, and
subagent split points. The conclusion is that these areas are already
well-aligned and, more to the point, already under an active, machine-enforced
simplification program: the net-new findings a fresh pass produces here are
nil, and the genuine open items are the ones existing dated proposals already
own. This note records that so the same ground is not re-mined, and points each
area at its governing artifact rather than restating it.

## 1. Method

Read, not inferred from docs: `packages/agent/src/{index,node,schemas}.ts` and
`packages/agent/src/effect/{sessions,runtime,sessionPrograms}.ts` (the whole
published surface, ~1 200 lines); `src/agent/core/README.md` and
`src/agent/runtime/README.md` with `ModelInvoker.ts`; `src/model/` (30 files,
~3 000 lines) and `packages/llm/src/` (~10 750 lines); `src/logger/` (6 files,
597 lines). Cross-checked against `config/ratchets/` and the `proposed/`
proposal stream.

## 2. What is already governed (do not re-propose)

The repository does not merely happen to be clean here; it enforces cleanliness
as a ratchet and records refused refactors as data. Any "remove this wrapper /
adopt this SDK facility" proposal must be checked against these first:

- **`config/ratchets/refuted-candidates.json`** — refactors investigated,
  costed and *refused*, each pinned to a symbol signature and a ruling anchor,
  double-gated (a pure-tier suite pins the signature; a CI workflow fails a PR
  that touches a refused symbol without citing the candidate id). It already
  holds, among others: adopting an Effect `ConfigProvider` over the platform
  config port (`EFF-ADOPT-config-provider`), `withPerKeyLane` onto a Semaphore
  (`EFF-ADOPT-per-key-lane-semaphore`), `ModelRetryGate` onto `Schedule`
  (`EFF-ADOPT-retry-gate-schedule`), and several "lift this wrapper into one
  round trip" candidates (`RT-*`). These are exactly the shapes a generic
  "audit for unnecessary abstraction" pass surfaces — and they were refused on
  stated evidence, not overlooked.
- **The freeze ratchets** — `host-agent-import-baseline`, `host-agent-mock`,
  `architecture-edges`, `effect-migration`, `store-public-surface`,
  `file-size-baseline`, `unknown-error-baseline`, plus the kernel architecture
  suites (`sharedSchemasDeepImportRatchet`, `dependencyDirection`, …). The
  invariant is "never widen a baseline". A speculative refactor that adds an
  abstraction to "align with SDK patterns" fails one of these by construction.
- **The live proposal stream** — six simplification proposals dated
  2026-09-20 alone (`effect-facility-adoption`, `tools-and-schema-surface-collapse`,
  `host-layer-collapse`, `run-program-and-dispatch-dedup`,
  `service-scope-ownership-ledger`, `global-database-process-service`). The
  open surface-reduction work is already mapped and costed there.

Consequence for this task: the responsible output is an audit, not an
autonomous code change. Landing a refactor here means citing (or refuting) one
of the above in a PR body a human signs off — the governance model is designed
to require exactly that, and it is not satisfiable by a scheduled routine with
no reviewer.

## 3. Area findings

### 3.1 SDK surface — `@texra-ai/agent` (aligned)

The published surface is deliberately minimal and single-entry: `Sessions.layer(platform)`
is the only way in (composition root and session factory stay internal by
design), the whole package is stated in Effect with no `runPromise`/`runFork`
inside it, and `index.ts` is the one barrel the "no convenience barrels" rule
exempts because it *is* the documented public surface. Every export carries a
rationale comment, including why `AgentFlowResult` is sourced from its own
module (declaration-emit leak of provider types through the barrel, checked by
`scripts/validate-artifacts.mjs`). `node.ts` gives embedders a clean default
platform; `schemas.ts` is a flat, intentional re-export set. There is no
wrapper layer to remove here — this is the reference for what "SDK-ready" looks
like, not a target for it.

One point worth a maintainer's note, not a change: the package still lists
`@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` as runtime deps. That
is correct — `claude-agent-sdk` backs the `claudeAgent` *tool*
(`src/tools/claudeAgent.ts`), not the surface — but it is the reason the
provider-type leak check exists, so keep that check green when the surface
changes.

### 3.2 Agent core — `src/agent/core` + `src/agent/runtime` (aligned)

`core/` is three concern-named modules (`definition/`, `state/`, `tools/`) with
one internal edge (`state → definition`) and no top-level barrel by design.
`runtime/` is documented as a flat ~50-file layer with a README module map and
an explicit, self-limiting rule for when a group earns a subdirectory
("a refactor already touching the whole group") — which is how `run/` and
`loop/` came to exist. The run itself is **one Effect program over a ledger**,
with "there is no flow engine" stated as an invariant (no node, cursor, or
second ledger writer). This is already collapsed past the point a generic audit
would push it to.

### 3.3 Model handler — `ModelInvoker` + `run/modelBinding` + `packages/llm` (aligned)

There is a single service that touches the llm `Model` (`ModelInvoker.invoke` =
one invocation with its billed attempts) and one binding path (`bindModel`), with
the helper paths (`helperModel`, `agentCreatorFlow`, `textConnection`) routed
through that same bind. Retry has two clearly-owned lanes (route-scoped gate,
durable human permit) rather than scattered ad-hoc retries. The `src/model/`
files are many but each is a distinct routing/capability decision
(provider capabilities, subscription routing, endpoint selection), not
pass-through indirection. The tempting "simplify retry onto `Schedule`" move is
already refuted (`EFF-ADOPT-retry-gate-schedule`: the gate is a cross-fiber
circuit breaker, `Schedule` is per-fiber).

### 3.4 Logger — `src/logger` (aligned, smallest surface)

Six files, 597 lines: an Effect log bridge (`effectLog`, `effectDiagnostics`),
a sink (`logSink`), formatting (`formatLogData`, `logUtils`) and `redaction`.
No wrapper tiers, no redundant interface. Nothing to remove.

## 4. Genuine open items (already owned elsewhere — cross-references, not new work)

These are the only real simplification candidates the four areas touch, and
both are already documented and costed:

1. **Two pure pass-through layers in the tool-call path** — `core/define.ts`
   (27 lines that only re-type `defineTool`) and the `execute` forwarder in
   `core/definition.ts`. Owned by
   `2026-09-20-tools-and-schema-surface-collapse.md` §1 ("The tool-call path").
   This is the one concrete "abstraction to remove" that touches the SDK
   surface (`defineTool`/`DefinedToolClass` are public exports), so it is worth
   sequencing that proposal's tool-path row before any 1.0 surface freeze.
2. **Schema-barrel UI bloat** — ~3.5k of the 9.5k-line `@shared/schemas` barrel
   is view-message/state code, not wire contracts, and it rides into every
   closure including webviews. Owned by the same proposal §1 ("The barrel").
   Relevant to SDK readiness only indirectly (a published consumer pulls the
   barrel's `.d.ts` graph), but that is the mechanism the provider-type leak
   check already guards.

## 5. Subagent boundaries

The requested "identify logical units that could run as independent agents" is
already realized as a first-class subsystem, not a latent split point:
`childRunLoop` (single driver for every child-run type), `childRunBudget`
(per-session concurrency budget), `runRoster`/`detachSubagentsOnStop`
(liveness and detach-vs-cascade policy), and `nativeSubagentStrategy` in
`src/tools`. The `claudeAgent` tool additionally spins off an external
Claude Code agent via `@anthropic-ai/claude-agent-sdk`. No new boundary is
warranted; the existing budget/detach/roster contract is the reason a naive
"split these into agents" change would regress stop-safety (cf. the recent
`#12442` fix refusing child admission once a parent's stop has folded).

## 6. Recommendation

Confirm alignment; take no autonomous code change. If a maintainer wants to act
on §4, do it through the owning proposals under the normal ratchet-cited PR
flow, not as an "SDK-readiness" refactor. The single item with a direct SDK-
surface bearing is the tool-path pass-through collapse (§4.1); everything else
named in the task is already at or past its simplification floor.
