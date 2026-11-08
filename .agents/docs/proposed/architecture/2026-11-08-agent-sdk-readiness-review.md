---
created: 2026-11-08
status: review
---

# Agent SDK readiness: review of the agent core, model handler, logger and surface

Baseline: `claude/eager-noether-qusn2e` at `157f775` (main `b5e28fb`). This is a
**confirmation review**, not a new proposal. It audits the four areas named in
the request — the agent core, the model handler, the logger, and the public
surface — against the "unnecessary abstraction" and "Agent SDK readiness" lens,
and records where each stands relative to the work already in flight.

**Verdict:** the codebase is already well-aligned, and is under an active,
effective simplification program that has closed most of the gaps a generic
audit would raise. The right next step is to keep executing that program in its
chosen order, not to open a parallel refactor. The specific, still-open
SDK-readiness items are consolidated in §6 with their existing owners. Nothing
here recommends an autonomous code change.

## 1. Why a fresh "remove abstractions" pass is not the move

Three pieces of evidence, independent of each other, say this tree is not
carrying stray indirection:

- **The surface has already been cut, hard.** The Oct-21 general-package design
  ([`2026-10-21-harness-general-package-design.md`](./2026-10-21-harness-general-package-design.md))
  measured 246 root exports from `@texra-ai/harness`, 43 of them host-only and
  37 internal plumbing. The current api report
  (`config/api-reports/harness.api.md`) reports **37 exports total**. The root
  door was trimmed by roughly 85% since that baseline. Zod is gone repo-wide
  (ruled 2026-10-24; no `zod` import remains in `packages/llm/src` or
  `packages/harness/src`), and the llm branding leaks that doc listed
  (`originator: 'texra'`, `X-Title: 'TeXRA.ai'`) are no longer in
  `packages/llm/src`.
- **An ordered program is already mid-flight.** Red-flags rounds 1–6 and the
  "root designs, Effect-native" series
  ([round 2](./2026-11-07-red-flags-round-2-and-order.md),
  [round 3](./2026-11-07-red-flags-round-3-plan.md),
  [root designs](./2026-11-05-root-designs-effect-native.md)) are an Ousterhout-ordered
  queue of exactly the findings a readiness audit produces — pass-throughs,
  two-representation facts, shallow modules — each costed, each with two designs
  compared, many already landed (`#14785`–`#14795`, `#14854`, `#14856`).
- **The dead ends are already fenced.** `.agents/docs/refuted-candidates.json`
  holds **43** refactor candidates investigated and refused. Several are
  precisely what a generic "collapse the indirection" pass would wrongly
  re-suggest — see §5. Re-proposing one as originally specified is the failure
  that registry exists to stop.

A naive audit here would at best duplicate the in-flight docs and at worst
re-propose a refused candidate. The value this review can add is to confirm the
four areas and point at owners, not to re-derive findings.

## 2. Agent core — `agent/core/` + `agent/runtime/`

**State: deep, single-program, no stray layers. Aligned.**

The run is one Effect program (`runtime/loop/runLoop.ts`) that appends rows and
continues from the `RunState` each append returns; live and resume are the same
function. There is no flow engine, no cursor, no graph, no services bag — the
run loop README (`agent/runtime/README.md`) and AGENTS.md "Run loop
architecture" state this as a standing invariant with a mechanical guard (one
publisher, three commit doors). The top level of `agent/runtime` is flat *by
decision*, with the README explaining that a group becomes a subdirectory only
when a refactor already rewrites its call sites. That is the opposite of
speculative layering.

- **No wrapper to inline found.** `executeAgent` is the one run program; entry
  points run it directly, per the "flattening abstraction layers" guardrail.
