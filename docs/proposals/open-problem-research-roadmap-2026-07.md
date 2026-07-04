# Open-Problem Research Roadmap — July 2026

**Status:** Proposal
**Theme:** Make TeXRA better at attacking open theoretical math/physics problems, make agents run (much) longer, and make the harness *lighter* as models get stronger.

## Method

This document was produced by an idea tournament rather than a single-pass brainstorm:

1. **Generate** — five independent idea generators, each with a distinct lens (bitter-lesson harness minimalism, long-horizon autonomy, math/physics research practice, inference-time scaling, researcher UX), each grounded in a verified map of the current codebase. 29 raw ideas.
2. **Dedup** — merged into 23 canonical candidates.
3. **Seed** — three judges scored every candidate on a single criterion each: research impact, bitter-lesson fit (does it make the harness lighter?), and engineering leverage on the existing substrate.
4. **Bracket** — top 8 seeds played head-to-head quarterfinals and semifinals; the final was decided by a 3-judge majority.

The full ranking and bracket record are in the appendix.

## Governing principle (design constraint)

**Selection machinery is agentic orchestration, not harness code.** Tournament / best-of-N / judge / debate mechanisms should be run *by the orchestrator agent* using the existing delegation primitives (`delegate_agent`, worktree isolation, FollowUpQueue delivery, cost roll-up) — not encoded as new deterministic flows. The harness contributes only what agents cannot do for themselves:

- **parallel attempt plumbing** (already exists: `src/tools/delegation/subagentExecution.ts`),
- **ground-truth verification** the model cannot game (the VerifierReport, below),
- **budgets** that bound the whole tree (below).

The tournament independently converged on this: the one candidate that proposed a hardcoded `TournamentFlow` with FanOut/Verify/Judge/Select nodes seeded 21st of 23, penalized by the bitter-lesson judge as scaffolding a stronger model makes obsolete. Everything below respects the constraint.

---

## Champion — Research Ledger with typed claims (C7)

*Won the final 3–0. A compaction-proof lab notebook wired into continuations, compaction, completion, and mechanical re-verification.*

One durable, structured state-of-the-problem file per Goal: lemma DAG with statuses (`PROVED / GAP / CONJECTURE / REFUTED`), attempts and dead ends with the exact obstruction, verified computational ranges, and a **typed evidence pointer on every load-bearing claim** — a discriminated union of `lean` (file + declaration, revalidated via `lean_diagnostics`/`lean_inspect`), `cas` (re-runnable WolframScript execution id), `computation` (bash execution id), and `citation` (DOI/arXiv, resolvable via crossref/arxiv/zotero). Claim status: `verified / stale / broken / unbacked`.

The context window becomes a cache; the ledger is the state.

**Mechanism** (all wiring points verified to exist):

1. Extend the memory tool (`src/tools/memory/MemoryTool.ts`, `MEMORY_STORAGE_ROOT`) with a ledger command set at `/memories/goals/<goalId>/ledger`, Zod-schema'd.
2. The Goal continuation (`src/agent/goal/maybeBuildGoalContinuation.ts`) injects a `{{ledgerDigest}}` — a deterministic render of the ledger head plus the Attempts table — instead of relying on conversation history. The loop becomes self-healing after total context loss, and the "consult Attempts before choosing a direction" step kills repeated dead ends.
3. Compaction defers to the ledger instead of squeezing proof state into a 2,000-token summary (`contextManagementConstants.ts`).
4. `plan(command="complete")` cross-checks the ledger: completion is rejected while any lemma on the main theorem's dependency path is `GAP` (`src/tools/plan/PlanTool.ts` already has the reject-with-guidance branch; this replaces exhortation with a check).
5. `texra claims verify` mechanically re-executes every evidence pointer — re-run `lean_diagnostics` on the named declaration, re-execute the stored WolframScript, re-resolve the DOI — flipping statuses **with zero model calls**. The researcher's trust cost collapses from "reread the transcript" to "scan the red rows."
6. `PersistedFlow.setProjection` projects a ledger index into the `ExecutionKVStore` so the progress view renders a green/amber/red claims table; `criticize`-lineage agents take the ledger as input and attack unbacked claims first.

