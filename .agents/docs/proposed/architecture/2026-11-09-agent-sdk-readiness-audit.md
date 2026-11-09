# Agent SDK readiness: audit of the core, model handler, logger and surface

Date: 2026-11-09
Status: proposed — a read-only audit. It proposes no new refactor; it maps four
requested audit areas to the current tree and to the in-flight design that owns
each, and lists the genuinely open items under "Still open".
Baseline: `main` at `00a6890` (this branch's base). Line and export counts are
read at that tree.

## Why this note exists, and what it is not

The request was to audit the agent core, model handler, logger and surface
areas for Agent-SDK readiness, flag unnecessary abstractions, and propose
simplifications and subagent split points.

The finding is that **Agent-SDK readiness is already an active, well-governed
program on `main`, not an open opportunity.** The general-package surface work,
the 1.0 release, the tech-debt target designs and the one-fact-one-representation
work all target exactly this, and much of each has landed. So this note does the
honest version of the request: it confirms alignment against the tree, names the
owner of each area so nothing here is re-derived, and warns off the one failure
mode an unscoped "remove abstractions" pass would hit — re-proposing a candidate
already refused with evidence.

This note **owns no topic** and adds no `INDEX.md` row; it points at the owners
below. It is deleted once its "Still open" rows are each either owned elsewhere
or closed.

## The owners already in flight

- Surface, layout and ports:
  [`2026-10-21-harness-general-package-design.md`](./2026-10-21-harness-general-package-design.md)
  (nine lanes; lanes 1–4 and most of 3 landed).
- Release gate and format freeze:
  [`2026-10-28-harness-1-release-prd.md`](./2026-10-28-harness-1-release-prd.md).
- Costliest structural debts, as PR slices:
  [`2026-10-27-tech-debt-target-designs.md`](./2026-10-27-tech-debt-target-designs.md)
  ("most slices have landed").
- Fact-spread and representation:
  [`2026-11-03-one-fact-one-representation.md`](./2026-11-03-one-fact-one-representation.md).
- Refused simplifications, as data with evidence:
  `.agents/docs/refuted-candidates.json`.

## Area 1 — Agent core

**Verdict: aligned. No abstraction to remove.**

A run is one Effect program over an append-only row history
(`packages/harness/src/agent/runtime/loop/runLoop.ts`), continued from the
`RunState` each append returns; live and resume are the one function
(`executeAgent`). There is no flow engine, cursor, services bag or second
writer — the harness guide states this as a standing constraint, and the tree
holds it. This is the deep-module, data-as-state shape the SDK wants; there is
no wrapper layer to collapse.

**Subagent boundaries are already a first-class concept, not something to
design.** `packages/harness/src/agent/runtime/delegation/` is the split surface:
the `agent` tool (`AgentTool.ts`) launches a named agent as a child run sharing
the same launch path as a plugin's task tools (`childLaunch.ts`,
`subagentRun.ts`), each child is a run that ends and queues its report on its
parent's input, and `childRunBudget.ts` bounds concurrency. The request's
step 4 ("identify logical units that could run as independent agents") is the
model the harness is built on; a new split mechanism would duplicate it.

## Area 2 — Model handler

**Verdict: aligned. Its candidate simplifications are already refused with
measured evidence; do not re-propose them.**

