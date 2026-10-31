---
created: 2026-10-31
status: proposed
---

# Agent SDK readiness: independent audit snapshot

Baseline: `main`/`claude/eager-noether-5xk5jx` at `92b3514`. This is a fresh,
read-only audit of the four areas an SDK-readiness pass names — the agent core,
the model handler, the logger, and the public surface — plus subagent
boundaries. Its purpose is to answer the standing question "how ready is
`@texra-ai/harness` to be a general Agent SDK?" with current, independently
checked evidence, and to say what, if anything, a reader should do next.

## Bottom line

The codebase is already well-aligned with Agent SDK patterns, and the
SDK-readiness work this audit was asked to plan **already exists as two
owner-sequenced design notes that are actively landing**:

- [`2026-10-21-harness-general-package-design.md`](2026-10-21-harness-general-package-design.md):
  "the harness as a general package" — seven read-only audits, a four-design
  comparison, a deletion ledger, and nine lanes.
- [`2026-10-27-tech-debt-target-designs.md`](2026-10-27-tech-debt-target-designs.md):
  target designs for the ten costliest debts, with progress tracked through
  2026-10-30.

Nothing this audit found is new to those notes. The sections below confirm the
current state against `92b3514` and point each open item at the lane that owns
it. **No refactoring was performed**: the remaining work is gated by owner
decisions (`D2`, `D6`, `D9`), explicit sequencing, and a storage freeze that
must precede some of it — unattended, speculative edits would cut across all
three.

## 1. Agent core — aligned

The run is one Effect program (`agent/runtime/loop/toolUse.ts`,
`loop/toolUseDispatch.ts`) that continues from the `RunState` each append
returns; there is no flow engine, cursor, services bag, or second history
writer. State is row data, so live and resume are one function. This is the
shape an SDK wants: a resumable, durable loop with one write contract. The
architecture tests, the three-door writer check, and the crash-point suite
enforce it — and the general-package audit found "the writer core is clean …
no near-miss survived the re-check."

Genuine hotspots, both already tracked, not new:

| File | Lines | Cap | Owner |
| --- | --- | --- | --- |
| `agent/runtime/loop/toolUseDispatch.ts` | 1107 | 400 | tech-debt `T1`/`T3` (open): the per-call program, terminal rows guaranteed by the program |
| `shared/session/sessionViewUpdate.ts` | 1152 | 400 | general-package "still open" list |

Both sit in `config/ratchets/core-quality/file-size.json` as shrink-only
baselines, so they cannot grow and are visible to every build.

## 2. Model handler — aligned, one large file baselined

`ModelInvoker` is the single caller of the `packages/llm` `Model`, and every
model call goes through the one retry loop in `run/invocation.ts`. Model access
(`runtime/modelAccess/ModelAccess.ts`, 234 lines) is a clean, deep Effect layer:
a binding reads settings once, decides a route, and makes that route a `Model`
with the one credential it bills. **There is no per-provider handler class** — a
new provider is a protocol case in `packages/llm` plus a route and credential —
exactly the data-driven shape an SDK should expose. `credentialSwitch`,
`admit`, and `bind` are three distinct facts, not pass-throughs.

One item worth a reader's eye, already baselined:

- `ModelInvoker.ts` is **817 lines** (file-size cap is 400). It is grandfathered
  in `file-size.json` and shrink-only. It is not called out by name in either
  design note as a split target; if a future pass touches it, the SSOT-respecting
  move is to lift the retry/attempt bookkeeping that `run/invocation.ts` already
  owns, not to split the file mechanically (per the "never split a file
  mechanically" rule in the root guide).

## 3. Logger — exemplary, no action

`logger/` is five files (~420 lines total) and a model deep module: one host
sink port (`logSink.ts`), one rendering-and-redaction point, channels carried as
`Effect.annotateLogs` annotations rather than threaded strings
(`effectLog.ts`), and `LogEntry` defined as `ReturnType<typeof
Logger.formatStructured.log>` — it reuses Effect's own structured formatter
instead of inventing a parallel type. No producer decides presentation; secret
redaction happens once before any host sees an entry. There is no unnecessary
abstraction to remove here.

## 4. Public surface — substantially narrowed, actively shrinking

The root entry (`config/api-reports/harness.api.md`) now exports **49 names**,
down from the 246 the general-package audit measured; the design's target is
~30. Subpaths are already shaped the SDK way: `./schemas` (a named manifest),
`./plugins` (the authoring closure, now exporting `ALWAYS_AVAILABLE`), `./node`,
`./host`, `./transcript`. The remaining cuts are not new lint rules but moves of
app vocabulary and narrower root signatures, owned by general-package lane 1 and
tech-debt `V9`. The forgotten-exports ratchet keeps all but six of the 487
`./host` + `./schemas` names because a consumed signature references them, so
the surface cannot be cut further without narrowing those signatures first — a
fact both notes already record.

Residual TeXRA-vocabulary leaks the audits flagged have largely been resolved:
`#14364` moved the namespace to data, the presets, the LaTeX prompt, the TeX
paths, and the validation model into the app; `#14369` removed
`ITool.unavailableHosts`; `SettingHost` is gone from `WorkspaceRoots`.

## 5. Subagent boundaries — already a first-class concept

Step 4 of an SDK-readiness pass ("design subagent split points") is already
built: `agent/runtime/delegation/` is a full subagent model —
`subagentRun.ts`, `inBandSubagentRun.ts`, `detachedChildRun.ts`,
`agentChild.ts`, `childRun.ts`, plus `AgentTool.ts` (the delegation launch) —
driven by `agent/runtime/nativeSubagentStrategy.ts`, with the child-run
concurrency budget
(`childRunBudget.ts`, designed in
[`2026-08-15-child-run-concurrency-budget.md`](../../implemented/architecture/2026-08-15-child-run-concurrency-budget.md)).
A child runs in its parent's tool-call fiber and is launched through
`ChildRuns.launchProcess`; peer runs have their own design
([`2026-10-24-peer-runs.md`](../../implemented/architecture/2026-10-24-peer-runs.md)).
The logical units an SDK pass would carve out — a delegated agent, a detached
background agent, an agent-CLI child — are already independent runs with their
own trace, cards, and birth grants. There is no new split to design; the open
work is the plugin-contract exposure (`Continuation` on a public `RunPark`,
`defineBuiltinPlugin` deletion) in general-package lane 4b.

## Open items (all pre-existing, pointed at their owner)

| Item | State at `92b3514` | Owner |
| --- | --- | --- |
| `defineBuiltinPlugin` still present (`tools/plugins.ts`, `tools/builtinPlugins.ts`) | typed alias remains | general-package lane 4b (built-ins fence) |
| `toolUseDispatch.ts` 1107 lines; stage rows via `log.publish`; 2 type-assertion entries | open | tech-debt `T1`, `T3`, `T4` |
| `sessionViewUpdate.ts` 1152 lines | open | general-package "still open" |
| `ModelInvoker.ts` 817 lines | baselined, shrink-only | not a named target; shrink via SSOT if touched |
| Test kernel: 167/273 suites deep-import the harness; no `src/test-kernel` deep-import row | not started | tech-debt `A1`, `A2` |
| `./promise` entry; `defineTool({ deferred: true })`; timed follow-up (`notBefore`); Storage port | deferred | general-package lanes 5, 8 |
| ~350 lines of duplicated lowering across llm adapters | open | general-package "still open" |

## Recommendation

Treat the two existing design notes as the plan of record; this audit adds no
new direction. If anyone wants to advance SDK readiness from here, the
highest-leverage, lowest-risk next steps the notes already sequence are:

1. **`A1`/`A2`** — give the test kernel one way into the harness before the
   general-package moves, which makes every later move cheaper.
2. **Lane 4b fence** — delete `defineBuiltinPlugin` and put the built-ins on
   `ToolContext`; this is the single largest remaining surface-cleanliness win
   and the one that most directly lets an external embedder write plugins the
   way TeXRA's own are written.

Both are behaviour-preserving, both have owners, and neither should be attempted
by an unattended run: they move dozens of files and collide with open work on
`runRegistry.ts` and `SessionEvents.ts`.

## Verified

- Read `92b3514`: `agent/runtime/modelAccess/ModelAccess.ts` (full),
  `logger/effectLog.ts` and `logger/logSink.ts` (full/head), the root
  api-report header (`Exports: 49`), and `eslint.config.mjs:144-154`
  (`CORE_QUALITY_DIRS`).
- Line counts: `toolUseDispatch.ts` 1107 (via `file-size.json`),
  `ModelInvoker.ts` 817, `sessionViewUpdate.ts` 1152 (`wc -l`).
- `defineBuiltinPlugin` present in `tools/plugins.ts` and
  `tools/builtinPlugins.ts`; `ALWAYS_AVAILABLE` exported from `plugins.ts:70`.
- Delegation subsystem file listing under `agent/runtime/delegation/`.
- Progress claims cross-checked against the two design notes' own
  2026-10-28 and 2026-10-30 progress sections.
- Not run: any build, test, or refactor. No code was changed.