**Why now:** weak models couldn't keep an honest notebook, so harnesses compensated with ever-cleverer compaction. Strong models maintain accurate structured ledgers when the template demands evidence pointers — so the harness *shrinks*: dumber compaction, smaller live context, verification moved out of the model loop into deterministic re-execution. Trust scales with run length instead of decaying. `prover.yaml` already mandates this discipline in prose; this moves it from exhortation into a checkable artifact.

## Runner-up — VerifierReport: deterministic ground truth as a data model (C17)

*Lost the final only on breadth; the final judges called it "elegant and un-gameable." It is the evidence layer the Ledger's pointers and every agentic tournament key on.*

A single Zod `VerifierReportSchema` in a new host-agnostic `src/agent/verification/` module, with per-check entries `{kind: lean_build | lean_sorry_audit | numeric_spotcheck | latex_compile | symbolic_identity, status: pass | fail | unavailable, evidence}`. Runners wrap what already exists:

- **Lean:** existing LSP services + a source audit for `sorry` / `admit` / `native_decide` / new axioms — a proof passes only with clean diagnostics *and* a clean axiom audit.
- **Numeric spot-checks:** the attempt is required to emit a `checks.wls` artifact; the harness evaluates the claimed identities/inequalities at **randomized parameter values drawn by the harness, not the model**, so test points can't be cherry-picked.
- **LaTeX compile:** the existing `src/latex/` pipeline.

Exposure (per the governing principle, no selection flow): a `verify_attempt` tool that orchestrators and skeptic agents invoke, and a report **stapled to every delegated attempt's result** in `formatSubagentDelivery` (`src/tools/subagentResults.ts`) so a parent judging N attempts always sees code-trusted evidence next to each one. Verifier evidence dominates judge opinion; self-report is ignored.

**Why now:** inference-time scaling is bounded by verifier quality — with ground truth, N attempts approach best-of-N; without it, majority-vote at best. Strong models can now reliably *produce* the verification artifacts (compiling Lean formalizations, WolframScript check programs); the harness side was always the easy part. Pure deterministic code, no new prompts.

## Semifinalists

### Goal budgets with pause-not-kill semantics (C3) — top seed (8.7)

The Goal loop is literally unbounded today: no cost, token, wall-clock, or cycle cap exists (flagged in `docs/proposals/error-pipeline-and-ownership.md`). Add optional budget fields to `GoalSchema`; enforcement is a comparison at the existing choke point (`maybeBuildGoalContinuation`), since `RunUsageAccumulator` already tracks total cost *including subagent roll-up*. At 80%: soft warning. At 100%: wind-down template ("bank state into the ledger, pause") through the existing `GoalStore.setStatus('paused')` path with `pausedReason: 'budget_exhausted'` and one-click extend-and-resume. Simultaneously **shrink the ~25-line "keep pursuing" continuation nag** to a thin status line (`<goal_status elapsed="2h13m" cost="$4.10/$25"/>`) — strong models hold an objective for hundreds of turns; what they need is telemetry to self-pace, not motivation. This is the trust prerequisite for overnight runs: people run agents longer when spend is capped.

### Goal Daemon: crash-durable auto-resume (C9)

Multi-day runs die today because the *process* dies — rate-limit storms, laptop sleep, extension-host reloads — not because the model gets lost. `PersistedFlow` already makes mid-run resume correct; the missing piece is "who presses resume at 3am." Classify pauses (`pausedReason: provider_error | budget_exhausted | user | handoff`) with backoff timestamps; add `texra goals list|resume` on the existing `resumeExecution.ts` path; `texra goals daemon --interval 5m` (or a two-line systemd unit) polls and resumes eligible goals headlessly. A resumed goal needing a human answer files an async `inquiry` and re-pauses instead of blocking.

## Quarterfinalists (all worth building)

