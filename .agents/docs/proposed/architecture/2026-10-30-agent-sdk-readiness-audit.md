---
created: 2026-10-30
status: proposed
---

# Agent SDK readiness: verification pass

A re-audit of the four areas an SDK embedder touches — the agent core, the
model handler, the logger, and the public surface — against the goal of making
`@texra-ai/harness` a general, embeddable package.

**Finding in one line:** the harness is already well-aligned. The readiness work
is governed by
[`2026-10-21-harness-general-package-design.md`](./2026-10-21-harness-general-package-design.md),
whose lanes 1 and 3 have substantially landed. This note verifies the current
state with measured numbers and lists what remains. It proposes no new design
and no refactor of its own; the open direction is still that doc's lanes, not
another lint rule.

## What was audited

| Area          | Where it lives                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Agent core    | `packages/harness/src/agent/` — `core/` (domain model), `runtime/loop/` (the one run program), `runtime/run/` (retry/lifecycle) |
| Model handler | `agent/runtime/ModelInvoker.ts` (the only caller of the `packages/llm` `Model`) and `agent/runtime/modelAccess/`                |
| Logger        | `packages/harness/src/logger/` (`effectLog`, `logSink`, `redaction`, `formatLogData`, `effectDiagnostics`)                      |
| Surface       | the entry files (`index.ts`, `node.ts`, `plugins.ts`, `schemas.ts`, `host.ts`, `transcriptEntry.ts`) and `effect/` (the SDK)    |

## Verified current state (at `02bff4c`, 2026-10-30)

| Metric                                            | Design-doc baseline | Now        | Status                               |
| ------------------------------------------------- | ------------------- | ---------- | ------------------------------------ |
| Root (`index.ts`) public exports                  | 246                 | **49**     | Lane 1 landed (`#14337` and after)   |
| Deep imports of harness internals from app/hosts  | 254+ specifiers     | **0**      | Baseline empty for all five packages |
| `texra.` vocabulary references inside the harness  | ~100                | **5**      | Lane 3 landed; the 5 are legitimate  |
| `harness-deep-import-baseline.json` rows           | 501 per-package     | **0**      | All of `cli/desktop/extension/texra/trace-viewer` are `[]` |

The five remaining `texra.` references are all persisted or wire strings that
*must* keep their spelling (AGENTS.md "Plain names and comments"): the
`texra.db` session file name (`controllers/session/Database.ts`,
`projectDatabase.ts`), the stored `texra.endpoint.<id>` settings key
(`shared/state/providerSettings.ts`), two `Symbol.for('texra.*')` error-metadata
keys (`common/errors/sdkError/errorMetadata.ts`), and one user-facing cost
message naming the `texra.goal.maxCostUsd` setting (`tools/plan/goalScript.ts`).
None is a leak to fix.

## Abstractions audited — nothing to remove

The task asked to flag wrapper layers, indirection, and redundant interfaces.
Each candidate below was checked and is **load-bearing, not removable**:

- **`ModelInvoker` over the llm `Model`.** Not a pass-through: it is the single
  write point for the `model.message attempt` / `response` rows, the retry
  budget counted from rows, and the one place `packages/llm` is called. Removing
  it would scatter the durable-write contract. Keep.
- **`modelAccess/` (`ModelAccess`, `binding`, `routeDecision`, `credentials`).**
  Already collapsed to the "no per-provider handler class" shape AGENTS.md
  requires — a provider is a protocol case plus a route, not a subclass. The
  recent `#14406` / `#14439` commits derive availability and model source from
  the route rather than a parallel table. No redundant interface remains.
- **The run loop.** One Effect program (`loop/toolUse.ts`), no flow engine, no
  services bag, state carried as row data. This is the canonical shape; the
  2026-10-21 writer re-check found no near-miss defect.
- **The logger.** Five small files with distinct jobs (channel, sink,
  redaction, formatting, Effect-diagnostics bridge); no forwarding layer.

The surface subpaths confirm the doc's own re-check: `./host` (188 exports) and
`./schemas` (272) stay large *by design* — the forgotten-exports rule keeps
names a consumed signature references, and naming the schemas barrel's members
individually would add ~519 import lines for no gain. Shrinking them further is
the run-lifecycle work in the 1.0 PRD, not a mechanical cut.

## Subagent boundaries — already first-class

The task's step 4 (design subagent split points) is already implemented. The
harness carries explicit delegation boundaries:

- `agent/runtime/delegation/` — `subagentRun.ts`, `inBandSubagentRun.ts`,
  `AgentTool.ts`, `delegationAvailability.ts`
- `agent/runtime/nativeSubagentStrategy.ts` and `subagentResults.ts`
- shared contracts: `shared/schemas/subagentProgress.ts`,
  `shared/subagentFollowup.ts`, `shared/constants/delegationTools.ts`

A child runs in its parent's tool-call fiber with its own run id and its own
input queue (AGENTS.md "Run loop architecture"). No new boundary is needed; the
logical units that could run as independent agents already do.

## Minor cleanup opportunities (not new work items on their own)

These are already tracked as shrink-only ratchets or named in the design doc's
"still open" tail. Listed for completeness, each to be taken only inside a
properly scoped PR with net-element accounting:

- **Large files under the 400-line core cap**, each baselined in
  `config/ratchets/core-quality/file-size.json` and only shrinkable:
  `toolUseDispatch.ts` (1107), `Database.ts` (1064), `childRunLoop.ts` (875),
  `runRegistry.ts` (825), `ModelInvoker.ts` (817), `ExecutionsTool.ts` (792).
  `sessionViewUpdate.ts` (1156) and the llm `anthropicMessages.ts` (700) are the
  two biggest hotspots the design doc already calls out.
- **`./promise` entry** is still absent — correct, per the owner's open question
  ("ship it last; deleting it costs one file").
- **Four CLAUDE.md rules with no automated check** (barrel ban, single-caller
  ban, renderer `Date.now()`, silent degradation outside harness/llm) — noted in
  the design doc as still open.

## Conclusion

No abstraction needs removing and no surface simplification is outstanding that
the governing design doc has not already scoped. The remaining readiness gaps
(`./promise`, host dedup lane 7, publication lane 9) are features and sequencing,
not cleanup. Recommend continuing the existing lanes; this pass opens no new
refactor.
