# Agent SDK readiness audit

Status: proposed — assessment; recommendations open, none scheduled

Audit of the TeXRA agent core, model handler, logger, and the host↔core
surface for "Agent SDK readiness": how minimal and coherent the public API
surface is, where unnecessary abstraction remains, and where clean subagent
boundaries already exist. Scope was read-only inspection; one zero-risk
cleanup landed alongside this note (see §6). Everything structural is
settled/ratcheted — this note records findings and *proposes* the small,
unfenced cleanups, it does not schedule them.

## Executive summary

The codebase is **already well-aligned for an Agent SDK**. The four target
areas are minimal, intentional, and correctly fenced; the heavy lifting was
done by the 2026-07 simplification campaign and the Effect-4 cutover, and the
guardrails (ESLint zones, `config/ratchets/`, kernel architecture tests) hold
the line. There is no structural de-indirection work outstanding.

The genuine readiness gap is exactly the two items the maintainers already
name (`AGENTS.md` "Directory organization", CLAUDE.md "Layout"):

1. **The Tier-1 public manifest** for the `@texra-ai/agent` surface.
2. **Shrinking the frozen deep-import lists** (`host-agent-import-baseline`).

Both are "not another lint rule." npm publication is deliberately held until a
named external consumer exists. This audit does not re-open any of the
12 refactors already costed-and-refused in `config/ratchets/refuted-candidates.json`.

Beyond those, only three small, unfenced cleanups are worth proposing (§6),
one of which (a dead section marker) landed with this note.

## 1. Surfaces identified

| Area | Public entry point | Verdict |
| --- | --- | --- |
| Agent core (SDK) | `@texra-ai/agent`: `Sessions.layer(platform)` → `Session.start(input) → Run` (`packages/agent/src/effect/sessions.ts:101-152`); `nodePlatform()` (`packages/agent/src/node.ts:57`) | Minimal, Effect-native, curated |
| Agent core (internal cross-host) | `@agent/runtime` barrel (`src/agent/runtime/index.ts`): `runAgent`, `resumeRun`, `Runs`, `SessionHandle`, … "derived from use" | Justified barrel (see §5) |
| Model handler | `interface Model` = `prepareTurn` + `streamTurn` (`packages/llm/src/turn.ts:855-902`); obtained via `bindModel` (`src/agent/runtime/run/modelBinding.ts:904`); invoked via `ModelInvoker` (`src/agent/runtime/ModelInvoker.ts`) | Exemplary |
| Logger | `LogSink` port over Effect's `Logger.formatStructured` record (`src/logger/logSink.ts:31-51`); install via `setLogSink`; use via `Effect.log*` + `withLogChannel` | Clean, correctly fenced |
| Host↔core surface | Repo-root path aliases (`@agent/*`, `@platform/*`, …) + `src/platform/` ports + `installProcessRuntime` once per host | Clean, well-fenced |

## 2. Model handler — exemplary, SDK-ready

- **Minimal contract.** `Model` has two required members (`prepareTurn`,
  `streamTurn`) plus four optional ones served only where the binding provides
  them. No non-streaming member; result-only callers fold the stream with
  `completedTurn` (`turn.ts:905-919`). README states the intent: "A `Model`
  is a configured executable value. It owns the wire … nothing else."
- **Data-driven provider dispatch, zero wrapper classes.** `PROTOCOL_BY_KEY`
  (`modelBinding.ts:165-181`) maps every compatibility key to one of five wire
  protocols; DeepSeek/Kimi/XAI/GLM/DashScope/MiniMax/Meta/OpenAI **all** map to
  `openai-responses`. Per-protocol behavior is one `PROTOCOL_DESCRIPTORS` table
  (`modelBinding.ts:452-665`), vendor differences one `switch` in
  `vendorResponses` (`modelBinding.ts:325-444`). Adding a provider is one config
  arm, not a new class in three switches — the comment at `modelBinding.ts:446`
  notes this replaced three parallel switches.