- **Model-driven context (C4, seed #4):** delete the client-side compaction summarizer (`COMPACTION_SYSTEM_PROMPT`, 2,000-token cap) on the OpenAI-compat path. At the same 75% threshold, do structural truncation instead: elide old *tool results* to one-line stubs, preserve all assistant reasoning and user turns verbatim, and tell the model once that its files/todos/memory are intact and re-readable. With the Ledger in place, summarize-on-behalf-of-the-model is strictly worse than drop-and-re-read. Deletes a whole class of bugs (summarizer retries, mid-compaction interruption state, cross-provider summary drift).
- **Recursive delegation under one budget (C6, seed #2):** the depth gate (`maxDepth` default 1 in `subagentExecution.ts`) forbids exactly the decomposition open problems want — an orchestrator spawning provers that spawn lemma-verifiers. Delete the gate (or degrade it to a runaway-recursion ceiling of ~5) and let the **shared budget (C3), not depth, bound total work**; replace hardcoded team-preset rosters with a dynamically generated `<available_agents>` list in the `delegate_agent` description. Unbounded-depth-under-bounded-cost is the lighter, safer invariant.
- **Context Rebirth: `plan(command="handoff")` (C8):** let the agent deliberately end its own context and continue the goal in a fresh execution seeded only from the objective + ledger digest + a self-written handoff brief (reusing the subagent seeding pattern, sequentially, so depth is irrelevant). Long runs become a chain of bounded-context legs at full attention instead of one endlessly-compacted conversation; the goal record gains `legs[]` for the progress view. Long-agent postmortems consistently show degradation with context age even under good compaction — rebirth is the clean fix.
- **Lean Lemma Escrow (C12):** when the prover marks a lemma load-bearing, a ledger status transition (`GAP → IN_ESCROW`) auto-delegates it to the existing `lean` agent: first `lean_loogle` Mathlib (don't re-prove known results), else autoformalize and iterate against `lean_diagnostics` in a worktree. Promotion to `VERIFIED` is **mechanical** — clean diagnostics plus a `sorry`/`admit`/axiom audit — so a hallucinated "I proved it" cannot promote. A `REFUTED` verdict is gold: it kills a wrong branch early, in parallel, while the prover keeps attacking the main problem.

## Tournaments, best-of-N, and judging — as orchestration patterns

Per the governing principle, these ship as **agent/prompt patterns plus two small primitives**, not flows:

- **Primitives (harness):** `verify_attempt` + stapled VerifierReports on subagent delivery (C17); recursive delegation under a shared budget (C6/C3). That's all the code.
- **Best-of-N (orchestrator pattern):** the orchestrator enumerates M genuinely distinct attack strategies first (generating-function vs. spectral vs. probabilistic-method), then delegates N attempts *each contractually committed to one strategy and prohibited from the others* — strategy diversity, not sampling noise, is where the marginal value of an attempt comes from. Failed attempts must return "what I learned"; that feeds the next generation and tells the judge which approaches are exhausted. Cross-model diversity (the handler registry already abstracts providers) is a free second axis.
- **Judging (agent pattern):** a judge agent receives the problem statement plus each surviving attempt's artifact **with model names, costs, and reasoning traces stripped** (blind judging), plus each VerifierReport. Verifier-passing attempts strictly outrank failing ones regardless of judge opinion; the judge only breaks ties among survivors.
- **Prover–Skeptic (agent pattern):** a skeptic agent that never sees the prover's chain-of-thought — only the artifact and the problem statement — and must either report a concrete gap (exact line, candidate counterexample) or sign off. Termination on k consecutive clean sign-offs is the orchestrator's judgment call, not flow logic.
- **Completion Gate (C11, one small hook):** intercept `plan(complete)` on research Goals — before the goal ends, delegate the deliverable + ledger (and nothing else — fresh context is the point) to a referee with `wolfram` + `bash` + `lean_loogle`; a confirmed fatal gap bounces completion back through the existing reject-with-guidance branch with the specific findings. Gating the *only exit* of the autonomous loop is the single highest-leverage checkpoint in the system, and it directly counters the known strong-model failure mode: being persuasive to oneself.

These patterns live in agent YAMLs (`orchestrator`, a hardened `skeptic`, a `referee`) and the delegation tool descriptions. When a better selection strategy emerges, you edit a prompt, not a flow.

## Bitter-lesson subtractions (independent, high seeds, do opportunistically)

- **One Loop (C1, seed #9):** retire the reflection flow. Run workflow agents (correct/polish/merge/ocr) on the tooluse loop with read/edit/compile tools: the model edits `.tex` files surgically and decides itself whether a second pass is needed. Deletes ~850 lines of reflection nodes, the 496-line `XmlOutputManager`, whole-document re-emission, prefill/truncation-recovery machinery, and the hardcoded `rounds: 2`. `latexdiff` is computed once post-run from base-vs-edited files.
- **Delete the silent replacement engine (C2, seed #10):** every provider handler pipes model output through a 3,276-line regex rewrite engine — blind substitution over LaTeX that can corrupt math and hides what the model actually wrote from the trace. Fold the genuinely stylistic rules into the existing `{{LATEX_STYLE_RULES}}` prompt injection; keep rule tables at most as a post-run lint the model fixes itself. Silent mutation of proofs is an unacceptable correctness risk for math-heavy documents.

## Suggested sequencing

1. **C3 Goal budgets** — days of work, unlocks trust for everything else, and deletes the continuation nag.
2. **C7 Research Ledger** — the champion; land the schema + continuation digest + `claims verify` first, the progress-view projection second.
3. **C17 VerifierReport** — the evidence layer; staple to subagent delivery from day one.
4. **C9 Goal Daemon + C8 handoff** — together these make multi-week campaigns survivable.
5. **C6 depth-gate removal + orchestration patterns** (best-of-N, skeptic, completion gate) — prompts and YAMLs, iterated cheaply once 1–3 exist.
6. **C1/C2 subtractions** — opportunistic; each is independent and pure deletion-plus-prompt.

---

## Appendix: tournament record

**Final:** C7 Research Ledger def. C17 VerifierReport, **3–0**. Judges verified grounding claims against source before voting; the deciding argument: C7 addresses all three goals (longer runs via ledger-seeded continuations, open problems via typed evidence, lighter harness via dumber compaction), while C17 addresses one — and C17's mechanism survives as C7's evidence layer.

**Semifinals:** C7 def. C3 (budgets govern whether a run continues, not what it accomplishes; retrofittable in days at any time). C17 def. C9 (verification is the binding constraint; auto-resume automates a path that already exists manually).

**Quarterfinals:** C3 def. C12 · C9 def. C6 · C17 def. C8 · C7 def. C4.

**Seeding (3-judge mean, criteria: research impact / bitter-lesson fit / engineering leverage):**

| # | ID | Score | Candidate |
|---|----|-------|-----------|
| 1 | C3 | 8.7 | Goal budgets with pause-not-kill semantics |
| 2 | C6 | 8.0 | Recursive delegation under one budget |
| 3 | C17 | 8.0 | VerifierReport ground-truth harness |
| 4 | C4 | 7.7 | Delete client-side compaction summarizer |
| 5 | C7 | 7.7 | Research Ledger with typed claims |
| 6 | C8 | 7.7 | Context Rebirth (`plan(handoff)`) |
| 7 | C9 | 7.7 | Goal Daemon auto-resume |
| 8 | C12 | 7.7 | Lean Lemma Escrow |
| 9 | C1 | 7.3 | One Loop (retire reflection flow) |
| 10 | C2 | 7.3 | Delete the silent replacement engine |
| 11 | C11 | 7.3 | Completion Gate + rut detector |
| 12 | C10 | 7.0 | Detached deep-think legs (provider background mode) |
| 13 | C23 | 6.7 | Night Auditor scheduled adversarial sweep |
| 14 | C13 | 6.3 | Falsification Engine (counterexample search) |
| 15 | C20 | 6.3 | Morning Brief research log |
| 16 | C21 | 6.3 | Ballot checkpoints via inquiry |
| 17 | C5 | 6.0 | Task cards, not agent zoo |
| 18 | C16 | 6.0 | Prover–Skeptic adversarial flow |
| 19 | C14 | 5.7 | Ladder Plans (special-case laddering) |
| 20 | C22 | 5.7 | Problem Campaigns attack tree |
| 21 | C15 | 5.3 | TournamentFlow (hardcoded best-of-N flow) |
| 22 | C19 | 4.3 | Approach-commitment diversity forcing |
| 23 | C18 | 3.7 | Evolutionary refinement w/ successive halving |

Low-seeded candidates were not all discarded: C16 (skeptic), C19 (diversity forcing), C11 (completion gate), and C15's blind-judging/verifier-dominance rules were **reframed as orchestration patterns** in the tournaments section above — their content survives; their proposed harness machinery does not, per the governing principle.
