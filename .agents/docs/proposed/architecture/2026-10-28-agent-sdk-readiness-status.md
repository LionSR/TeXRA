---
created: 2026-10-28
status: proposed
---

# Agent SDK readiness: status against the two in-flight designs

Baseline: `main` at `4993684` (2026-10-28). This note audits where the
Agent-SDK-readiness work stands today. It proposes no new design: the two
designs below already cover the agent core, model handler, logger, surface
area, abstraction removal, and the plugin/subagent boundary, and this note
records which of their moves have landed and which are still open.

- [The harness as a general package](./2026-10-21-harness-general-package-design.md)
  (the surface-and-two-moves design; baselined at `08455c8`).
- [Target designs for the ten costliest tech debts](./2026-10-27-tech-debt-target-designs.md)
  (baselined at `d8a4f66`).

## Why this is a status note, not a new audit

A fresh pass over the four named areas (agent core, model handler, logger,
surface) reaches the same diagnosis the 2026-10-21 design already states: the
rooms are right and the doors were wrong. The kernel's invariants hold; the gap
was the package around it — what the entries export, how much TeXRA vocabulary
the harness carried, and a layout that split one concept across directories.
Re-deriving that would repeat work already done to a higher standard, so this
note only measures progress and names what remains. The four areas map onto the
designs as follows:

| Task area        | Where it lives                                                                                                   | Owning design                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Agent core       | `agent/runtime/loop/` (one program, no graph), `agent/core/`                                                     | general-package §Layout; tech-debt §1, §7         |
| Model handler    | `agent/runtime/ModelInvoker.ts` (817 lines), `agent/runtime/modelAccess/`, `packages/llm`                        | general-package "Behind our own design"; tech-debt §6 |
| Logger           | `packages/harness/src/logger/` (`effectLog`, `logSink`, `formatLogData`, `redaction`, `effectDiagnostics`)       | general-package Lane 2 (foundation order)          |
| Surface area     | root `index.ts` and the five subpaths                                                                            | general-package Lanes 1, 3; tech-debt §5           |

## Landed since the designs were written (verified at `4993684`)

The headline surface simplification is **done**. The root entry
(`packages/harness/src/index.ts`) is now the ~30-name embedder surface the
general-package design specified — `Sessions`, `Session`, `Run`, `StartInput`,
`ResumeInput`, `OpenOptions`, `SessionHost`, `ApprovalHandler`, the view and
event types, `defineTool`, and the tagged errors — with host-only names moved
behind a new `./host` subpath. `package.json` now exports exactly the proposed
set: `.`, `./schemas`, `./transcript`, `./plugins`, `./node`, `./host`.

| Move                                                                 | Design item                     | PR            |
| -------------------------------------------------------------------- | ------------------------------- | ------------- |
| Root shrunk to embedder surface; host names to `./host`              | general-package Lane 1 (doors)  | #14337        |
| Tech-debt survey + target designs + first "one owner per fact" slices | tech-debt §2 (S-slices start)   | #14335        |
| `AppSignals` becomes a process `Context.Service`                     | general-package V8; tech-debt §5 | #14347        |
| TeXRA bundled agent names leave the harness; teams/agents served from entry | general-package Lane 3 / V2 | #14320, #14304 |
| Erasable TypeScript repo-wide ("pi's compiler contract")             | SDK compiler alignment          | #14344        |
| Remove GitHub Copilot support (the `copilotRouting.ts` the design flagged) | general-package cleanup   | #14296        |
| API references generated; `/api/` philosophy guides + runnable examples | general-package Lane 9        | #14295, #14332 |

## Still open (structurally absent at `4993684`)

These are the design moves not yet reflected in the tree — the concrete
remaining cleanup surface:

- **`effect/` → `sdk/` rename** (general-package Lane 1 tail). Still
  `effect/processLayer.ts`; the design wants `sdk/`.
- **Foundation-order moves** (Lane 2). Logger is still at
  `packages/harness/src/logger/`, not `platform/logger/`; `eventBus` and
  `types` likewise not yet under `platform/`.
- **Session consolidation** (Lane 2b). No `session/` directory yet — the
  session plane still spans `controllers/session`, `shared/session`, and the
  session-lifetime files in `agent/runtime` (the six same-basename pairs the
  design calls out). This lane is explicitly sequenced *after* the race-fix
  work because it collides with the two most-edited files.
- **Built-ins fence** (Lane 4b). No `builtins/` directory; `defineBuiltinPlugin`
  not yet deleted. This is the main *subagent-boundary* move still pending (see
  below).
- **Ports** (Lane 5): Storage as an Effect `SqlClient`, the Execution pair, the
  `Clock`/`wakeAt` durable-sleep port, the neutral `SessionHost`. `wakeAt` is a
  row change and must land before the storage freeze.
- **Host dedup** (Lane 7), **`./promise` entry** (Lane 8), **publish + spec**
  (Lane 9 tail).
- **Model handler / llm** (tech-debt §6): `ModelInvoker.ts` at 817 lines; the
  six background-capability owners; `enrichModelError`/`fillModelError` dual;
  `resolveTurn` consolidation; the wire-test mechanisms.

## Subagent boundaries (task step 4)

The subagent machinery already exists and is coherent — it does not need a new
boundary designed, it needs the *public* one finished. Logical units that run
as independent agents today live in `packages/harness/src/tools/delegation/`:
`AgentTool`, `childRun`/`detachedChildRun`, `inBandSubagentRun`, `subagentRun`,
`proposalFlow`, with child-run concurrency governed per the
[child-run budget](../../implemented/architecture/2026-08-15-child-run-concurrency-budget.md)
and the [one-run model](../../implemented/architecture/2026-09-10-one-run-model.md)
(a child runs in its parent's tool-call fiber). The open work is the
general-package design's plugin contract: make `Continuation` take a public
`RunPark` (run id, state, can-continue, ask) instead of the internal
`SessionHandle`, make `recipeOf(block)` public, and move every built-in except
the engine tools into `builtins/` behind the import fence. That turns "a
subagent boundary" from an internal seam into a contract an external embedder
can write against — which is the actual SDK-readiness ask.

## Recommendation

No autonomous refactor is warranted from here. The remaining moves carry open
owner decisions (the general-package design's four owner questions; tech-debt
decisions D1–D10), are sequenced against in-flight PRs and the storage freeze,
and touch a deliberately frozen boundary where the standing rule is "never
widen a baseline." The next concrete, low-risk steps — each already specified —
are the pre-freeze tech-debt slices (S0, S2 with D4/D5 decided) and the
pre-publish vocabulary slices (V1, V2, V5, V8, V9), in the order their sections
give. Execution should stay PR-per-lane with the owner resolving the listed
decisions, not a single sweep.

## Verified

- Read `main` at `4993684`. Confirmed against the tree: root `index.ts` is the
  ~30-name surface; `package.json` exports `.`, `./schemas`, `./transcript`,
  `./plugins`, `./node`, `./host`. Confirmed still-pending by absence of
  `src/sdk/`, `src/platform/logger/`, `src/session/`, and `src/builtins/`, and
  by `effect/processLayer.ts` still being the process owner.
- Landed-PR attributions read from `git log` subjects since 2026-10-21 (50
  commits); PR numbers are those subjects' own, not re-fetched from GitHub.
- Line counts: `ModelInvoker.ts` 817, `modelAccess/` 5 files / 1,102 lines,
  `logger/` 5 files. Delegation directory listed (10 files).
- Not run: any build or test. This note changes no code.
