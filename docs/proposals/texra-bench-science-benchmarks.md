# TeXRA Bench: A Verifier-First Science Benchmark Platform on the TeXRA CLI

**Status:** Proposal
**Audience:** Eval-infra engineers (frontier labs), TeXRA maintainers
**Champion lens:** science-task-design, with grafts attributed inline to their source lens

---

## 1. Motivation

Science benchmarks fail frontier labs today for three structural reasons:

1. **Scores rest on LLM judges reading prose.** A judge model eyeballing a derivation cannot reliably distinguish a correct one-loop effective potential from a confident wrong one. Judge drift silently reshuffles leaderboards between releases.
2. **Ground truth rots.** Real papers enter training corpora; benchmarks built on famous results measure memorization, and nobody can prove otherwise.
3. **Reported numbers cannot be audited.** A leaderboard cell is a float with no evidence trail — no way to regrade with a fixed grader, no way to see the exact request that produced the answer, no way to distinguish a model regression from a harness change.

Generic harnesses (Inspect, OpenAI Evals, HELM, lm-eval) are excellent runners but have none of the domain machinery science tasks need: LaTeX artifacts, symbolic correctness, checkable derivation intermediates, formal proofs. TeXRA already owns exactly that machinery, hardened in production across three hosts:

- **A compile-and-diff LaTeX grading pipeline**: `src/agent/output/compileCheck.ts`, the latexdiff service under `src/latex/latexdiff/` (including math-aware diffing in `src/latex/latexdiff/mathMarkup.ts`), `src/latex/latexToolchain.ts`, `src/latex/texcount.ts`, `src/latex/labelSearch.ts`, `src/latex/extractBibliography.ts`.
- **Integrated symbolic/formal verifiers**: Wolfram via `executeWolframCode` (`src/tools/wolfram/wolframScriptUtils.ts:72`), Lean 4 via `runLakeCommand` (`src/tools/lean/direct/lakeCommands.ts:59`) plus interactive LSP tooling (`src/tools/lean/LspTools.ts`, `src/tools/lean/LoogleTool.ts`).
- **A byte-stable headless CLI with per-run evidence**: `executeCliConfig` / `executeCliRequest` (`packages/cli/src/runtime/runExecution.ts:101`, `:169`), the `AgentEvent` trace union (`src/agent/trace/events.ts`), `StreamSnapshotStore` persistence (`src/transcript/StreamSnapshotStore.ts`), usage/cost accounting (`src/agent/core/usage/RunUsageAccumulator.ts`), canonical exit codes (`packages/cli/src/runtime/exitCodes.ts`), and a contract-tested NDJSON record registry (`packages/cli/src/schemas/cliOutput.ts`, `CliNdjsonRecordSchema`).

The design principle: **tasks whose ground truth is executable** — compile gates, CAS checkpoint assertions, Lean proofs, math-aware diff localization — with LLM judgment demoted to a weighted, audited, calibration-certified residual, and a strict run/grade/report decoupling so labs can regrade archived evidence without re-buying inference.

---

## 2. Design overview

`texra bench` is a new citty command group in `packages/cli/src/commands/bench.ts` (registered in `root.ts` `subCommands`, built with `defineCliCommand` and `emitCliResult` from `packages/cli/src/commands/_helpers/output.ts`), backed by new VS Code-free modules under `src/bench/`:

```
src/bench/
  schema/      Zod v4 schemas: TaskSpec, SuiteSpec, GraderVerdict, ScoreRecord, BenchLock
  runner/      matrix scheduler (task x model x trial), subprocess supervisor, resume
  graders/     thin adapters over existing verifiers + judge-agent grader
  evidence/    evidence-pack writer (trace archive, wire ledger, env fingerprint)
  stats/       measurement-statistics core (bootstrap CIs, paired tests, gates)
  report/      aggregation, leaderboards, regression diffs, HTML/MD output
  interop/     Inspect EvalLog export, exec-sample stdio protocol
```

Three strictly separated phases, each a pure function over on-disk state:

```
bench run    : suite + models  ->  evidence packs   (spends model tokens)
bench grade  : evidence packs  ->  ScoreRecords     (spends only judge tokens, if any)
bench report : ScoreRecords    ->  statistics       (spends nothing)
```

Grading never mutates run evidence. Regrading with a new grader version is a cheap migration, not a rerun. Any number in a report is auditable down to a compile log line, a Wolfram transcript, or an exact provider payload.

### Execution model: subprocess supervisor (from the mvp-wedge lens)

Each (task × model × trial) cell is executed by **spawning `texra run --output-format json` as a child process**, making the already-sacred byte-stable headless contract the harness's own internal API. This is not a convenience — it is a correctness requirement today: `executeCliRequest` routes through the process-global `defaultSession()` (`packages/cli/src/runtime/runExecution.ts:11`, used at `:181`) and process-global approval handlers, so in-process concurrent cells are genuinely unsafe. The subprocess boundary gives, from day one:

- crash isolation (one malformed cell never takes down the suite),
- per-cell timeouts via SIGTERM → exit 143 (`CliExitCode.Terminated`),
- honest parallelism bounded by `--concurrency`,
- a principled retry policy keyed on the exit-code taxonomy (from the lab-ops-scale lens): exit 3 (model/network) re-queues with backoff; exit 1 (agent error) is recorded as a failed cell, not retried; exit 130/143 leaves a resumable interrupted status,
- auditable equivalence: anything the harness does, a lab could reproduce with a shell script.

In-process pooling via fresh `SessionHandle` instances (per `docs/proposals/session-handle-7d-design.md`) is an explicit later optimization, adopted only once per-cell SessionHandle use is test-locked (from the benchmark-lifecycle lens).

### Solver scaffold declaration (from the interop-standards lens)