Every model call goes through one caller of the `packages/llm` `Model`:
`ModelInvoker.invoke` for a billed turn (over the invocation's rows) and
`run/modelCall.ts` for a call off the rows. Routing and credentials in
`agent/runtime/modelAccess/` are generic over `ApiKeyProviderId`, so a new
provider is data, not a handler class (harness guide, "Agent execution").
`ModelInvoker.ts` is large (~934 lines) but is the single owner of turn-retry
accounting read from rows — a deep module, not a pass-through stack.

`.agents/docs/refuted-candidates.json` already records, with reproduction,
why the obvious "lean on Effect primitives" cuts here do not hold:
`ModelRetryGate` onto `Schedule` (per-fiber vs. a cross-fiber breaker), onto the
experimental `CircuitBreaker` (cannot keep the gate's backoff rule — measured
cool-downs differ), and `withPerKeyLane` onto a `Semaphore` (ordering at the
claim step that `RunRegistry` admission relies on). An unscoped audit that
"flags the retry gate and per-key lane as redundant wrappers" would re-propose
exactly these; that re-proposal is the failure the refuted ledger exists to
stop.

The one open model-handler item is owned already: decision D8 in the tech-debt
designs (move or drop `backgroundOn`'s `modelName.startsWith('gpt')` check,
`modelAccess/binding.ts`).

## Area 3 — Logger

**Verdict: aligned. Thin by design, no layer to remove.**

Five files, ~566 lines total (`packages/harness/src/logger/`). The producer-side
helpers are deliberately minimal: `withLogChannel` (`effectLog.ts`, 24 lines)
is a one-line `Effect.annotateLogs` that names a channel once instead of
threading a string through every helper; `logSink.ts` is the single host sink
that renders and bounds a payload once for every surface. This is the
"name-the-channel, one sink" shape the harness guide prescribes. There is no
adapter chain or indirection to collapse — the interface is small over real
behavior.

## Area 4 — Surface areas (the public entries)

**Verdict: substantially landed; the remaining shrink is owned by the
general-package design.**

The root entry is **37 exports** (`config/api-reports/harness.api.md`), down
from the 246 the general-package audit started at, and is Effect-native and
documented (`packages/harness/src/index.ts`): `nothing here calls
Effect.runPromise`. The companion subpaths are the designed set —
`./schemas` (browser-safe), `./transcript`, `./plugins` (the authoring
closure), `./node`, `./host`. The named public nouns (`Sessions`, `Session`,
`Run`, `AgentPlatform`, `ApprovalHandler`, the session errors) match the
design's target list.

The design's own standing decision bears repeating as a guardrail: `Run` and
`Session` get **no methods that only forward to `session.request`** — the one
door stays one door (1.0 PRD, recorded in the general-package note under "Public
surface"). An SDK-ergonomics pass that adds `run.followUp()` / `run.stop()`
convenience methods would reverse a decision already made.

## Still open (minor, each already owned or a one-line referral)

These are the real cleanup items. None is new to this note; each is listed so a
future pass picks the owned one rather than re-opening a settled area.

| Item | Where | Owner |
| ---- | ----- | ----- |
| `sessionViewUpdate.ts` at ~1,120 lines | `packages/harness/src/shared/session/sessionViewUpdate.ts` | general-package note, "Still open" |
| ~350 lines of duplicated lowering across the llm adapters | `packages/llm/src/api/` | general-package note, "Still open" |
| `backgroundOn` provider check placement | `agent/runtime/modelAccess/binding.ts` | tech-debt designs, D8 |
| Four CLAUDE.md rules with no mechanical check (barrel ban, single-caller ban, renderer `Date.now()`, silent degradation outside harness/llm) | repo-wide | general-package note, "Still open" |
| CLI approval stack vs. webview request panels (two renderings of one flow) | `packages/cli` / webviews | general-package note, "Still open" |

For anything above, the standing route is the `find-simplification` or
`debt-audit` skill, which record a dated proposal and check it against the
refuted ledger — not an ad-hoc edit.

## Verified

- Read the harness and root `AGENTS.md` guides and the five proposals above.
- Export count 37: `config/api-reports/harness.api.md` header and
  `packages/harness/src/index.ts`.
- Line counts read at `00a6890`: `ModelInvoker.ts` 934; `logger/` five files
  ~566 total (`effectLog.ts` 24, `logSink.ts` 212); `sessionViewUpdate.ts`
  1,120; `delegation/` present with `AgentTool.ts`, `childLaunch.ts`,
  `subagentRun.ts`, `childRunBudget.ts`.
- `.agents/docs/refuted-candidates.json` holds the `ModelRetryGate` and
  `withPerKeyLane` refusals cited.
- Not run: any build, test, or edit of the audited code. This note changes no
  source.
