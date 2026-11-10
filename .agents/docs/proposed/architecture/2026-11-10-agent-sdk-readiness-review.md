---
created: 2026-11-10
status: proposed
---

# Agent SDK readiness: current-state review

Baseline: `main` at `8281784`, read on the designated branch. This is a
snapshot audit of how ready `@texra-ai/harness` is as a general Agent SDK,
across the four areas a readiness review names — the agent core, the model
handler, the logger, and the public surface — plus where logical subagent
boundaries already sit. It does not re-derive the governing plan; it confirms
where that plan has landed and lists what is verifiably still open.

The authoritative design is
[`2026-10-21-harness-general-package-design.md`](./2026-10-21-harness-general-package-design.md)
("the harness as a general package"), sequenced by
[`2026-10-28-harness-1-release-prd.md`](./2026-10-28-harness-1-release-prd.md).
This note is a dated check against those, not a competing design.

## Verdict

The codebase is already aligned. The premise a readiness review usually starts
from — handler-class indirection, a leaky surface, undefined subagent
boundaries — does not hold here. The four areas each show a deliberate, small
interface over much behavior, and the misalignments that did exist were
inventoried a month ago and are being closed on a weekly cadence (the
`simplify:` / `refactor:` commit stream against the lettered debt taxonomy, e.g.
`#14876`, `#14874`, `#14861`, `#14890`). No sweeping refactor is warranted, and
none is proposed here.

What follows records the evidence per area and the small, already-tracked items
that remain, so a later reader can answer "is the SDK surface ready?" without
re-auditing the tree.

## Area 1 — Public surface (SDK entries)