Every run declares `scaffold: minimal | texra`, hash-locked into the evidence pack header. `texra` runs the task through the full TeXRA agent (house system prompts, LaTeX style rules, reflection rounds); `minimal` strips house prompting to a bare task harness. This cleanly separates "measure the model" from "measure the model + TeXRA scaffold" — the ambiguity that quietly invalidates most agentic benchmark comparisons. Reports never mix scaffolds in one table.

**`minimal` is the headline condition** (Bitter Lesson, §13): published leaderboard numbers are minimal-scaffold; `texra`-scaffold results are a secondary table measuring the scaffold's value-add. Scaffolding is human knowledge engineered around the model, and its contribution historically washes out as raw capability grows — a benchmark whose headline number bakes in a scaffold measures a wasting asset.

---

## 3. Core abstractions and file formats

All schemas live in `src/bench/schema/` as Zod v4, types via `z.infer`, per the repo's schema-first rule.

### 3.1 Suite

```yaml
# suites/texra-sci-v1/suite.yaml
name: texra-sci
version: 1.2.0 # semver: MAJOR = tasks incomparable, MINOR = grader-only regrade
contaminationCutoff: 2026-06-01
canaryGuid: 7f3d2a1c-... # BIG-bench-style corpus-contamination canary (from the harness-architecture lens)
tasks:
  - {
      dir: tasks/qft-oneloop-vacuum,
      weight: 1.0,
      tags: [derivation, hep-th, wolfram],
    }
  - {
      dir: tasks/injected-2506-01234,
      weight: 1.0,
      tags: [error-injection, fresh],
    }
license: CC-BY-4.0
```

Version semantics (from the benchmark-lifecycle lens): a MAJOR bump means scores are incomparable (tasks changed); a MINOR bump means graders changed and history is recomputable from archived evidence at zero model cost; reports refuse cross-MAJOR comparisons by construction.

### 3.2 Task

