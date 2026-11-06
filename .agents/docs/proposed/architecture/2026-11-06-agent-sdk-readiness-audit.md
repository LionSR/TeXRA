---
created: 2026-11-06
status: proposed
---

# Agent SDK readiness: audit of the agent core, model handler, logger, and surface

Baseline: `claude/eager-noether-iprm98` at `4414e70` (branched from `main`).
This is a read-only audit against a standing request to improve "Agent SDK
readiness" by removing unnecessary abstractions, simplifying the API surface,
and naming subagent boundaries.

## Summary

**The codebase is already well-aligned, and the work this request describes is
already in flight under the owner's own design.** The kernel's ten invariants
hold; the known gaps are entries, leaked TeXRA vocabulary, and layout — not
missing structure — and they are costed and scheduled in
[`2026-10-21-harness-general-package-design.md`](./2026-10-21-harness-general-package-design.md)
and the [1.0 release PRD](./2026-10-28-harness-1-release-prd.md). The root
public surface has already shrunk from the 246 exports that design cited to **59
today** (`config/api-reports/harness.api.md`), moving toward its ~30 target.

So this memo does not open a new refactor. It confirms alignment with evidence,
maps the four named areas to the governing designs, answers the subagent-boundary
question (the boundary already exists), and records the one genuinely-new item
— the `claude-agent` route — together with the standing rule that the refuted
candidates in `.agents/docs/refuted-candidates.json` are not to be re-proposed.

A full-tree abstraction sweep would duplicate seven prior audits and risk the
fact-spread, API-report, and crash-point gates with no reviewer present; it
belongs in the reviewed PRs the design already sequences, not in an autonomous
pass.

## The four named areas

### 1. Agent core (`packages/harness/src/agent/`)

Aligned. A run is one Effect program (`runtime/loop/toolUse.ts`) that appends
rows and continues from the `RunState` each append returns; there is no flow
engine, no cursor, no services bag, and one writer of the run history (root
`AGENTS.md` "Agent system", harness `AGENTS.md` "Run loop architecture"). The
run/step/call nesting under `runtime/run/` is thirteen focused files, each a
distinct concern (`invocation.ts` retry, `compaction.ts`, `requestContext.ts`,
`pricing.ts`, …) rather than forwarding layers.

No new abstraction to remove here. The planned moves are **relocations**, not
collapses: the general-package design groups the session-lifetime files into a
`session/` directory and the non-engine built-in tools into `builtins/`
(design §Layout). Those are deferred past 1.0 by the PRD's layout decision,
which keeps the current ten directories.

### 2. Model handler (`ModelInvoker.ts` + `runtime/modelAccess/`)

Aligned, and already the single owner. Every model call goes through
`runtime/ModelInvoker.ts` (the only caller of the `packages/llm` `Model`), bound
by `runtime/modelAccess/ModelAccess.ts`; retries live in the one loop in
`runtime/run/invocation.ts`. `modelAccess/` is five files split by fact — route
decision, binding, credentials, failure info — not by layer. A new provider is
**data, not a handler class** (harness `AGENTS.md` "Agent execution" lists the
~7 touch points, all but the first compile-enforced), so there is no per-provider
wrapper to delete.

The refuted ledger already records that the model-access abstractions were
tested against Effect facilities and kept for stated reasons:
`ModelRetryGate` is a cross-fiber circuit breaker that `Schedule` (per-fiber)
and `effect/persistence` `CircuitBreaker` (wrong backoff semantics) cannot
replace (`EFF-ADOPT-retry-gate-schedule`, `EFF-ADOPT-retry-gate-circuit-breaker`);
the subscription-credential facade was built and closed unmerged as a net-add
(`LLM-subscription-credential-facade`). **Do not re-propose these.**

### 3. Logger (`packages/harness/src/logger/`)

Aligned — this is the cleanest of the four. Five files, 537 lines total. It is
a deep, thin module: one host sink (`logSink.ts` `writeLogEntry`), and
`withLogChannel` (`effectLog.ts`) is a one-line `Effect.annotateLogs` wrapper so
a program names its channel once instead of threading a string through every
helper. Rendering and bounding happen once in the sink, so no producer decides
how much a surface shows. `redaction.ts` is a genuine boundary (provider key
shapes). Nothing here is indirection for its own sake; no change recommended.