Aligned. The root entry `packages/harness/src/index.ts` is a curated ~48-name
Effect-only surface: every export carries purpose JSDoc, the module header
states the embedding sequence (`Sessions.layer` → `open` → `start`/`resume` →
`attach`) and states the contract plainly ("The surface is Effect: nothing here
calls `Effect.runPromise`"). Companion subpaths are split by audience —
`./schemas` and `./transcript` are browser-safe, `./plugins` is the authoring
closure, `./node` is the Node platform, `./host` is host composition. Each
entry has an api-report under `config/api-reports/` gated by
`scripts/check-api-report.mjs`, so the surface cannot drift silently.

This is the single biggest readiness move and it already landed: the root went
from 246 exports to the curated set (design doc, deletion ledger; re-check
2026-10-28 records 48). No abstraction to remove here.

- **Open (tracked, not new):** `./host` carries host-composition names with no
  stability promise; its only guard is the api-report diff. The design's owner
  question 2 settled on keeping it as a subpath and shrinking it as host imports
  shrink — a slow drip, not a blocker.

## Area 2 — Model handler

Aligned, and already SDK-shaped. A new provider is **data, not a handler
class** (harness `AGENTS.md`, "Agent execution"): the routes and API-key
credentials in `agent/runtime/modelAccess/` are generic over
`ApiKeyProviderId`, and adding a provider touches a list of data sites, all but
the first compile-enforced. There is no per-provider handler hierarchy to
collapse.

The two model-call paths are the documented contract, not redundant
indirection: `ModelInvoker.invoke` is the turn loop over an invocation's rows
(retry decided from committed rows), and `callModel` in `run/modelCall.ts` is
the off-the-rows call for compaction/helper summaries (`Effect.retry`, no row
written). The split is intentional and named in `AGENTS.md` ("Two loops, one
per kind of call").

`modelAccess/` is cleanly factored by concern — `routeDecision.ts` (admit /
refuse a switch), `binding.ts`, `credentials.ts`, `ModelAccess.ts`,
`failureInfo.ts` — with no pass-through layer between them and the llm `Model`.

- **Open (tracked, not new):** `ModelInvoker.ts` is 930 lines. It is a single
  owner with one responsibility (the turn retry loop), so this is size, not
  indirection; splitting it mechanically would violate the repo's own "never
  split a file mechanically" guard. Leave unless a concrete second reader
  appears. Separately, the design's "Still open" section notes ~350 lines of
  duplicated lowering across the llm adapters (`packages/llm`), which is the
  real model-layer dedup target, not the handler.

## Area 3 — Logger

Aligned. Five small files, 566 lines total
(`logger/{effectLog,effectDiagnostics,formatLogData,logSink,redaction}.ts`).
The shape is one sink (`writeLogEntry` in `logSink.ts`) with a single
channel-annotation API (`withLogChannel`, 24 lines) that producers name once
per program rather than threading a channel string through every helper. That
is a deep-enough module — a one-line interface over "render and bound every
host surface's log detail in one place" — not a wrapper to remove. `redaction.ts`
is the one owner of provider-key redaction, which a new provider extends (point
4 of the provider checklist). No shallow indirection found.

- **Open:** none specific to readiness.

## Area 4 — Agent core / run loop

Aligned. The core invariant is already the one an SDK wants: a run is **one
Effect program** (`agent/runtime/loop/runLoop.ts`) that appends rows and
continues from the `RunState` each append returns, so live and resume are the
same function. There is no flow engine, no cursor, no services bag, and one
publisher of session rows. These are exactly the properties that made the
"writer core is clean" finding in the governing audit; re-reads since have found
no surviving writer defect (design doc, lane 4 re-check).

- **Open (tracked, not new):** `shared/session/sessionViewUpdate.ts` is 1120
  lines (down from 1169 at the audit baseline) — the largest single fold file.
  Noted in the design's "Still open"; a known hotspot, not an abstraction
  defect.

## Subagent boundaries

The boundaries a reader would "design as independent agents" already exist as
first-class runtime concepts — nothing new needs carving:

- **Native children** run one cycle under `executeAgent`; **process children**
  (a background command, an agent CLI's turn) run one turn under
  `runProcessChild` (`agent/runtime/processRun.ts`). Both end by queueing a
  report onto the parent's input and resuming it (`AGENTS.md`, "Agent
  execution"). This *is* the subagent model.
- **Delegation** (`agent/runtime/delegation/`) is the launch path for a child
  run with its own grants (`delegatedChildGrants`).
- **Plugins** are the extension boundary; the design's lane 4b unified every
  built-in onto the one `ITool` contract reading the session off the engine
  door (`RunCallShape.session`, `#14546`), with a `builtins/` lint fence
  reserved for a named external embedder.

The agent-CLI tools (`packages/texra/src/tools/claudeAgent.ts`, `codex.ts`)
are the concrete case of "run an independent agent as a subagent" and already
work through `ChildRuns.launchProcess`. No further split point is needed for
readiness; the open subagent-adjacent work is the deferred-tools feature
(`defineTool({ deferred: true })`, design lane 5), which is additive.

## What not to do

- **No sweeping refactor.** Every area is deliberate; the remaining items are
  tracked and sized, and the repo closes them one focused PR at a time.
- **Do not split `ModelInvoker.ts` or `sessionViewUpdate.ts` mechanically.**
  Both are single owners; size is not indirection.
- **Do not add a Promise entry or a second surface.** The 2026-09-21 ruling
  (Effect-only public surface) holds; `./promise` is a settled refusal.

## Still open (consolidated, all pre-existing)

1. `./host` subpath has no stability promise beyond its api-report diff.
2. ~350 lines of duplicated lowering across the `packages/llm` adapters.
3. `sessionViewUpdate.ts` at 1120 lines.
4. Four `AGENTS.md` rules with no mechanical check (barrel ban, single-caller
   ban, renderer `Date.now()`, silent degradation outside harness and llm).

Each already appears in the governing design's "Still open" section or its open
lanes. This review adds no new work item; it confirms the surface is ready and
the backlog is the right one.

## Verified

- Read `index.ts` (full), `effect/` (7 files), `logger/` (5 files),
  `agent/runtime/ModelInvoker.ts`, `run/modelCall.ts`, `modelAccess/` (5 files),
  and the harness `AGENTS.md` against `main` at `8281784`.
- Export-surface and size claims measured directly (root entry export list;
  `wc -l` on the cited files; `config/api-reports/` present for every entry).
- Landed-state claims cross-checked against
  `2026-10-21-harness-general-package-design.md` (deletion ledger, lanes,
  2026-10-28 re-check) rather than re-derived.
- Not run: any build, test, or prototype.