- **Subagents already exist as first-class structure** (see §4).
- Open items against this area are internal-consistency fixes, not abstraction
  removals: round 3's `R1`/`R3`/`R4` (test fakes that re-implement
  `ModelInvoker`, the view update, and the row codec) and `U5` (storage keeps an
  unchecked copy of llm's finish reasons). All are owned by the round-3 plan.

## 3. Model handler — `ModelInvoker` + `agent/runtime/modelAccess/` + `packages/llm`

**State: one service, one path, providers-as-data. Aligned.**

`ModelInvoker` is the only caller of the `packages/llm` `Model` for a run;
`run/modelCall.ts` is the only off-the-rows call (compaction, helper). The turn
retry loop reads its next move off committed rows (`nextAttempt`), so it keeps no
count or permit of its own — a resume continues the same series. `modelAccess/`
is the single path from settings to a bound `Model`, and a new provider is
*data*, not a handler class (AGENTS.md "Agent execution" enumerates the seven
touch points, six compile-enforced). This is a deep module over genuinely
complex behaviour, not indirection.

- **No redundant interface found** between `ModelInvoker`, `ModelAccess` and the
  llm `Model`: each is a different abstraction (billed-turn orchestration vs.
  settings→route binding vs. wire transport), not a pass-through.
- The one open accounting item is `U5` (finish-reason/media-kind copies without
  an `AssertNever` check), owned by round 3. The llm package is otherwise pure
  as claimed, and the earlier branding/Zod leaks are resolved.

## 4. Subagent boundaries — already designed, do not re-split

**State: a full child-run system exists. The design question is settled.**

The request asks to "design subagent boundaries / identify logical units that
could run as independent agents." The harness already has this, end to end:

- `delegation/` — the `agent` tool and `ChildRuns`, the child launches, and
  which models a child may use.
- `childRunLoop` — the single driver for every child-run type; a native child
  runs one cycle under `executeAgent`, a process child one turn under
  `processRun`.
- `nativeSubagentStrategy`, `scriptRun`, `recipeResult`, `subagentResults` +
  `deliveryEnvelope` (the XML envelope every child path builds), `childRunBudget`
  (per-session concurrency).

Every child is a run that ends; its `run.end` transaction queues its report on
the parent's input, and a later message to it is a resume (AGENTS.md "Agent
execution"). Plugins already carve logical units: a plugin owns one agent block,
and the documents plugin's `task:` block makes an agent a document task run by
its own recipe. **No new split points are warranted** — proposing fresh
subagent boundaries would cut across a working, row-durable delegation model.

## 5. Logger — `logger/`

**State: minimal single-sink, channel-annotated. Aligned.**

Five files. Every producer writes one structured entry to a single host sink;
Effect code names its channel once with `withLogChannel` (`Effect.annotateLogs`)
rather than threading a channel string, and attaches payloads raw with
`annotateLogs({ data })` — the sink renders and bounds them once, so no producer
decides how much a surface shows. Agent flows log through `AgentTrace`; only the
one fiberless publication point writes `writeLogEntry` (AGENTS.md "Logging").
This is already the "one owner, render once at the boundary" shape. No
abstraction to remove.

## 6. Do-not-re-propose list (refuted candidates touching these areas)

A generic indirection sweep would likely suggest these; all are refused in
`.agents/docs/refuted-candidates.json`. Cite the id and bring *new* evidence
before touching any:

- `EFF-ADOPT-retry-gate-circuit-breaker`, `EFF-ADOPT-retry-gate-schedule` —
  `ModelRetryGate` is not a stock circuit breaker/schedule.
- `EFF-ADOPT-per-key-lane-semaphore`, `DISPATCH-script-lanes-semaphore`,
  `LEAN-lake-lane-server-semaphore` — the per-key lanes are not a bare
  semaphore.
- `SESSION-one-view-service` — the view services are not collapsible to one.
- `LLM-subscription-credential-facade`, `LLM-one-no-completed-turn-check` —
  model-path "simplifications" already costed and refused.
- `EFF-ADOPT-config-provider`, `EFF-ADOPT-mcp-client`,
  `EFF-ADOPT-timeouts-already-effect` — Effect-facility adoptions already ruled.

## 7. The genuinely-open SDK-readiness items (owners, not new work)

These remain the real distance to "general package, as usable as pi-durable."
Each already has an owner; listed so the four-area review is complete:

| Item | Where it stands | Owner |
| --- | --- | --- |
| Publication to npm | not yet released | `releasing` skill / sdk-v release |
| Imperative edge (`await open()` / `submission.wait()`) over the Effect-only surface | surface is Effect-only today; convenience edge not built | [general-package design](./2026-10-21-harness-general-package-design.md) "Edge" |
| Deferred tools (`/tool-search`) + durable sleep with host wake | none | general-package design |
| `Storage` / `ExecutionEnv` ports (SQLite + spawner are process-wide) | ports not named | general-package design "Storage"/"Execution" |
| Remaining semantic leaks (discipline teams, `texra.` prefix, TeX paths, base prompt LaTeX) | partially cut; ~the largest groups remain | round 3 §2.1 (vocabulary has one owner) |
| Plugin contract covering TeXRA's own plugins (`ToolFact`, `Continuation`, `defineBuiltinPlugin`) | still internal | general-package design "plugin contract" |
| Quickstart/examples/spec parity with pi-durable | behind | general-package design |

## 8. Recommendation

1. **Do not open a parallel refactor.** The ordered red-flags program and the
   general-package design already cover this ground with adversarially-judged
   designs; adding a competing pass raises merge friction against exactly the
   PRs in flight.
2. **Treat §7 as the SDK-readiness backlog** and advance it in the existing
   docs' order (unknown-unknowns → cognitive load → change amplification).
3. **Minor, low-risk cleanup actually observed:** keep the general-package
   design's baseline note current — several of its "behind" rows (246 exports,
   Zod `.catch`, llm branding) have since landed and now overstate the gap; a
   one-paragraph "status since baseline" update there would stop it misdirecting
   the next reader. This is a doc edit, not a code change, and belongs to
   whoever next touches that proposal.

No code changes are proposed. This review is a map of an already-aligned tree.