- **Retry is two orthogonal owners, appropriately.** Route-scoped automatic
  batch under `ModelRetryGate` (cross-fiber, session-shared herd control) and a
  durable human permit (`ModelInvoker.ts:921-1080`, crash-durable ledger state
  machine). Not redundant; merging them would be worse. Cost is concentration
  in a 1268-line `ModelInvoker`, which is intentional SSOT ("the one service
  that touches the llm `Model`").
- **`packages/llm` is cleanly separable.** `effect`/`zod` are peer deps, no
  platform/vscode/registry dependency, five-subpath `exports` boundary. All
  TeXRA-specific concerns (pricing, retry, routing, ledger) live in `src/`.
  Two external implementations of `Model` (`vscode-lm`, `validationModel`)
  prove the seam is real. Ship-externally work is publish plumbing + a product
  decision on the deliberate feature exclusions — no code untangling.
- Only near-zero-value indirection: `constructModel` / `backgroundCapable`
  (`modelBinding.ts:723-739`), thin generic wrappers over the descriptor table
  kept to preserve the `<P extends HttpProtocol>` type relation at the call
  site. Defensible; not worth touching.

## 3. Logger — clean, no readiness work needed

- One host sink port (`LogSink { write; dispose? }`) over Effect's own
  structured record — deliberately not a bespoke type, so level/timestamp/
  fiber/message/cause/annotations/spans stay separate fields the whole way; no
  producer flattens to a line.
- Payload discipline is centralized and order-load-bearing: render `data` once
  (`formatLogData`), then redact, then bound to 2000 chars
  (`logSink.ts:87-126`). Secret redaction happens once at the sink with a
  `satisfies Record<ApiKeyProviderId, …>` table, so shipping a provider without
  a redaction pattern is a compile error (`redaction.ts:28-41`).
- Channel travels as a nesting annotation via `withLogChannel`
  (`src/logger/effectLog.ts:21`), not a string threaded through every helper —
  the main design win.
- Correctly fenced: `architecture-edges-baseline` pins the only outbound edge
  as `logger → shared`; host adapters install through `setLogSink`. The one
  past redundancy (a shared `structuredLogger`) is already inlined into the CLI
  (its only consumer) and recorded in an archived ruling — **do not re-propose
  collapsing** the CLI's local `LogSink` with the shared port.

## 4. Host↔core surface — clean and well-fenced

- Hosts reach core through repo-root path aliases; there is no `@texra/core`
  package (deleted #7099). The seam is a single typed layer: hosts implement
  the `src/platform/` ports, call `installProcessRuntime()` once
  (`src/controllers/session/sessionLayer.ts:1158`), and agnostic code reads
  ~25 services from the Effect context (`ProcessServices`,
  `processRuntime.ts:64-87`).
- Ambient/indirection layers were **already removed**, not pending: the
  `AsyncLocalStorage` roots frame (#12421), the `inScope` tool-I/O wrappers,
  the `Platform` god-object (#12073), the `@texra/core` package (#7099), the
  `RelativeFS`/`StorageFS`/`AbsoluteFS` static classes (#12770).
- Two things a reviewer might flag as indirection are both deliberate and
  documented: `WorkspaceRoots` as plain data carried per-session (not an Effect
  service, so one process holds many rooted sessions), and port members typed
  as `Effect` rather than `Promise` (tagged, composable failures). Neither is a
  readiness gap.

## 5. Agent core — minimal, intentional; structure is settled

- **Two-tier entry is a real tier, not a pass-through.** `runAgent`
  ("START HERE", `runtime/runAgent.ts:101`) mints the runId, registers the run,
  admits it, and owns the terminal/claim/finalize protocol; `executeAgent`
  (`runtime/executeAgent.ts:368`) is the lower tier for callers that already
  own the runId (subagent dispatch, resume). Options are `Pick<…>` + spread so
  they cannot drift.
- **The run loop is one Effect program over the run ledger** — "no cursor and
  no graph" (`loop/toolUse.ts:1-23`). `RunCell` is the single `SynchronizedRef`
  state holder and only ledger writer (`loop/runProgram.ts:42-116`); live path
  and resume are literally the same function because the loop keeps no private
  conversation copy. This is the correctness backbone (uninterruptible
  read-append-write under one lock) and the settled output of the 2026-09-21
  run-loop design doc. **Do not collapse or re-split it.**
- **The `@agent/runtime` barrel is justified**, not a convenience barrel: it is
  "derived from use," nothing inside `src/agent` imports it (no cycle), and it
  is the mechanism that holds `host-agent-import-baseline` deep-import width
  down. `executeAgent` / `resumeToolUseFromResumeData` are intentionally *off*
  the barrel and reached by module path.
- `AgentEngine.ts` (13 lines) is a legitimate type-only cycle-break DI seam
  (delegation tools must not import the implementation) — leave as-is.

## 6. Proposed cleanups (small, unfenced)

None of these are required for SDK readiness; they are marginal tidy-ups.
Ordered by value/risk.

1. **[LANDED with this note] Delete the dead `// RunHandle` section marker**
   in `src/agent/runtime/index.ts` — a leftover marker with no export beneath
   it. Zero risk.
2. **Fold the three helper-model files into one.** `helperModelName.ts`
   (28 lines), `helperModelPreference.ts`, and `helperModel.ts` are one
   cohesive concern split with speculative granularity. Touches ~8 consumers
   (barrel export `getHelperModelName`, `runAgent`, `textEnhancement`,
   `agentCreatorFlow`, `sessionDescription`, `stateSettings`,
   `SettingsModelSelectionController`). Behavior-preserving; would ship as a
   `refactor:` PR with the required Net-elements / Consumer-counts sections.
3. **Drop the `RuntimeTool` / `RuntimeToolRegistry` aliases** in
   `src/agent/runtime/ToolServices.ts:16-17`. `RuntimeTool<E,R>` is a pure
   alias of `ITool<E,R>`, and `executeAgent.ts:7` imports it back as
   `RuntimeTool as ITool` — a rename round-trip. Only the `ToolServices` union
   earns its keep. Removing the aliases and importing `ITool`/`IToolRegistry`
   directly rewires ~12 files; **debatable net win** (12 import sites changed
   to delete two alias lines), so this is recorded for a maintainer decision
   rather than recommended outright.

Explicitly **not** proposed: touching the run loop, run ledger, retry gate,
the two-tier entry, the runtime/followUp barrels, or `AgentEngine` — all
settled and/or ratcheted; landing any change there requires citing the ruling
id with new evidence.

## 7. Subagent boundary candidates

Where "run as an independent agent/service" boundaries already exist cleanly:

- **`src/agent/output/` (documents plugin)** — the strongest candidate.
  `documentRounds.ts` is explicitly designed as a plugin: "It owns the round's
  output state and the compile-rejection facts. It does not own the loop"
  (`output/documentRounds.ts:11-13`); `rounds.ts` consumes it as a
  `ContinuationPolicy`. The whole 17-file dir (XML extraction, latexdiff,
  compileCheck, lineage, outputState) is one cohesive unit — the cleanest seam
  in the system.
- **`src/agent/followUp/`** — already has its own curated barrel; a
  self-contained input-queue/lease boundary.
- **`src/agent/remote/`** (~407 LoC) — a clean external-fetch boundary; a
  natural remote-catalog service.
- **`src/agent/index/`** — the agent catalog (registry, YAML scanner, directory
  service); a cohesive discovery unit already addressed by module path.

Cohesive but too small to warrant a boundary (ceremony would exceed value):
`roster/AgentRosterController.ts`, `implementations/agentCreator/` (already
isolated), `goal/maybeBuildGoalContinuation.ts` (a fold-in candidate, not a
carve-out). `workflowScript/`, `trace/`, `storage/`, `prompt/` are each already
module-path-addressed units.

## 8. What is settled — do not re-propose

From `config/ratchets/refuted-candidates.json` (costed and refused; landing any
needs new evidence + id citation): `ModelRetryGate → Effect Schedule`
(cross-fiber breaker vs. per-fiber Schedule), `EFF-ADOPT-config-provider`,
`EFF-ADOPT-per-key-lane-semaphore`, `EFF-ADOPT-retry-gate-schedule`,
`EFF-ADOPT-timeouts`, `EFF-ADOPT-jitter-helper-stays`, `RT-execute-command-lift`,
`RT-install-cli-process-runtime`, `RT-write-raw-and-wait`,
`RT-corrupt-record-tag`, `RT-desktop-pty-host-effect`,
`SCOPE-held-sessions-as-effects`, `SCOPE-external-roots-standalone-service`.

Settled architecture (fenced): the one-program run loop, the flat runtime
layout (only `run/` + `loop/` subdirs), the "derived from use" runtime barrel,
the two-tier `runAgent`/`executeAgent` split, and the Effect-native SDK surface
(supersedes the old "SDK speaks Promises" rule — do not re-add a Promise
facade). The CLI's inlined logger (do not re-collapse with the shared port).