The harness contract is deliberately general — a task is `workspace in → artifacts out → graders emit verdicts` — and the six task kinds (`derivation`, `proof`, `error-injection`, `paper-artifact`, `data-analysis`, `literature`) are **conventions over that contract, not harness code**: each kind is just a documented default grader stack (§6.2) plus schema fields those graders read. New kinds require no runner changes (Bitter Lesson, §13; this is the same property that made Terminal-Bench's environment + instruction + verifier contract adoptable, §12).

```yaml
# suites/texra-sci-v1/tasks/qft-oneloop-vacuum/task.yaml
id: qft-oneloop-vacuum
kind: derivation
title: One-loop effective potential for phi^4 theory
agent: bench/solve_derivation # ordinary agent YAML; settings.rounds: 2
scaffold: texra
inputs: [problem.tex]
context: [macros.tex, conventions.tex]
timeoutMs: 1800000
graders:
  - type: compile
    required: true # gate: fail => score 0, judge never runs
  - type: cas-assert
    engine: wolfram # or sympy for the license-free subset
    asserts: refs/asserts.wls
    weight: 0.6
    prefixRule: monotone
  - type: rubric-judge
    agent: bench/grade_derivation
    rubric: refs/rubric.md
    weight: 0.4
    calibration: refs/judge-cert.json # required before judge scores count (see 6.4)
refs: # scorer-only namespace, never mounted for solvers
  solution: refs/gold-solution.tex # must score 1.0 under `bench validate`
  sabotage: refs/copy-input.tex # must score <= 0.05
metadata:
  domain: hep-th
  difficulty: 4
  family: qft-effective-potentials # cluster unit for bootstrap resampling
  provenance: { source: original, author: '...', createdAfter: 2026-06-01 }
```

**The `refs/` namespace is structural anti-contamination** (from the harness-architecture lens): the workspace materializer copies `inputs` and `context` into the solver's temp workdir and _never_ copies `refs/`; solver file tools cannot mount it. Reference answers, rubrics, gold fixes, and sabotage baselines are visible only to `bench grade`. Leakage is prevented by construction, not reviewer vigilance.

Error-injection tasks add:

```yaml
source: { arxiv: '2506.01234', sha256: '...' } # pinned tarball, fetched once
injections: refs/injections.yaml # [{file, lineStart, lineEnd, kind, goldFixDiff}]
injectionSeed: 42
```

### 3.3 Evidence pack (per cell)

```
bench-results/texra-sci-v1@1.2.0/<runId>/
  bench.lock.json                     # run-wide lockfile (see 7.1)
  <model>/<task>/trial-<n>/
    cell.json          # keying tuple, scaffold, executionId, exit code, wall time
    outputs/           # solver artifacts incl. compiled PDFs per round
    events.ndjson      # full AgentEvent trace (archived via a TraceEmitter subscriber,
                       # same pattern as src/transcript/TexraTranscriptRecorder.ts)
    wire.jsonl         # hash-chained exact provider payloads (see 7.2)
    usage.json         # RunUsageTotals: tokens, cache stats, totalCost
    env.json           # doctor-style fingerprint: TeX Live, wolframscript, lake, container digest
```

Cells are keyed by the tuple `(taskDigest, agentDigest, modelId, paramsDigest, replicateIndex)` (from the benchmark-lifecycle lens); a cell whose record exists is skipped on resume, giving exactly-once semantics by construction.

### 3.4 ScoreRecord (from the scoring-verification lens)

The atomic product of `bench grade` is a content-addressed record, one per (cell × grader):

```json
{
  "kind": "score-record",
  "cell": { "task": "qft-oneloop-vacuum", "model": "gpt-6.1", "trial": 2 },
  "grader": {
    "type": "cas-assert",
    "version": "1.3.0",
    "codeDigest": "sha256:..."
  },
  "verdict": "pass",
  "value": { "passed": 5, "total": 8 },
  "evidence": ["sha256:...wolfram-transcript", "sha256:...events-slice"],
  "env": "sha256:...env.json",
  "ts": "2026-07-04T12:00:00Z"
}
```

Rules:

- Verdicts are **three-valued**: `pass | fail | unverifiable` (from the scoring-verification lens). A CAS timeout, a Lean toolchain mismatch, or a crashed grader is `unverifiable` and escalates — it is recorded as `graderError` and **never silently scored 0**.
- Aggregation is a pure function over ScoreRecords; every reported number decomposes into records, each with evidence pointers into sha256-addressed artifacts.
- Human adjudication is a first-class grader kind writing into the same record stream via a policy-driven escalation queue (from the scoring-verification lens) — not an offline spreadsheet.

### 3.5 NDJSON wire format

Bench record kinds join the contract-tested `CliNdjsonRecordSchema` registry in `packages/cli/src/schemas/cliOutput.ts` (from the scoring-verification lens), so the wire format is locked by CI like every other headless output. `kind` first for grep-anchoring, `ts` stamped, emitted through `emitCliResult`:

```
{"kind":"bench-cell-start","suite":"texra-sci-v1@1.2.0","task":"qft-oneloop-vacuum","model":"gpt-6.1","trial":2,"executionId":"...","ts":"..."}
{"kind":"bench-cell","task":"qft-oneloop-vacuum","model":"gpt-6.1","trial":2,"status":"graded","score":0.72,"graders":[{"type":"compile","verdict":"pass"},{"type":"cas-assert","passed":5,"total":8},{"type":"rubric-judge","score":0.8,"judgeModel":"claude-opus-4-6@pinned"}],"usage":{"inputTokens":48210,"outputTokens":9114,"totalCost":0.94},"wallMs":184223,"evidence":"bench-results/.../trial-2/","ts":"..."}
{"kind":"bench-summary","cells":600,"failedCells":3,"graderErrors":1,"ts":"..."}
```

---

## 4. CLI surface

```bash
# Run the solver matrix; resumable, ndjson-stable, subprocess-per-cell
texra bench run suites/texra-sci-v1/suite.yaml \
  --model claude-opus-4-6 --model gpt-6.1 --model gemini-3.5-pro \
  --trials 5 --concurrency 8 --filter tag=derivation \
  --scaffold texra --max-cost-usd 250 \
  --results-dir bench-results/ --output-format ndjson

# Grade (or regrade) archived evidence packs; solvers never re-run
texra bench grade bench-results/texra-sci-v1@1.2.0 \
  --grader-version 1.3 --judge-model claude-opus-4-6@pinned \
  --output-format ndjson

# Regrade diff: score deltas attributable to grader changes alone
texra bench grade bench-results/texra-sci-v1@1.2.0 --regrade --diff-against 1.2

# Aggregate: cluster-bootstrap CIs, paired comparisons, pass@k, per-round curves, $/solved-task
texra bench report bench-results/texra-sci-v1@1.2.0 \
  --compare claude-opus-4-6:gpt-6.1 --format md

# CI regression gate: fails only if adjusted p < alpha AND |delta| > MDE
texra bench diff bench-results/run-B --baseline bench-results/run-A --gate

# Suite-integrity gate for CI: schema-valid, inputs pinned & hashed, refs/ isolation,
# gold scores 1.0, sabotage scores <= floor, judge certificates present and in-date
texra bench validate suites/texra-sci-v1/

# Measure an LLM judge against human gold labels; emits the certificate the schema requires
texra bench judge-calibrate suites/texra-sci-v1/tasks/qft-oneloop-vacuum \
  --labels human-labels.jsonl --out refs/judge-cert.json

# Mint error-injection tasks from fresh post-cutoff arXiv papers (renewable supply)
texra bench inject arxiv:2506.01234 --kinds sign-flip,factor,false-lemma \
  --count 6 --seed 42 --out suites/rolling-2026-07/

# Replay archived wire requests byte-identically and diff provider responses
texra bench replay bench-results/.../trial-2 --diff

# Verify a result bundle fully offline: re-hash objects, re-check ledger chains,
# re-run programmatic graders
texra bench verify bench-results/texra-sci-v1@1.2.0

# Interop: Inspect EvalLog export and subprocess embedding
texra bench export bench-results/texra-sci-v1@1.2.0 --format inspect-evallog --out logs/
texra bench exec-sample --stdio < sample.json    # one sample JSON in, AgentEvent NDJSON out

# Interop: emit a suite as Harbor/Terminal-Bench task directories (environment +
# instruction.md + verifier script wrapping `texra bench grade --cell`, writing
# reward.json) so labs run TeXRA science tasks under the harness they already use
texra bench export suites/texra-sci-v1 --format harbor-task --out harbor-tasks/

# RL rollout mode: same tasks, graders emit scalar rewards per episode as NDJSON —
# the verifier stack doubles as a reward function for RL on verifiable science tasks
texra bench rollout suites/texra-sci-v1/suite.yaml --model <endpoint> \
  --episodes 512 --reward-from graders --output-format ndjson
```

**Exit-code contract** (reusing `packages/cli/src/runtime/exitCodes.ts`): scores are data, not exit codes (from the mvp-wedge lens). `bench run` exits 0 even when models score poorly; non-zero means harness/infra failure (1 harness error, 2 usage, 3 model/network after retries exhausted, 124 cancelled, 130 interrupted, 143 terminated). CI gating is explicit opt-in: `bench report --fail-under 0.6` or `bench diff --gate`. `bench validate` exits 1 on any integrity failure — that is the suite-CI contract.

---

## 5. How this builds on existing TeXRA modules

All paths below verified against the repo.

| Bench component             | Existing machinery                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cell execution              | `packages/cli/src/runtime/runExecution.ts` (`executeCliConfig:101`, `executeCliRequest:169`) — request validation, executionId, runtime-host lifecycle, `StreamSnapshotStore` persistence, SIGINT-safe interrupted-status writes; workflow output resolution via `packages/cli/src/runtime/workflowOutput.ts`; tool-use path via `packages/cli/src/commands/agentsRun.ts` |
| Compile gate                | `src/agent/output/compileCheck.ts`, `src/latex/latexToolchain.ts`                                                                                                                                                                                                                                                                                                         |
| Math-aware diff             | `src/latex/latexdiff/` (`service.ts`, `mathMarkup.ts`, `runLatexdiff.ts`)                                                                                                                                                                                                                                                                                                 |
| CAS assertions              | `executeWolframCode` (`src/tools/wolfram/wolframScriptUtils.ts:72`)                                                                                                                                                                                                                                                                                                       |
| Lean grading / solver tools | `runLakeCommand` (`src/tools/lean/direct/lakeCommands.ts:59`); solver-side `src/tools/lean/LspTools.ts`, `src/tools/lean/LoogleTool.ts`                                                                                                                                                                                                                                   |
| Issue localization          | `ReviewIssue` / `report_review_issue` shapes in `src/agent/review/reviewIssues.ts` (file + 1-based startLine/endLine + severity); solver pattern from `packages/extension/resources/tool_use_agents/changeReviewer.yaml`                                                                                                                                                  |
| Structural assertions       | `src/latex/labelSearch.ts`, `src/latex/extractBibliography.ts`, `src/latex/texcount.ts`, `src/latex/latexParsingUtils.ts` (for `\benchstep{k}{...}` extraction)                                                                                                                                                                                                           |
| Fresh-task supply           | `src/latex/arxivProcessor.ts` (pinned tarballs, recorded sha256)                                                                                                                                                                                                                                                                                                          |
| Trace archive               | `TraceEmitter` subscriber pattern from `src/transcript/TexraTranscriptRecorder.ts`; `AgentEvent` union in `src/agent/trace/events.ts`                                                                                                                                                                                                                                     |
| Usage/cost                  | `RunUsageAccumulator` (`src/agent/core/usage/RunUsageAccumulator.ts`, `totalCost` + token fields) — drives the live `--max-cost-usd` abort and $/solved-task reporting                                                                                                                                                                                                    |
| Provider neutrality         | `src/agent/modelHandlers/` (anthropic, openai, google, openrouter); `baseURL` already threaded through the handler stacks (e.g. `modelHandlerAnthropic.ts`, `modelHandlerOpenAI.ts`)                                                                                                                                                                                      |
| Judge + solver agents       | ordinary agent YAML under `packages/extension/resources/agents/bench/` (patterned on `agents/write/paper2slide.yaml` etc.), run through `runAgent` re-exported from `packages/core/src/index.ts`                                                                                                                                                                          |
| Self-correction curves      | per-round outputs via `getOutputFilesByRound` (`src/agent/output/outputState.ts:102`) from the reflection flow (`src/agent/implementations/flows/reflection/`)                                                                                                                                                                                                            |
| Env fingerprint             | `texra doctor` machinery (`packages/cli/src/commands/doctor.ts`)                                                                                                                                                                                                                                                                                                          |
| CI distribution             | `packages/cli/src/commands/installGithubAction.ts` for the `bench diff --gate` regression job (from the interop-standards lens)                                                                                                                                                                                                                                           |
| Approval semantics          | `packages/cli/src/runtime/approvalPolicyAvailability.ts` — bench cells run with never-block approval semantics                                                                                                                                                                                                                                                            |

**Private-endpoint overlay (from the lab-ops-scale lens).** Unreleased internal snapshots behind lab gateways are a hard adoption prerequisite. `models.bench.yaml` registers them purely as config against the existing model registry (`src/model/computeModelOptions.ts`): `{ id, provider: openai-compatible, baseUrl, apiKeyEnv, pricing: zero }`. No code fork — `baseURL` is already threaded through the handler stacks.

**Two small core changes, both additive:**

1. `samplingParams` on the agent config (seed/topP where providers support them; `temperature` already exists in `src/agent/core/definition/AgentDataclass.ts`), plumbed to model handlers — verified absent today (from the mvp-wedge lens). Lands in Stage 1, not the MVP.
2. The wire-ledger event arms (see 7.2).

Everything else is additive code in `src/bench/` (a VS Code-free zone, obeying the platform rules: host services via `platform()`, no new `bus.emit`) and `packages/cli/`.

---

## 6. Grading and verification design

### 6.1 Grader taxonomy

`GraderVerdictSchema` is a discriminated union on `type`: `compile | cas-assert | lean-check | diff-align | issue-match | numeric | struct-match | rubric-judge | human`. Verifiers lead; judges fill gaps under a declared **check-veto precedence policy** (from the scoring-verification lens): a programmatic verifier's `fail` caps the cell score regardless of judge enthusiasm, and a judge only runs on compile-passing artifacts.

- **`compile`** — hard gate via `compileCheck.ts`. Fail ⇒ score 0, later graders skipped.
- **`cas-assert`** — CAS-verified equivalence. **The headline check is outcome-level**: the task's final claimed result (a designated `\benchresult{...}` expression or `<answer>` block) is verified equivalent to gold with `executeWolframCode` (or the SymPy engine for the license-free subset), robust to renotation. Optional `\benchstep{k}{...}` checkpoint markers are graded as a **diagnostic track only** (fraction passed under a monotone prefix rule) — never part of the headline score, because mandating human derivation structure penalizes alien-but-valid solution paths and rewards imitation over correctness (Bitter Lesson, §13). Verdicts are three-valued; CAS timeout ⇒ `unverifiable`, escalated.
- **`lean-check`** — `runLakeCommand` against a pinned mathlib toolchain; binary per lemma, aggregated. The Lean LSP/Loogle tools are available _to the solver_ in tool-use mode — the benchmark measures interactive theorem proving, not one-shot emission.
- **`diff-align`** — math-aware latexdiff between the model's fix and gold: changes inside injected spans must match the gold fix; changes outside are penalized (anti-rewrite-everything). Used only where edits are expected to be local.
- **`issue-match`** — reported `ReviewIssue`s matched to gold defects with a ±N-line window → precision/recall/F1. Grading like a referee report.
- **`numeric` / `struct-match`** — tolerance on Zod-parsed `<answer>` blocks; exact/set match for literature tasks.
- **`rubric-judge`** — a grading agent (pinned model, temperature 0, prompt versioned as agent YAML in-repo) run through the same `executeCliConfig` path as solvers, so every judge call has its own executionId, transcript, wire ledger, and itemized cost (from the scoring-verification lens). Judgments are cached keyed by `(cellDigest, judgeDigest)` so judged scores replay deterministically until the judge identity changes (from the reproducibility-provenance lens). Weight bounded ≤ 0.4 **and expected to trend toward 0** as verifier coverage grows — each suite MINOR release should convert judge-graded criteria into executable checks where possible, and judge prompts stay simple (grade against gold, cite evidence) rather than elaborately rubric-engineered: judge quality improves with judge-model scale, and the regrade-from-evidence design (§7.3) lets every judge-model upgrade re-score history for free (Bitter Lesson, §13). Verifier-only and judged scores are always reported separately.

### 6.2 Task-kind → grader mapping

| Kind            | Graders                                                   |
| --------------- | --------------------------------------------------------- |
| derivation      | compile (gate) + cas-assert (0.6) + rubric-judge (0.4)    |
| proof           | lean-check (1.0)                                          |
| error-injection | issue-match + diff-align                                  |
| paper-artifact  | compile (gate) + structural asserts + rubric-judge        |
| data-analysis   | numeric tolerance, optional sandboxed script re-execution |
| literature      | struct-match                                              |

### 6.3 Falsifiable graders: the calibration contract

`bench validate` enforces, in CI, per task (from the scoring-verification lens, extending the champion's contract):

- schema validity; all inputs pinned and hashed; `refs/` isolation intact (a materializer test asserts no `refs/` file reaches a solver workspace);
- the gold `refs/solution` scores **1.0**;
- the sabotage baseline (`copy-input`, empty-fix, restate-the-problem) scores **≤ floor** (default 0.05);
- injected documents compile, and gold fixes restore latexdiff-equality to the original;
- every `rubric-judge` grader has an in-date calibration certificate.

Grader quality is thereby a CI gate, not a promise.

### 6.4 Judge-calibration certificates (from the scoring-verification lens)

`texra bench judge-calibrate` measures a judge grader against human gold labels on a calibration set: Cohen's kappa, systematic bias, blind-swap (order-randomization) consistency. It emits a certificate file (`refs/judge-cert.json`: judge model + prompt digest, kappa, n, expiry tied to suite MINOR version). The task schema _requires_ the certificate before a judge grader's scores count as trusted; suites publish judge–human agreement per release, and judge error is propagated into score CIs (from the benchmark-lifecycle lens). Cross-provider judge panels (blinded, order-randomized, Krippendorff's-alpha agreement gates) are available where single-judge kappa is insufficient — native, because `src/agent/modelHandlers/` already abstracts four providers.

### 6.5 Statistics core (from the benchmark-lifecycle lens)

`src/bench/stats/` ships as an importable module (usable outside the CLI):

- **Cluster bootstrap BCa CIs** resampling task _families_ (the `family` field), not individual tasks, with a recorded PRNG seed;
- **Paired-by-task sign-flip permutation tests** for model comparisons (much tighter than unpaired), with **Benjamini–Hochberg correction** across the comparison matrix;
- **Variance decomposition** (task vs. replicate vs. residual) with a power calculator; replicate floor R ≥ 4 enforced for ranked reports;
- **Regression gates require both** adjusted p < alpha **and** |delta| > a declared minimum detectable effect — what keeps `bench diff --gate` from flapping on underpowered diffs between snapshots;
- **Tie-grouped leaderboard ranks**: models whose paired comparison is non-significant share a rank band; CIs are mandatory display; `bench report` refuses to render a ranking arrow when the paired CI crosses zero; deprecated or MAJOR-mismatched scores are unrankable by construction;
- pass@k / pass^k, and **self-correction curves** from per-round scores — a first-class metric no single-shot harness produces;
- **cost as a first-class metric**: $/solved-task per model from `RunUsageTotals`, so labs budget trials honestly.

Honest determinism throughout: providers expose no usable seeds (temperature is even force-overridden per model in the handlers), so replicate variance is _measured and reported_, never pretended away (from the benchmark-lifecycle lens).

---

## 7. Reproducibility story

### 7.1 Content-addressed identity (from the reproducibility-provenance lens)

Every run writes `bench.lock.json`: content digests of the suite and each task, agent YAML digests, **post-template-resolution prompt digests** (after shared-partial expansion — the prompt the model actually saw), resolved model ids and sampling params, judge identities, grader code digests, model-registry snapshot, and the toolchain fingerprint (TeX Live, wolframscript, lake, container image digest, from the `doctor` machinery). **Two scores are comparable if and only if their digest tuples match**; `bench report` refuses cross-lock comparisons by default.

### 7.2 The wire ledger (from the reproducibility-provenance lens)

Today no raw provider request/response is persisted anywhere in TeXRA — traces are flow-level. We add two **additive** arms to the `AgentEvent` discriminated union (`src/agent/trace/events.ts`): `model.request` and `model.response`, captured at the single `ModelHandler.createResponse` choke point (`src/agent/modelHandlers/ModelHandler.ts:787`, the template that wraps every subclass's `createResponseImpl`), with **emit-time redaction** of API keys and auth headers. Per execution they persist as a **hash-chained `wire.jsonl`** (each record carries the previous record's hash), making every evidence pack tamper-evident and byte-level replayable:

- `bench replay --diff` re-sends archived requests byte-identically and diffs responses — provider drift becomes a measured observation, not a silent confound;
- the ledger ships standalone as Stage-0 value for all three hosts (debugging, audit), independent of bench.

### 7.3 Regrade, don't rerun

Scorers are pure functions over persisted evidence. A grader bug found after publication is a MINOR suite bump plus `bench grade --regrade --diff-against <old>`: history is recomputed from archives at zero model cost, and the published score-delta report attributes every change to the grader diff.

### 7.4 Hermetic execution

Stage 1 publishes a container image pinning TeX Live, Lean toolchain, and wolframscript availability flags; `env.json` in every pack records the fingerprint. Tool-use task kinds are marked `requiresSandbox` and refused outside the container (network off by default; task workspace read-write, everything else read-only). Web tools are disabled via the existing `runtimeUnavailableTools` mechanism (`src/agent/runtime/RunContext.ts`) rather than a new sandbox layer (from the reproducibility-provenance lens).

### 7.5 Offline verification and blind provenance (from the reproducibility-provenance lens)

Result bundles are Merkle-rooted and signable. `texra bench verify` re-hashes all objects, re-checks wire-ledger chains, and re-runs programmatic graders fully offline to confirm the summary derives from the evidence. Labs with private data publish digests plus signed summaries — any party holding the data can independently verify the published numbers without the data ever leaving the lab.

### 7.6 Contamination lifecycle

- **Renewable supply**: `texra bench inject` mints error-injection tasks monthly from post-cutoff arXiv papers (pinned via `arxivProcessor.ts`, tarball sha256 recorded), with seeded, machine-verified gold defect lists — turning contamination control from detection into a supply of provably fresh tasks (from the lab-ops-scale lens).
- **Detection**: per-pack canary GUIDs with a canary-scan over archived model outputs (from the benchmark-lifecycle lens); a held-out private split with the public-vs-private score gap tracked per model per release as a standing alarm, with its own CI.
- **Provenance**: `createdAfter` enforced per suite release; paraphrase/renotation passes on injected sources; difficulty-vs-date correlations tracked rather than claiming immunity.

---

## 8. Interoperability (from the interop-standards lens)

First-class from Stage 1, not an afterthought — the pack format and graders, not the runner, are the adoption unit:

1. **Inspect EvalLog export**: `bench export --format inspect-evallog` emits logs in Inspect's EvalLog JSON schema so `inspect view` opens TeXRA-bench results with zero tooling. The mapping from the `AgentEvent` union is mechanical, and the wire ledger makes the export higher-fidelity than flow-level transcripts alone. A CI conformance job validates emitted logs against pinned `inspect_ai` pydantic models.
2. **`exec-sample` stdio protocol**: one sample JSON on stdin, AgentEvent NDJSON on stdout, a final sample-result record last — so Inspect, lm-eval, or any internal harness drives TeXRA as a subprocess without adopting a new runner. This rides the already-sacred byte-stable headless parity.
3. **Plugin ports** (from the harness-architecture lens): `commandSolver` / `commandScorer` speak JSON-on-stdio, letting a lab drive its internal model stack and graders through TeXRA benchmark packs without adopting TeXRA's providers at all.
4. **Provider surface**: the four in-repo handler stacks plus OpenRouter for long-tail models; internal checkpoints via the `models.bench.yaml` openai-compatible overlay (Section 5).
5. **Harbor / Terminal-Bench task export** (see §12): `bench export --format harbor-task` emits each task as a Harbor-conformant directory — container environment, `instruction.md`, and a `tests/test.sh` verifier that invokes `texra bench grade --cell` and writes `reward.json` to `/logs/verifier/` — so the suite runs unmodified under the agentic-eval harness frontier labs have already standardized on. The oracle `solution/` folder is generated from `refs/gold-solution.tex`, satisfying Harbor's solvability check with the same artifact our `bench validate` gold-scores-1.0 gate uses.
6. **RL rollouts**: `bench rollout` exposes the grader stack as a scalar reward function over episodes (reward = verifier score; judge residual excluded by default), because the Harbor lesson is that the eval harness that doubles as training infrastructure is the one that gets adopted — labs want verifiable-reward science environments for RL at least as much as they want leaderboards.

---

## 9. Staged rollout

### Stage 0 — MVP (4–6 weeks)

- `src/bench/` schema + runner (subprocess supervisor, resume, retry-on-exit-3) + evidence packs; `texra bench run|grade|report`.
- Graders: `compile`, `numeric`/`struct-match`, `cas-assert` (Wolfram), `diff-align`.
- Wire ledger lands (additive `AgentEvent` arms + `wire.jsonl`) — standalone value even before bench matures.
- `refs/` scorer-only namespace and canary GUID in the schema from day one (cheap now, breaking later).
- Seed suite of ~25 tasks (derivation + error-injection + paper-artifact) on the existing agent YAML system.
- Everything rides the hardened headless path; the MVP is grading + scheduling code, not infrastructure.

### Stage 1 — Rigor (next 6 weeks)

- `bench validate` calibration contract (gold 1.0 / sabotage ≤ floor / refs isolation) enforced in CI.
- Statistics core: cluster-bootstrap CIs, paired permutation tests with BH correction, MDE-floored `bench diff --gate`, tie-grouped reports.
- Hermetic container image; `env.json` fingerprints mandatory; `requiresSandbox` enforcement.
- Grader versioning + regrade-diff reports; `issue-match` and `lean-check` graders.
- `bench judge-calibrate` and calibration certificates; `scaffold: minimal|texra` hash-locking.
- `samplingParams` core-schema addition; `bench.lock.json` with post-resolution prompt digests.
- Inspect EvalLog export + `exec-sample` stdio protocol with CI conformance (pulled forward from the champion's Stage 3, per the interop-standards graft).

### Stage 2 — Renewable content (quarter 2)

- `texra bench inject` productionized: monthly rolling suites from post-cutoff papers, seeded and machine-verified (injected doc compiles; gold fix restores latexdiff-equality).
- Public **TeXRA-Sci-100** release (versioned, licensed, per-task provenance) plus a held-out private split; public–private gap monitoring per model per release.
- SymPy `cas-assert` engine for the Wolfram-license-free subset; Wolfram-required tasks tagged and filterable.
- Human-adjudication grader kind with escalation queue.
- `bench export --format harbor-task` (§12) so the public suite is runnable under Harbor from its first release; `bench rollout` alpha exposing graders as RL rewards.

### Stage 3 — Frontier-lab integration (quarter 3)

- `commandSolver`/`commandScorer` stdio plugin ports; `models.bench.yaml` overlay documented as the internal-checkpoint path.
- Signed Merkle bundles + `bench verify` offline verification; published reproducibility-bundle policy: every leaderboard number links to evidence sufficient to regrade it.
- `bench replay --diff` provider-drift monitoring.
- `bench diff --gate` as a one-command CI install via the existing `texra install-github-action` channel.
- In-process SessionHandle pooling evaluated as an optimization, only once test-locked.
- **Success criterion**: one external lab running the private split pre-release on an internal checkpoint through its own gateway.

---

## 10. Non-goals

- **Not a general eval harness.** No MMLU-style Q&A hosting, no attempt to replace Inspect/lm-eval/HELM/Harbor — we export to them and embed under them.
- **No leaderboard web service.** Reports are files (MD/HTML/JSON); hosting is out of scope.
- **No bitwise model determinism claims.** Providers don't offer it; we measure variance instead.
- **No new sandbox technology.** Hermeticity = published container + existing tool-availability gating; we do not build an isolation layer.
- **No live-web literature tasks.** Corpora are bundled and pinned; live fetching would destroy reproducibility.
- **No free-form-rewrite diff scoring.** Math-aware diffing scores local edits; open-ended generation quality remains the bounded, certified judge residual.
- **No human-labeling platform.** The escalation queue records verdicts; sourcing and managing annotators is the operator's problem.

---

## 11. Open questions

1. **Wolfram licensing in shared CI.** How large can the SymPy-expressible assertion subset be made in practice? Do we need a hosted verification service for the Wolfram-required subset, and who bears the license?
2. **Judge-certificate expiry policy.** Per suite MINOR version, per judge-model release, or time-based? What kappa floor gates publication (0.7? per-task-kind floors)?
3. **`\benchstep` gaming.** Models could emit checkpoint markers containing restated targets rather than derived intermediates. Does the monotone prefix rule plus judge residual suffice, or do we need CAS checks that each step _follows from_ the previous one (a harder inference problem)?
4. **Wire-ledger redaction completeness.** Emit-time redaction must survive provider SDK changes (new header fields, streaming frames). Do we allowlist rather than denylist payload fields?
5. **Injection realism.** Are seeded defects distinguishable from natural errors by style alone? Should a discriminator study (human experts guessing injected-vs-natural) gate each rolling release?
6. **Cross-scaffold comparability.** Is `minimal` scaffold truly minimal across four provider handler stacks with different tool-calling conventions, or do we need a per-provider minimal-scaffold conformance test?
7. **In-process pooling timeline.** What test-lock criteria (per-cell `SessionHandle`, no process-global approval state) must `docs/proposals/session-handle-7d-design.md` satisfy before the subprocess supervisor gets an in-process fast path?
8. **Private-split governance.** Who holds the held-out split, under what disclosure agreement, and how are labs prevented from overfitting to it across quarterly releases (rotation cadence, one-shot access)?
9. **Inspect schema pinning.** EvalLog evolves; how aggressively do we track upstream `inspect_ai` versions vs. pinning a conformance target per bench release?

---

## 12. Comparison with Terminal-Bench / Harbor

Terminal-Bench is the closest existing artifact to what this proposal builds, and the most instructive adoption case study: released May 2025, adopted by essentially every frontier lab within months, re-released as Terminal-Bench 2.0 in November 2025 (89 tasks, ~3 reviewer-hours of human auditing each, frontier models under 65%) alongside **Harbor**, a ground-up rewrite of the harness for containerized agent evals and RL rollout generation at cloud scale.

### What Terminal-Bench gets right (and we adopt)

| Terminal-Bench / Harbor                                                                                 | TeXRA Bench equivalent                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A task is a container env + `instruction.md` + executable verifier writing a reward file — nothing else | General `workspace → artifacts → grader verdicts` contract (§3.2); task kinds are conventions, not harness code     |
| Oracle `solution/solve.sh` must pass the verifier before a task ships                                   | `refs/gold-solution` must score 1.0 under `bench validate` (§6.3), plus sabotage baselines TB doesn't have          |
| Binary, executable, outcome-level verification — no LLM judge in the headline metric                    | Compile gates + CAS/Lean outcome checks headline; judge residual bounded, separately reported, trending to 0 (§6.1) |
| Isolated Docker per task; pinned images                                                                 | Hermetic container + `env.json` fingerprints (§7.4)                                                                 |
| Dataset registry with versioned pinning (`terminal-bench@2.0`)                                          | Suite semver with digest-gated comparability (§3.1, §7.1)                                                           |
| Harbor doubles as an RL-rollout generator — evals and training environments from one task format        | `bench rollout` exposing graders as scalar rewards (§4, §8)                                                         |
| Agent adapters (Claude Code, Terminus, Codex CLI, …) — harness is agent-agnostic                        | `scaffold: minimal` headline + `exec-sample` stdio + `commandSolver` port (§2, §8)                                  |

### Where the two genuinely differ

1. **Domain and verifier depth.** Terminal-Bench verifies _terminal-observable end states_ (files, processes, exit codes) — its verifier vocabulary is shell + pytest. Science tasks need verifiers no generic container check provides: CAS equivalence robust to renotation, Lean proof checking, LaTeX compile-and-structural-diff, referee-style issue matching. That verifier library — not the runner — is TeXRA Bench's reason to exist.
2. **Grading is data, not just exit codes.** TB emits a reward file per task; we emit content-addressed `ScoreRecord`s with evidence pointers, three-valued verdicts (`unverifiable` ≠ fail), and regrade-from-archive. This is what makes score disputes auditable and grader bugs a zero-cost migration (§7.3) — a real gap in TB, where a verifier bug means re-running agents.
3. **Statistics.** TB reports accuracy; task-level binary outcomes on 89 tasks leave ranking noise unquantified. Our stats core (cluster bootstrap, paired tests, MDE-floored gates, §6.5) is a differentiator — but §13 warns against letting measurement sophistication substitute for task supply.
4. **Contamination strategy.** TB's defense is task freshness at curation time; ours is structural (`refs/` isolation, canaries, post-cutoff renewable injection supply, public/private split monitoring, §7.6).
5. **Multi-round / long-horizon structure.** TB is one-shot agent-in-a-box; our reflection-flow machinery yields per-round self-correction curves (§6.5) as a first-class capability measurement.

### The adoption lesson we take seriously

Terminal-Bench did not win because its measurement science was sophisticated — it won because (a) the task contract was so simple that hundreds of people could author tasks, (b) the harness doubled as RL training infrastructure exactly when labs were scaling RL on verifiable rewards, and (c) quality control was legible (oracle-solvable, human-audited, hard: frontier <65%). The implications for TeXRA Bench are codified in §13, and the concrete interop commitment is `bench export --format harbor-task` (§8): a lab that already runs Harbor should be able to run TeXRA-Sci without adopting our runner at all. We compete on verifiers and task supply, not on the harness.

---

## 13. The Bitter Lesson, applied to benchmark design

Sutton's Bitter Lesson: general methods that leverage computation beat human-knowledge engineering, every time the compute arrives. A benchmark is not exempt — hand-engineered structure in _how we grade_, _what solution shape we demand_, and _how tasks are made_ is human knowledge that models will route around, saturate, or expose as bias. Revised principles, applied throughout this document:

1. **Outcome over process.** The headline score verifies the _end state_ (final result CAS-equivalent to gold, proof compiles, defect fixed, artifact compiles and matches structurally) — never adherence to a human solution path. `\benchstep` checkpoint grading is demoted to a diagnostic track (§6.1): forcing models to show human-shaped work penalizes alien-but-valid derivations, and "the model derived it a way no human would" is a finding, not a rubric violation.
2. **A general contract, thin harness.** One task contract (`workspace → artifacts → executable verdicts`); task kinds are grader-stack conventions, not runner code (§3.2). Every piece of taxonomy baked into the harness is structure someone must undo later; every convention layered on a general contract is free to replace.
3. **Task supply must scale with compute, not curation.** Artisanal suites bootstrap; the _generation pipeline_ is the product. `bench inject` (§7.6) — machine-minted, machine-verified, gold-by-construction tasks from post-cutoff papers — is the asset that compounds: more compute → more tasks, fresher tasks, harder tasks. Hand-curated rubrics scale with reviewer-hours; injection scales with FLOPs. Stage 2 priorities reflect this.
4. **No difficulty ceiling by construction.** Difficulty must be a _dial_ (longer horizons, harder source papers, more subtle injected defects, deeper proof obligations), not a fixed curated level — otherwise the benchmark saturates and dies. Verification asymmetry is what makes this safe: checking a result is cheap even when producing it is superhuman, so tasks can outgrow their authors. (Gold solutions are required only where verifiers need them; proof tasks need only the statement.)
5. **Scaffold-minimal headline.** Scaffolds are human knowledge wrapped around the model and their value decays with capability; headline numbers are `minimal`-scaffold, with the TeXRA scaffold measured as an explicit, separately-reported delta (§2).
6. **Judges: eliminate, then scale — don't engineer.** Prefer converting judged criteria into executable checks each release; where a judge remains, use a simple prompt with a strong pinned model rather than elaborate rubric engineering, keep its weight bounded and trending to 0, and let judge-model upgrades improve grading retroactively via regrade-from-evidence (§6.1, §7.3). Calibration certificates (§6.4) remain — as _measurement_ of the judge, not as a bureaucratic substitute for verifiers.
7. **Be RL-ready.** Verifiable outcome rewards on science tasks are training fuel, not just leaderboard fodder. The same graders that score evals emit episode rewards through `bench rollout` (§4) — the Harbor lesson: infrastructure that feeds training loops gets adopted; leaderboards alone get cited.

What this explicitly does **not** mean: abandoning rigor machinery (lockfiles, wire ledger, stats core) — reproducibility is what makes scaled, machine-generated evaluation _trustworthy_, and it costs no model-knowledge assumptions. The Bitter Lesson cuts against hand-engineering the _content_ of evaluation, not against engineering its _evidence_.
