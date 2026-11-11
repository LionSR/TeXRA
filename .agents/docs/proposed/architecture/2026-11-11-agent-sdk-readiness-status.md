---
created: 2026-11-11
status: proposed
---

# Agent SDK readiness: a status check

A scheduled review asked for an SDK-readiness audit of the agent core, the
model handler, the logger and the public surface: flag unnecessary
abstractions, plan a surface simplification, and name subagent boundaries.

The honest finding is that this is not a greenfield audit. SDK readiness is
already the active program on `main`, governed by
[`2026-10-21-harness-general-package-design.md`](./2026-10-21-harness-general-package-design.md)
(seven read-only audits, a four-design comparison, an adversarial judge) and
the [1.0 release PRD](./2026-10-28-harness-1-release-prd.md), and executed
through a coded debt inventory ([tech-debt target designs](./2026-10-27-tech-debt-target-designs.md),
the red-flags rounds). The last thirty commits are almost all `simplify:` /
`refactor:` / `fix:` changes citing those items (R5-8, GS4, E4, E5, O9, …). A
fresh "abstractions to remove" list would duplicate that work and risk
re-proposing candidates already costed and refused in
[`refuted-candidates.json`](../../refuted-candidates.json).

So this note confirms alignment with evidence, maps the four named areas, and
lists only the open items the governing designs already flag. It proposes no
new refactor and no new test (repo default: zero new tests for a review).

## The four areas, as they stand

### Public surface — already narrowed, by design

The package exposes six entries, each with a generated API report under
`config/api-reports/` that gates on diff (`npm run docgen`):

| Entry (`@texra-ai/harness…`) | Exports | Role |
| ---------------------------- | ------- | ---- |
| `` (root, `index.ts`)        | 37      | embedder surface: `Sessions`, `Session`, `Run`, `SessionHost`, `AgentPlatform`, `defineTool`, the session errors |
| `/schemas`                   | 311     | wire + view manifest; an internal barrel kept on purpose (naming its leaves adds ~519 import lines for no caller) |
| `/host`                      | 164     | host-composition only, no stability promise |
| `/plugins`                   | 135     | the authoring closure |
| `/transcript`                | 75      | transcript row model |
| `/node`                      | 50      | the Node default platform |

The root is **37**, down from the **246** the 2026-10-21 audit measured and
below the ~48/59 that design targeted. No app or host `src/` file imports a
harness internal (the 2026-10-28 re-check; `oxlint` plus the deep-import
ratchet hold it). The surface simplification the task asks to "plan" is
substantially done; what remains is narrowing root signatures further, which
is the run-lifecycle work tracked in the 1.0 PRD, not a loose abstraction to
strip.

### Agent core — one program, no engine to remove

The run is one Effect program (`agent/runtime/loop/runLoop.ts`) that appends
rows and continues from the `RunState` each append returns; live and resume are
the same function. There is deliberately no flow engine, cursor, services bag,
or second history writer (`packages/harness/AGENTS.md`, "Run loop
architecture"). `SessionEvents` is the one publisher with three commit doors.
This is the deep-module shape the SDK wants; there is no indirection layer to
collapse here, and the design's own writer-near-miss re-check found no defect.

### Model handler — a single call door, data-driven providers

Every model call goes through `agent/runtime/ModelInvoker.ts` (902 lines) and
the `packages/llm` `Model` bound by `modelAccess/ModelAccess.ts`; a new provider
is data, not a handler class (`AGENTS.md`, "Agent execution" lists the seven
mostly compile-enforced touch points). The retry/breaker machinery
(`ModelRetryGate.ts`) is a cross-fiber circuit breaker whose rewrite onto
Effect `Schedule` or `effect/persistence` `CircuitBreaker` was measured and
refused — the breaker cannot keep the gate's backoff rule
(`refuted-candidates.json`: `EFF-ADOPT-retry-gate-*`). This is not an
abstraction that "doesn't add value"; it is load-bearing with recorded
evidence.

### Logger — already minimal

Five files (`logger/`, ~22 KB): log channels (`effectLog.ts`), the fiberless
sink (`logSink.ts`), key redaction (`redaction.ts`), payload formatting,
Effect diagnostics. Agent flows log through `AgentTrace`; only the one
publication point writes `writeLogEntry`. There is nothing to strip; it already
matches the "structured payloads via `annotateLogs`" SDK pattern.

## Subagent boundaries — an existing capability, not a split to design

The task's "logical units that could run as independent agents" already exist
as a first-class, durable model:

- `agent/runtime/delegation/` — `AgentTool.ts`, `subagentRun.ts`,
  `childLaunch.ts`, `childRun.ts`, `agentChild.ts`, `proposalFlow.ts`,
  `delegationAvailability.ts`, `bashDelivery.ts`, `inputFields.ts`.
- Process children (`agent/runtime/processRun.ts`): a background command or an
  agent-CLI turn runs one turn under `runProcessChild`.
- Peer runs ([`2026-10-24-peer-runs.md`](../../implemented/architecture/2026-10-24-peer-runs.md))
  and the child-run concurrency budget
  ([`2026-08-15-child-run-concurrency-budget.md`](../../implemented/architecture/2026-08-15-child-run-concurrency-budget.md)).

Every child is a run that ends; its `run.end` transaction queues a report on
its parent's input, and a later message is a resume (`AGENTS.md`, "Agent
execution"). The independent-agent boundary is therefore the run itself, and it
is already where the SDK would draw it. No new split point is proposed.

## Open items (already tracked by the governing designs)

These are the real cleanup opportunities, taken from the designs' own
"still open" lists rather than invented here:

1. **~350 lines of duplicated lowering across the llm adapters**
   (`openaiResponsesLower.ts` 338, `anthropicMessages.ts` 681,
   `googleInteractions.ts` 776). Named open in the 2026-10-21 design's closing
   section.
2. **`shared/session/sessionViewUpdate.ts` is large** (1,084 lines; was 1,169
   at audit time — shrinking). A hotspot to keep watching, not to split
   mechanically.
3. **The CLI approval stack versus the webview request panels** — one request
   vocabulary, two renderers; convergence is unfinished (host dedup, lane 7).
4. **Four CLAUDE.md rules with no mechanical check**: the convenience-barrel
   ban, the single-caller-extraction ban, renderer `Date.now()`, and silent
   degradation outside the harness and llm. These are conventions a reviewer
   must hold by hand; a future check could arm them.

## Do-not-re-mine

Before proposing any of the following, read its ruling; each was costed and
refused with evidence (`refuted-candidates.json`): the platform config
providers onto Effect `ConfigProvider` (`EFF-ADOPT-config-provider`);
`withPerKeyLane` onto a `Semaphore` (`EFF-ADOPT-per-key-lane-semaphore`);
`ModelRetryGate` onto `Schedule` or `CircuitBreaker`
(`EFF-ADOPT-retry-gate-*`); the stdio MCP client onto `effect/ai` `McpClient`
(`EFF-ADOPT-mcp-client`); a `./promise` entry (the 2026-09-21 Effect-only
ruling holds).

## Verified

- Read `main` at `2f63e5a`. Export counts from the headers of
  `config/api-reports/*.api.md`. File sizes from `wc -l` over the cited paths.
- Delegation and llm-adapter files listed exist under
  `packages/harness/src/agent/runtime/delegation/` and `packages/llm/src/api/`.
- Governing designs read: the 2026-10-21 general-package design (including its
  2026-10-28 re-check), `packages/harness/AGENTS.md`, and the refuted-candidates
  registry.
- Not run: any build or test; this is a read-only status check.
