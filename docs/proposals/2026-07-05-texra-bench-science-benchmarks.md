# TeXRA Bench: Verifiable Science Benchmarks on the TeXRA CLI

**Status:** Proposal (v3 — Occam's razor applied; the fuller v2 design survives in git history at `5581658` and everything removed from it is listed in Appendix A with its readmission trigger)
**Audience:** Eval-infra engineers (frontier labs), TeXRA maintainers

---

## 1. Motivation

Science benchmarks fail frontier labs for three structural reasons: scores rest on LLM judges reading prose, ground truth rots as papers enter training corpora, and reported numbers cannot be audited or regraded. Generic harnesses (Terminal-Bench/Harbor, Inspect, lm-eval) are excellent runners but have none of the domain machinery science tasks need.

TeXRA already owns that machinery, hardened in production:

- **LaTeX grading pipeline**: `src/agent/output/compileCheck.ts`, math-aware latexdiff (`src/latex/latexdiff/mathMarkup.ts`), `src/latex/latexToolchain.ts`.
- **Symbolic/formal verifiers**: Wolfram via `executeWolframCode` (`src/tools/wolfram/wolframScriptUtils.ts:72`), Lean 4 via `runLakeCommand` (`src/tools/lean/direct/lakeCommands.ts:59`) plus solver-side LSP/Loogle tools.
- **A byte-stable headless CLI with per-run evidence**: `executeCliConfig`/`executeCliRequest` (`packages/cli/src/runtime/runExecution.ts`), the `AgentEvent` trace (`src/agent/trace/events.ts`), usage/cost accounting (`src/agent/core/usage/RunUsageAccumulator.ts`), canonical exit codes, and a contract-tested NDJSON registry (`packages/cli/src/schemas/cliOutput.ts`).

**Core claim:** tasks whose ground truth is executable — compile gates, CAS equivalence, Lean proofs, machine-verified defect fixes — with LLM judgment as a small, separately-reported residual, and grading decoupled from running so archived evidence can be regraded without re-buying inference.

## 2. The razor

Every mechanism in this design passes two tests:

1. **Necessity** — the core claim fails without it.
2. **Non-duplication** — nothing that already exists provides it: not Harbor (running agentic tasks at scale, RL rollouts), not TeXRA's existing headless path and trace, not a lab's own statistics tooling.

Applied honestly, this cuts the v2 design roughly in half (Appendix A). What survives is one task contract, one runner, one grader contract (with a standard grader pack as data, not harness code), one validation gate, one task-generation pipeline, and one interop surface. Nothing in the MVP requires any change to `src/agent/` core.

The same razor is the Bitter Lesson applied to benchmark content: verify **outcomes**, not adherence to human solution paths; keep the harness a thin general contract; scale task supply with compute (generation) rather than reviewer-hours (curation); let verification asymmetry keep difficulty unbounded — checking stays cheap even when producing outgrows the task's author.

## 3. Design

`texra bench` is a citty command group (`packages/cli/src/commands/bench.ts`, registered in `root.ts`), backed by a VS Code-free `src/bench/` (schemas in Zod v4, types via `z.infer`).

Three phases, each idempotent over on-disk state (not pure — `run` spends model tokens and `grade` may call a judge — but re-running a phase over the same digests is a no-op, never a duplicate spend):

```
bench run    : suite + models   ->  evidence dirs   (spends model tokens)
bench grade  : evidence dirs    ->  scores.jsonl    (spends judge tokens only, if any)
bench report : scores.jsonl     ->  summary         (spends nothing)
```

Grading never mutates evidence. A grader bug after publication is a regrade, not a rerun.

**Runner.** Each (task × model × trial) cell spawns a subprocess — the byte-stable headless contract becomes the harness's internal API — using whichever entrypoint matches the solver agent's category: `texra run` for workflow-category agents, `texra agents run` for tool-use-category agents (needed for the `std/lean-build` grader's Lean LSP/Loogle solver tools, §5; that path today runs a single model/tool cycle and needs a multi-cycle continuation mode before bench can dispatch through it). This is a correctness requirement, not a convenience: `executeCliRequest` routes through process-global session and approval state, so in-process concurrent cells are unsafe today. Runs use a non-interactive approval policy scoped to the run container, since the default `ask` policy has no prompter to answer headlessly and would silently filter out tool-gated solver actions (file writes, `bash`, `wolfram`). Subprocesses give crash isolation, SIGTERM timeouts, `--concurrency` parallelism, and retry keyed on the run's classified outcome (transient model/network failure → retry with backoff; agent error → record, don't retry). Only a cell's terminal outcome is persisted to disk — a retried transient failure writes nothing until it resolves — so retry and the exactly-once resume-skip below never conflict. A cell whose result already exists is skipped on resume: exactly-once by construction.

**One task contract.** A task is `workspace in → artifacts out → graders emit verdicts`. There is no task-kind taxonomy in the harness; "derivation task" or "proof task" is just a conventional grader stack. The solver is an ordinary TeXRA agent YAML whose digest is part of the run's identity — a deliberately minimal default agent ships with the suite, and any scaffold comparison is just a different agent digest, not special harness machinery.

**Subjects: models and TeXRA agents.** Grading is _environment-mediated_ — graders read only the final workspace, never the solver's API stream — so the subject is a black box by construction. Two subject classes share one identity mechanism (the solver descriptor digest in `cell.json`):

1. **A model** under the bundled minimal TeXRA agent (the default; measures the model).
2. **A TeXRA agent** — any agent YAML (measures scaffolds: reflection vs. tooluse flows, tool loadouts, prompt variants — just a different digest, no special machinery).

External agents (Claude Code, Codex CLI, lab-internal scaffolds) are **deliberately out of scope for now** (Appendix A): at scale they are already covered by the Harbor task export (§9) plus Harbor's existing agent adapters, and the environment-mediated contract means a local `--solver-cmd` escape hatch can be added later without touching the task format or graders.

## 4. Task format

```yaml
# suites/texra-sci-v1/tasks/qft-oneloop-vacuum/task.yaml
id: qft-oneloop-vacuum
title: One-loop effective potential for phi^4 theory
instruction: instruction.md # self-contained brief; the same file every subject sees
agent: bench-solve-minimal # default solver; any agent YAML may be substituted per run
inputs: [problem.tex]
context: [macros.tex, conventions.tex]
timeoutMs: 1800000
graders:
  - command: [std/compile-check] # gate: fail => 0, nothing else runs
    required: true
  - command: [std/cas-equal, refs/check-result.wls] # fixed script, no LLM in the loop
    weight: 0.8
  - agent: bench-grade-simple # LLM judgment: bounded residual, reported separately
    weight: 0.2
refs: # grader-only namespace, never mounted for solvers
  solution: refs/gold-solution.tex # must score 1.0 under `bench validate`
  sabotage: refs/copy-input.tex # must score <= 0.05
tags: [derivation, hep-th, wolfram]
provenance: { source: original, createdAfter: 2026-06-01 }
```

**Score composition:** a `required` grader is an AND gate — `fail` sets the cell score to `0` and skips remaining graders; `unverifiable` on a required grader short-circuits the same way but marks the cell `unverifiable` rather than `0`. Non-required graders contribute `weight × verdict-value` (`pass` = 1, `fail` = 0); a non-required `unverifiable` grader is excluded from the sum and the remaining weights are renormalized. Weights need not sum to 1 — they're normalized by their sum before combining.

The suite file adds `name`, `version` (semver: MAJOR = tasks changed, scores incomparable; MINOR = graders changed, history regradable), `canaryGuid`, and the task list.

`instruction.md` is first-class and self-contained: it fully specifies the task (goal, expected artifacts, `\benchresult` convention) with no TeXRA-specific assumptions, because it is the _same_ brief handed to every subject — every TeXRA agent variant and the Harbor export consume this one file. Cross-subject fairness lives here, not in per-agent prompt tuning.

**`refs/` is structural anti-contamination**: the workspace materializer copies `inputs` and `context` into the solver's temp workdir and never copies `refs/`; solver file tools cannot reach it. Leakage is prevented by construction, not reviewer vigilance — but for solver agents with a raw shell tool, that construction has to extend to the container/sandbox mount, not just tool scoping: the suite's `refs/` directory must not be reachable from the solver's filesystem root at all, or a shell tool defeats file-tool-level isolation.

**Verdicts are three-valued** (`pass | fail | unverifiable`): a CAS timeout or toolchain mismatch escalates as a grader error — never silently scored 0.

## 5. Graders: one contract, two executors

A grader is anything that runs in the grader sandbox over `(solver artifacts + refs/)` and writes `verdict.json` — `{verdict: pass|fail|unverifiable, value?, evidence?}`. This is close to Harbor's reward shape but not identical (Harbor's `reward.json` values must be numeric); the §9 export projects `verdict.json` into that numeric shape rather than writing it directly. The harness implements exactly **two executor shapes and no grader taxonomy** — there is no `cas-assert` or `lean-check` arm in the schema:

- **`command`** — a pinned script/binary run with no LLM in the loop: deterministic, replayable at zero cost, and immune to prompt injection hiding in solver-produced artifacts. This is the **headline-score class**. The task YAML's `command` array is `[script, ...args]`: the first element resolves a script under `std/` or the task's `refs/`, remaining elements are passed as positional arguments.
- **`agent`** — any TeXRA agent YAML, run through the same headless path as solvers and forced through a `report_verdict` structured tool (the proven `report_review_issue` pattern), verdicts cached by `(cellDigest, graderDigest)`. Agent graders read untrusted solver output and are nondeterministic — so their weight is bounded (≤ 0.2), always reported separately, and expected to trend to 0. No calibration bureaucracy unless agent-graded scores ever become load-bearing (Appendix A).

The verifier library is therefore **data, not harness code**: a standard grader pack (`std/`) ships as versioned, digested scripts that wrap machinery TeXRA already has —

| `std/` grader (command) | Wraps                                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std/compile-check`     | `compileCheck.ts` / `latexToolchain.ts` invoked directly, independent of the interactive `WORKFLOW_AUTO_COMPILE` setting — a required gate can't depend on a user preference — the hard gate                                                                    |
| `std/cas-equal`         | `wolframscript` (or SymPy) executing a **fixed** `refs/` assertion script against the extracted `\benchresult{...}` — outcome-level, targeting renotation-robustness (how far that can be pushed is open — §15), no credit for matching a human derivation path |
| `std/lean-build`        | `lake build` against a pinned mathlib toolchain; binary per lemma. Proof tasks need only a statement — difficulty can outgrow the task's author (§6 validate exempts this stack from the gold-`refs/solution` check, since it has no reference answer to score) |
| `std/diff-align`        | the math-aware latexdiff service — **error-injection tasks only**: edits inside injected spans must match gold, edits outside are penalized; not applicable to derivation/proof tasks, which have no injected spans                                             |
| `std/issue-match`       | `ReviewIssue` matching against gold defects within a line window → precision/recall                                                                                                                                                                             |
| `std/answer-match`      | numeric-tolerance / exact / set matching on parsed answer blocks                                                                                                                                                                                                |

A new verifier is a new script (or agent YAML) in the suite — **zero harness changes**. Lean/Loogle LSP tools remain available _to the solver_ in tool-use mode: proving is interactive and intelligent; checking is `lake build`.

**Why not "everything is an agent":** the determinism of the headline metric is the product. An agent deciding at grade time what Wolfram code to run puts an LLM back inside ground truth, breaks free regrades (agent behavior drifts), and feeds untrusted solver artifacts into a grader's prompt. The division of labor: **agents grade where judgment is required; commands verify where truth is executable.** The powerful middle ground is the proposer–verifier split: an agent grader may _search_ for an equivalence argument but must emit a **certificate** — e.g. a Wolfram script — that a command grader then executes as the verdict of record. Intelligence proposes, execution decides: the search scales with model capability (Bitter Lesson) while the headline number stays deterministic.

## 6. Validation gate

`texra bench validate` is the suite's CI contract (exit 1 on any failure):

- schema-valid; every input pinned and hashed; `refs/` isolation intact (a materializer test asserts no `refs/` file reaches a solver workspace);
- for tasks that declare a gold `refs/solution`, it scores **1.0** on the `command`-grader components exactly; grader stacks with no reference answer (e.g. `std/lean-build` proof tasks — §5) are exempt from this specific check, not from the gate as a whole;
- the sabotage baseline (copy-input / empty-fix / restate-the-problem) scores **≤ 0.05**;
- injected documents compile and gold fixes restore diff-equality to the original (applies only to tasks minted by `bench inject`, §8; curated Stage 1 tasks without injection metadata are exempt);
- any `agent` grader (§5) in the stack is validated with a small retry/tolerance budget rather than an exact score, since it is nondeterministic by design — a single judge miss does not fail suite CI outright.

Grader quality is a CI gate, not a promise. (This is Terminal-Bench's oracle-solvability check, plus sabotage floors it doesn't have.)

## 7. Evidence and reproducibility

Per cell, `bench run` archives what the existing machinery already produces:

```
bench-results/<suite@version>/<runId>/<model>/<task>/trial-<n>/
  cell.json         # identity tuple: task/agent/grader digests, model id, params, exit, wall time
  outputs/          # solver artifacts (incl. compiled PDFs)
  events.ndjson     # full AgentEvent trace (AgentTrace subscriber, same pattern as
                    # src/transcript/TexraTranscriptRecorder.ts)
  usage.json        # RunUsageTotals: tokens, cache stats, totalCost
  env.json          # toolchain fingerprint in the doctor pattern (TeX Live/Node/config already
                    # probed by `texra doctor`; Wolfram/lake/image-digest probes are new additions
                    # to that machinery, not built yet)
```

- **Comparability rule:** two scores are comparable iff their _task_, _grader-pack_, and _environment_ digests match; the subject dimension (model id and/or agent digest) is exactly what `--compare` varies, so it's excluded from the match. `bench report` refuses comparisons that differ on any of the fixed digests.
- **Regrade, don't rerun:** graders never mutate these directories, only read them; `bench grade --regrade --diff-against <old>` (a suite version, e.g. `1.1`, resolved under `--results-dir` to that version's evidence directory) recomputes history at zero model cost and attributes every delta to the grader diff.
- **Hermetic execution:** a published container image pins TeX Live / Lean / wolframscript; `env.json` records the fingerprint; network off by default at the container level (not just tool-level filtering — a solver with shell access could otherwise reach the network via `curl`/package managers even with web tools disabled), with web tools additionally disabled in-agent via the existing `runtimeUnavailableTools` mechanism (`src/agent/runtime/RunContext.ts`) as defense in depth. No new sandbox layer beyond the container's own network policy.
- **Determinism honesty:** providers offer no usable seeds; replicate variance is measured and reported, never pretended away.

## 8. Task supply: the compounding asset

`texra bench inject` mints error-injection tasks from post-cutoff arXiv papers (pinned tarballs via `src/latex/arxivProcessor.ts`, sha256 recorded): seeded defects (sign flips, dropped factors, false lemmas) with machine-verified gold fixes — the injected document must compile and the gold fix must restore diff-equality, so tasks are gold-by-construction.

This is the contamination strategy and the scaling strategy in one mechanism: fresh tasks are _provably_ post-cutoff, and supply scales with compute rather than reviewer-hours. Curated suites bootstrap; the generation pipeline is the product.

## 9. Interop and scale: one surface

`texra bench export --format harbor-task` emits each task as a Harbor/Terminal-Bench-conformant directory: container environment, `instruction.md`, oracle `solution/` generated from `refs/gold-solution`, and a `tests/test.sh` that invokes `texra bench grade --cell` and writes `reward.json` to `/logs/verifier/`.

This single export delegates everything that is not our comparative advantage:

- **Lab-scale execution** — Harbor already runs thousands of cloud containers; we don't build a fleet scheduler.
- **RL rollouts** — Harbor generates rollouts over the same task format; our graders become reward functions without a `bench rollout` engine of our own.
- **Agent-agnosticism** — labs run their own agents (Claude Code, internal scaffolds) against our tasks under Harbor; we don't build adapter shims.
- **Internal model endpoints** — `customBaseUrl` (`resolveBaseUrl`, `src/agent/modelHandlers/support/ProxyConfigResolver.ts`) is already threaded through every handler stack in `src/agent/modelHandlers/`; pointing a given provider at an internal gateway is configuration, not code — but the gateway has to speak that provider's own protocol (the Anthropic and Google handlers construct their native SDK clients against the custom URL, not an OpenAI-compatible Chat/Responses shape), so a single lab-wide OpenAI-compatible gateway only covers the OpenAI-SDK-based handlers without an added routing layer.

The local `bench run` runner remains for task development and small suites — authors need a tight loop — but competing with Harbor on scale is a non-goal. We compete on verifiers and task supply, not on the harness.

## 10. CLI surface

```bash
texra bench run suites/texra-sci-v1/suite.yaml \
  --model claude-opus-4-6 --model gpt-6.1 \
  --trials 5 --concurrency 8 --max-cost-usd 250 \
  --results-dir bench-results/ --output-format ndjson

# Compare TeXRA agent scaffolds on a fixed model (just a different solver digest)
texra bench run suites/texra-sci-v1/suite.yaml \
  --model claude-opus-4-6 --agent bench-solve-minimal --agent bench-solve-toolusing --trials 5

texra bench grade bench-results/texra-sci-v1@1.2.0            # or --regrade --diff-against 1.1
texra bench grade bench-results/texra-sci-v1@1.2.0 \
  --cell qft-oneloop-vacuum/claude-opus-4-6/trial-1            # single cell, used by the Harbor export's tests/test.sh
texra bench report bench-results/texra-sci-v1@1.2.0 \
  --compare claude-opus-4-6:gpt-6.1 --format md               # --format json for machines; --fail-under 0.6 for CI
texra bench validate suites/texra-sci-v1/                      # suite CI gate
texra bench inject arxiv:2506.01234 --count 6 --seed 42 --out suites/rolling-2026-07/
texra bench export suites/texra-sci-v1 --format harbor-task --out harbor-tasks/
```

Model ids above (`claude-opus-4-6`, `gpt-6.1`) are illustrative placeholders, not literal registry entries — real invocations use whatever ids `texra`'s current model registry accepts.

Six subcommands. Exit codes reuse `packages/cli/src/runtime/exitCodes.ts`; scores are data, not exit codes — `bench run` exits 0 even when models score poorly; non-zero means harness/infra failure. `bench report --fail-under` is the one deliberate exception: it exits nonzero specifically to gate CI on a score threshold, not on harness state. Machine output joins the contract-tested `CliNdjsonRecordSchema` registry so the wire format is CI-locked like every other headless output.

**Reporting** is deliberately simple: per-model mean with a percentile-bootstrap CI over tasks, per-task paired deltas for `--compare`, and $/solved-task from `RunUsageTotals`. `scores.jsonl` is the machine artifact — labs with opinions about statistics (they all have them) run their own on it.

## 11. Existing machinery it rides on

| Bench component                   | Existing code                                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cell execution                    | `packages/cli/src/runtime/runExecution.ts`; tool-use path via `packages/cli/src/commands/agentsRun.ts` (today stops after one model/tool cycle — `stopAfterCycle: true` — bench needs a multi-cycle variant, tracked as an MVP gap) |
| Compile gate / diff / structure   | `src/agent/output/compileCheck.ts`, `src/latex/latexdiff/`, `src/latex/latexToolchain.ts`, `src/latex/labelSearch.ts`, `src/latex/extractBibliography.ts`                                                                           |
| CAS / Lean verifiers              | `src/tools/wolfram/wolframScriptUtils.ts`, `src/tools/lean/direct/lakeCommands.ts`, `src/tools/lean/LspTools.ts`, `src/tools/lean/LoogleTool.ts`                                                                                    |
| Issue localization                | `src/agent/review/reviewIssues.ts`; solver pattern from `packages/extension/resources/tool_use_agents/changeReviewer.yaml`                                                                                                          |
| Fresh-task supply                 | `src/latex/arxivProcessor.ts`                                                                                                                                                                                                       |
| Trace archive                     | `AgentTrace` subscriber (`src/agent/trace/AgentTrace.ts`, pattern: `src/transcript/TexraTranscriptRecorder.ts`); `AgentEvent` union                                                                                                 |
| Usage / cost / abort              | `src/agent/core/usage/RunUsageAccumulator.ts` (`totalCost` drives `--max-cost-usd`, checked between dispatches — a soft budget guard under concurrency, not a per-cell reservation)                                                 |
| Providers incl. internal gateways | `src/agent/modelHandlers/` (four stacks; `customBaseUrl` already threaded)                                                                                                                                                          |
| Solver/judge agents               | ordinary agent YAML under `packages/extension/resources/agents/bench/`, run via `runAgent` (`src/agent/runtime/runAgent.ts`)                                                                                                        |
| Env fingerprint                   | `texra doctor` machinery (`packages/cli/src/commands/doctor.ts`) — today probes Node/workspace/auth/LaTeX/config; Wolfram/lake/image-digest probes are new additions, not built yet                                                 |

All additive: new code lives in `src/bench/` (VS Code-free zone, host services via `platform()`) and `packages/cli/`. **The MVP requires zero changes to `src/agent/` core.**

## 12. Positioning vs. Terminal-Bench / Harbor

Terminal-Bench 2.0 (as reported at its public release: 89 tasks, ~3 reviewer-hours of audit each, frontier models <65% — figures not independently re-verified here, run by essentially every lab) won on three things this design deliberately copies: a task contract simple enough for hundreds of authors, oracle-validated verifiers, and a harness (Harbor) that doubles as RL infrastructure. It won on none of the things we add.

What TeXRA Bench adds that TB structurally lacks:

1. **Verifier depth** — TB's verifier vocabulary is shell + pytest over terminal-observable state; science needs CAS equivalence, Lean checking, compile-and-structural-diff, referee-style issue matching.
2. **Regrade-from-evidence** — a TB verifier bug means re-running agents; our grade/evidence split makes it a zero-cost regrade with an attributable delta.
3. **Renewable, provably-fresh task supply** — TB's contamination defense is curation-time freshness; `bench inject` makes freshness a generator, not a promise.

And rather than competing with Harbor, we export into it (§9).

## 13. Staged rollout

**Stage 1 — usable (4–6 weeks):** `src/bench/` schemas + subprocess runner + `run|grade|report|validate`; the two grader executors (`command`, `agent`) plus std pack scripts `compile-check`, `cas-equal` (Wolfram), `answer-match`, `diff-align`; `refs/` isolation + gold/sabotage gates in CI; seed suite of ~25 tasks; container image; simple report stats.

**Stage 2 — adoptable (next quarter):** `bench inject` productionized (rolling post-cutoff suites); `std/lean-build` and `std/issue-match` graders; SymPy engine for the license-free subset; certificate-emitting agent graders (propose with intelligence, verify with execution); `bench export --format harbor-task` with a CI conformance check; public **TeXRA-Sci** release (versioned, licensed, per-task provenance). Success criterion: one external lab running the suite — under Harbor, through its own gateway — without talking to us.

## 14. Non-goals

- **Not a general eval harness**; no attempt to out-run Harbor/Inspect — we export into them.
- **No leaderboard service** — reports are files.
- **No new sandbox technology** — a published container + existing tool gating.
- **No bitwise-determinism claims** — variance is measured, not denied.
- **No live-web tasks** — corpora are pinned.
- **No human-labeling platform.**

## 15. Open questions

1. **Wolfram licensing in shared CI** — how much of the assertion library is SymPy-expressible, and who bears the license for the rest?
2. **Injection realism** — are seeded defects stylistically distinguishable from natural errors? Should a human discriminator study gate each rolling release?
3. **CAS-equivalence robustness** — how far can renotation-robust equivalence checking be pushed before `unverifiable` rates make tasks unusable?
4. **Governance of a held-out split** — worth the operational cost, or does the renewable-supply pipeline make private splits unnecessary?

---

## Appendix A: cut by the razor

Everything below existed in v2 (`git show 5581658`). Each was cut for failing necessity or non-duplication; each has a readmission trigger — the razor removes mechanisms, not options.

| Cut                                                                                                                                                                  | Why                                                                                                                                                                                                                                 | Readmit when                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Hash-chained wire ledger (`model.request`/`response` trace arms), `bench replay --diff`, Merkle-rooted signed bundles, `bench verify`                                | The `AgentEvent` trace already records what the model saw and said; tamper-evidence and byte-replay solve disputes nobody has had yet                                                                                               | A lab disputes a published score in a way the trace can't settle                                |
| Inspect EvalLog export, `exec-sample` stdio protocol, `commandScorer` plugin port                                                                                    | Extra interop surfaces duplicating the one that matters; Harbor export covers the standardized path                                                                                                                                 | A lab asks for one, with a concrete pipeline behind the ask                                     |
| External-agent subjects (`--solver-cmd`, `commandSolver` port)                                                                                                       | Scope decision: TeXRA agents first. At scale external agents already run via the Harbor export + Harbor's agent adapters, and environment-mediated grading means adding a local escape hatch later touches no task format or grader | We want local external-agent comparisons (Claude Code, Codex CLI) before Harbor covers the need |
| `bench rollout` RL mode                                                                                                                                              | Harbor generates rollouts over exported tasks; a second rollout engine duplicates it                                                                                                                                                | Labs adopt the tasks but demonstrably can't use Harbor for RL                                   |
| Judge calibration certificates, `judge-calibrate`, kappa machinery, cross-provider judge panels, human-adjudication queue                                            | The judge is a ≤ 0.2 residual reported separately; certifying a component that shouldn't matter institutionalizes it                                                                                                                | Judged scores become load-bearing for any published comparison                                  |
| Statistics core (cluster-bootstrap BCa, permutation tests, BH correction, MDE-gated `bench diff --gate`, variance decomposition, power calculator, tie-banded ranks) | Labs trust their own statisticians, not a benchmark's; `scores.jsonl` + simple bootstrap CI covers honest reporting                                                                                                                 | Downstream consumers demonstrably misreport from the simple output                              |
| `kind:` task taxonomy field                                                                                                                                          | The graders list already defines the task; kinds are docs/tags                                                                                                                                                                      | Never — keep it in documentation                                                                |
| `scaffold: minimal\|texra` dual-condition machinery                                                                                                                  | The agent YAML digest in the identity tuple already distinguishes scaffolds; the default agent is minimal                                                                                                                           | Never — a scaffold comparison is just two runs with different agent digests                     |
| `bench.lock.json` as a separate artifact                                                                                                                             | Same digests, one more file; folded into `cell.json`/run metadata                                                                                                                                                                   | Never                                                                                           |
| `models.bench.yaml` overlay                                                                                                                                          | `customBaseUrl` config already exists; document it, don't build it                                                                                                                                                                  | Handler stacks grow per-lab auth needs config can't express                                     |
| `samplingParams` core-schema addition                                                                                                                                | Providers largely ignore seeds; temperature already exists and is recorded                                                                                                                                                          | A major provider honors seeds well enough to reduce replicate variance                          |
| pass@k, self-correction curves, `bench diff` command, GitHub-Action distribution                                                                                     | All derivable offline from `scores.jsonl` / composable from `report --fail-under` + the existing `texra install-github-action`                                                                                                      | Never — they're recipes, not features                                                           |
| Public/private split governance, canary-scan service, monthly-cadence commitments                                                                                    | Operator policy, not harness code; `canaryGuid` + `createdAfter` fields stay (cheap now, breaking to add later)                                                                                                                     | A consortium actually forms around a private split                                              |