### 4. Surface (`index.ts`, `host.ts`, `node.ts`, `plugins.ts`, `schemas.ts`, `transcript`)

This is where the real work is, and it is already well underway. Current export
counts (`config/api-reports/*.api.md`):

| Entry | Exports | Role |
| --- | --- | --- |
| `@texra-ai/harness` (root) | 59 | the embedder surface — was 246, target ~30 |
| `./host` | 171 | the host-only door (TeXRA's editor/desktop/CLI) |
| `./schemas` | 267 | browser-safe schemas + view types |
| `./plugins` | 128 | the authoring closure |
| `./transcript` | 81 | transcript projections |
| `./node` | 51 | Node platform building blocks |

The 246→59 reduction shows the host-only names and internal plumbing the design
flagged have largely been pulled out of the root into `./host`. The remaining
surface simplifications are enumerated in the general-package design (§Public
surface): finish the root at ~30 names, make `./schemas` a named manifest with no
`texra.*` constant, and move presets/teams/icons/quota routes to
`packages/texra/src/host/`. The PRD rejects adding forwarding methods to `Run`
or `Session` — `session.request` stays the one door — so the surface stays flat.

## Subagent boundaries (request step 4)

**The boundary already exists as a first-class concept.** TeXRA already runs
logical units as independent agents through `agent/runtime/delegation/`:

- `AgentTool.ts` — the delegate tool a parent agent calls.
- `inBandSubagentRun.ts` — a durable child in the parent's history.
- `detachedChildRun.ts` — an independent detached child.
- `childRun.ts` / `nativeSubagentStrategy.ts` — the shared child-run driver that
  owns admission, accounting and delivery, with launch options kept in a single
  home (`ChildRunLaunchOptions`) so the two callers can't drift.

Child concurrency is already budgeted
(`.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`),
and peer runs are designed (`2026-10-24-peer-runs.md`). So the "which units
could run as independent agents" question is answered structurally: any agent
definition is launchable as a subagent today.

The genuine *readiness* gap, relative to a general SDK like pi-durable, is not
new boundaries but two capabilities the design already names: **deferred
(tool-search) tools and durable sleep** (general-package design, "Behind
pi-durable"), and the **`claude-agent` model route** below. No new subagent
split is recommended; the mechanism is sound.

## The one new item: the `claude-agent` route

The only literal "Agent SDK" integration is
[`2026-10-31-claude-agent-model-route.md`](../feature/2026-10-31-claude-agent-model-route.md):
running a user's Claude Pro/Max plan as a model route via the Claude Agent SDK.
Its status is **blocked on Anthropic's written approval — nothing is built, and
Phase 0 is the owner asking.** The gate is legal/business, not technical, so it
is not an engineering action to take here. Flagging it for visibility only.

## Minor cleanup opportunities (not blocking, not re-proposals)

These are observations, not a plan; each would need the normal
`find-simplification` / `debt-audit` costing before becoming a PR, and must be
checked against the refuted ledger first:

1. **`texra.` vocabulary in the harness.** The design counts `texra.` on ~100
   lines across 29 harness files (catalog prefix, base prompt's LaTeX-math ask,
   `SettingHost` product list). Injecting it as data is already the design's
   plan; no independent action needed.
2. **llm branding leaks.** `originator: 'texra'`, `X-Title: 'TeXRA.ai'` and OAuth
   referrers in `packages/llm` (design, "llm"). Small and bounded; fold into the
   package's own cleanup.
3. **Twelve Zod-era `.catch` defaults on OAuth token lifetimes** (design, "llm").
   Zod is gone repo-wide; these are silent-degradation candidates (root
   `AGENTS.md` "Silent degradation is a defect") worth confirming against the
   schema-defaults rules when that file is next touched.

## Recommendation

Confirm alignment and continue on the existing design track. No autonomous
refactor is warranted: the kernel is clean, the surface trim is already ~75% of
the way to target, subagent boundaries exist, and the remaining moves are large,
reviewer-gated relocations the owner has already sequenced. The actionable new
signal is a single feature (the `claude-agent` route) that is blocked on an
external approval, not on code.
