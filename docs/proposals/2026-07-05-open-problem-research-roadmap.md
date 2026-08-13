# Open-Problem Research Roadmap — July 2026

**Status:** Proposal (v3 — freedom-first revision, Track 1 updated with maintainer decisions from PR #7090 review)
**Theme:** Make TeXRA better at attacking open theoretical math/physics problems, make agents run (much) longer, and make the harness _lighter_ as models get stronger — by giving the agent more freedom, not more supervision.

## Method

This document was produced by an idea tournament rather than a single-pass brainstorm:

1. **Generate** — five independent idea generators, each with a distinct lens (bitter-lesson harness minimalism, long-horizon autonomy, math/physics research practice, inference-time scaling, researcher UX), each grounded in a verified map of the current codebase. 29 raw ideas.
2. **Dedup** — merged into 23 canonical candidates.
3. **Seed** — three judges scored every candidate on a single criterion each: research impact, bitter-lesson fit (does it make the harness lighter?), and engineering leverage on the existing substrate.
4. **Bracket** — top 8 seeds played head-to-head quarterfinals and semifinals; the final was decided by a 3-judge majority.

The full ranking and bracket record are in the appendix. **v2 revision:** the winning ideas were subsequently re-filtered through a stricter freedom-first principle (below); control-flavored mechanisms that survived the tournament — harness-enforced completion gates, typed-schema enforcement, rut detectors — were demoted from harness code to conventions and opt-in tools.

## Governing principles

### 1. The harness provisions; it does not supervise

The bitter lesson, applied to agent harnesses: every place the harness second-guesses the model — fixed round counts, motivational nags, regex rewrites of model output, summaries written on the model's behalf, depth caps, completion gates, "are you stuck?" detectors — is a bet against model capability that stronger models turn into dead weight or active harm. The harness's legitimate jobs are exactly four:

- **Survival.** Persistence, crash-safe resume, process supervision. The agent should be able to run for weeks; the harness's job is that nothing short of the researcher saying "stop" kills the run. (`PersistedFlow` already does the hard part.)
- **Resources.** One upfront envelope — money, time, workspace scope — and inside it, freedom. Budgets bound _how much_, never _how_. No per-action permission friction inside an approved envelope.
- **Ground truth.** Deterministic verifiers (Lean, CAS, compilation, execution) exposed as tools and evidence the model cannot fake — offered, not imposed. Ground truth is a resource the agent reaches for, not a filter the harness applies.
- **Transparency.** The researcher can always see what happened (traces, ledger, costs) — verbatim, never silently rewritten.

Everything else — how to decompose the problem, when to verify, when to hand off, whom to spawn, when it's done — is the agent's call.

### 2. Selection machinery is agentic orchestration, not harness code

Tournament / best-of-N / judge / debate mechanisms are run _by the orchestrator agent_ using the existing delegation primitives (`delegate_agent`, worktree isolation, FollowUpQueue delivery, cost roll-up) — never encoded as new deterministic flows. The tournament independently converged on this: the one candidate proposing a hardcoded `TournamentFlow` seeded 21st of 23, penalized by the bitter-lesson judge as scaffolding a stronger model makes obsolete. When a better selection strategy emerges, you edit a prompt, not a flow.

### 3. General methods, not problem-specific strategies

No curated problem-attack heuristics anywhere in the system — not in harness code, not in goal templates, not in agent YAMLs. "Try special cases first," "enumerate these proof techniques," "ladder up from n=2" are the modern equivalents of hand-coded chess features: they help the current model on the problems the author imagined and cap every stronger model on everything else. This invariant is not yet true of the shipped prompts — `prover.yaml` today enumerates a "standard arsenal" (induction, probabilistic method, generating functions, …) and instructs "attack restricted versions first" — so Track 1 includes an explicit prompt-cleanup task. The tournament's seeding reflected this — strategy-prescribing candidates (Ladder Plans, approach-commitment forcing) ranked near the bottom. Templates state _structural_ expectations that are domain-general (keep a notebook, back claims with evidence, spend the budget deliberately) and leave strategy — what to try, in what order, when to diversify, when to abandon — entirely to the agent's judgment on the problem in front of it. Search and learning, not our encoded taste.

---

## Track 1 — Subtractions: remove the supervision that already exists

These were proposed as pure deletions; maintainer review (PR #7090 inline comments) approved two, revised two into relocations, and deferred/rejected two. Each item records the decision.

- **Delete the delegation depth gate; budget is the only bound (C6, seed #2).** The depth gate (`NESTED_DELEGATION_DEPTH_RANGE`, default 1, defined in `src/shared/constants/delegationPolicy.ts`, evaluated by `evaluateCurrentDelegationGate` in `src/agent/runtime/delegationPolicy.ts`, and applied at the delegation call sites in `src/tools/delegation/subagentExecution.ts`) forbids exactly the decomposition open problems want — an orchestrator spawning provers that spawn lemma-verifiers. Cost roll-up already propagates through the whole tree, so unbounded-depth-under-bounded-cost is the lighter _and_ safer invariant. Also delete hardcoded team-preset rosters: generate `<available_agents>` in the `delegate_agent` description from the live catalog and let the orchestrator compose its own team per problem.
- **Move the replacement engine to the output boundary (C2, seed #10 — revised: keep the rules, relocate the application).** Maintainer decision: the rules are still very useful for LaTeX workflows, so they stay — the problem is _where_ they run. Today every provider handler pipes the model's response through the 3,276-line engine (`src/replacement/` — 21 files including the `rules/` subdirectory), silently mutating conversation history: the trace no longer shows what the model wrote, and a rewritten assistant turn breaks prompt caching on subsequent requests. Instead, apply the rules only when content is written to output files (the output pipeline / `OutputNode` path), leaving the in-conversation response verbatim and cacheable. Same rules, one application site, no silent history mutation.
- **Keep the reflection flow; defer One Loop (C1, seed #9 — deferred).** Maintainer decision: the reflection flow sticks around for a while. Surgical edit-tool operations are not always the most efficient mode — when a large fraction of a document must change, whole-document re-emission beats a long chain of edit calls in both cost and reliability. Revisit consolidation onto the tooluse loop once tool-based editing is clearly superior for bulk rewrites; until then both flows coexist and workflow agents keep their current path.
- **Keep the client-side compaction summarizer (C4, seed #4 — rejected).** Maintainer decision: don't delete it. The OpenAI-compat summarization path stays as the compaction mechanism. (The Track 3 notebook still reduces how much load-bearing state compaction has to preserve, which softens the original concern without touching the handler code.)
- **Strip strategy heuristics from shipped prompts (principle 3).** `prover.yaml`'s enumerated proof-technique arsenal and "attack restricted versions first" directive — and any similar guidance in other agent YAMLs and goal templates — get cut down to domain-general structural expectations (notebook, evidence, budget). What to try is the model's call.
- **Keep the Goal continuation push; add budget telemetry to it (part of C3 — revised to additive).** Maintainer decision: today's models still need the strong push, so the "keep pursuing the objective" template stays. The change is additive — thread a `<goal_status elapsed="2h13m" cost="$4.10/$25"/>` telemetry line into the existing continuation so the model can self-pace and plan an endgame. Shrinking the push to bare telemetry is revisited as models strengthen, not now.

## Track 2 — Survival and resources: what "run longer" actually needs

### Goal budgets: one envelope, then freedom (C3 — top seed, 8.7)

The autonomous Goal loop is literally unbounded today: `GoalSchema` has no budget fields, no choke point checks cost or wall-clock, and `docs/proposals/2026-06-10-error-pipeline-and-ownership.md` explicitly defers budget/turn exhaustion as a first-class terminal kind ("❌ folds into `'unexpected'`") — so researchers babysit, which is the real ceiling on run length. Add optional budget fields to `GoalSchema`; enforcement is a comparison at the existing choke point (`maybeBuildGoalContinuation`), since `RunUsageAccumulator` already tracks total cost _including subagent roll-up_. Semantics are pause-not-kill: at 80%, a soft note in the status line; at 100%, a wind-down turn ("bank state into your notebook, pause") through the existing `GoalStore.setStatus('paused')` path, extended with a new `pausedReason: 'budget_exhausted'` field on the goal record (neither `GoalSchema` nor `setStatus(streamId, nextStatus)` carries a reason today), plus one-click extend-and-resume.

The freedom framing matters: the budget is not a leash, it's what _replaces_ the leash. One approved envelope up front (cost + workspace scope), then yolo-grade autonomy inside it — no per-tool permission prompts, no depth caps, no cycle caps. The agent sees its remaining budget in every continuation and allocates it across subagents, models, and verification however it judges best. People let agents run overnight when spend is capped; agents spend budget well when they can see it.

### Goal Daemon: nothing short of "stop" kills the run (C9 — semifinalist)

Multi-day runs die today because the _process_ dies — rate-limit storms, laptop sleep, extension-host reloads — not because the model gets lost. `PersistedFlow` already makes mid-run resume correct; the missing piece is who presses resume at 3am. Classify pauses (the same new `pausedReason` field from C3, extended to `provider_error | budget_exhausted | user | handoff`) with backoff timestamps; add `texra goals list|resume`; `texra goals daemon --interval 5m` (or a two-line systemd unit) polls and resumes eligible goals headlessly. One precondition is new work, not reuse: the existing CLI resume path (`runResumeExecution` in `packages/cli/src/runtime/resumeExecution.ts`) is interactive by contract — it rejects non-interactive callers because a resumed session returns to WAITING for the user's next message — so the daemon needs a headless resume entry point that re-enters the Goal continuation instead of waiting for input. A resumed goal needing a human answer files an async `inquiry` and re-pauses instead of blocking a context for hours.

### Context Rebirth: the agent ends its own context (C8 — quarterfinalist)

`plan(command="handoff")`: the agent deliberately terminates its own context and continues the goal in a fresh execution seeded only from the objective, its notebook, and a self-written handoff brief (reusing the subagent seeding pattern, sequentially). Long runs become a chain of bounded-context legs at full attention instead of one endlessly-compacted conversation; the goal record gains `legs[]` for the progress view. This is freedom over one's own context: _when_ to be reborn is the agent's judgment (context feels degraded, a subproblem closed), not a harness threshold. Long-agent postmortems consistently show degradation with context age even under good compaction; rebirth is the clean fix, and it makes compaction quality nearly irrelevant.

### Self-extension: the agent grows its own capabilities

Already mostly present — treat as policy, not new machinery: the agent can write and run its own scripts (`bash`), drive external coding agents (`codex`, `claude_code`), create new agent definitions at runtime (the agentCreator flow), choose models and reasoning effort per delegated subtask (the handler registry abstracts ten providers), and file async questions to the human (`inquiry`) without blocking. The roadmap item is simply to stop gating these behind supervision defaults inside an approved envelope, and to say so in the orchestrator/goal prompts: _you may build the tool you're missing._

## Track 3 — The research notebook: agent-owned, mechanically checkable (C7 — champion, revised)

The tournament champion, re-cast freedom-first. The original formulation had the harness enforce a Zod schema, gate `plan(complete)` on lemma statuses, and inject rut-detector interventions — supervision. What survives the freedom filter is better and smaller:

**The agent owns a notebook; the harness only provisions and reads.** One durable state-of-the-problem note per goal in the existing memory store — today memory notes are flat Markdown files at `/memories/<name>.md` (see `docs/guide/memory.md`), so this is either one note per goal by naming convention or a new hierarchical `/memories/goals/<goalId>/` layout, a deliberate extension to the memory filesystem — maintained by the agent in whatever structure it finds useful — lemma DAG, attempts and dead ends with the exact obstruction, verified ranges, open subproblems. The goal template _teaches_ the discipline `prover.yaml` already mandates in prose; no harness code parses or validates the prose.

**The continuation injects the notebook, not conversation archaeology.** `maybeBuildGoalContinuation` gains a `{{notebook}}` variable — the file (or the agent's own digest of it) verbatim. The loop becomes self-healing after total context loss: objective + notebook + budget telemetry is a complete restart state. Compaction pressure drops to near zero (complements the Track 1 summarizer deletion); the context window becomes a cache, the notebook is the state.

**Evidence pointers: a one-line convention, not a schema.** The only machine-readable element: a claim may carry an inline pointer — `[lean: File.lean#theorem_name]`, `[cas: execution-id]`, `[run: execution-id]`, `[cite: doi|arXiv]`. A `texra claims verify` command greps pointers out of the notebook and re-executes each one — re-run `lean_diagnostics` on the named declaration, re-execute the stored WolframScript, re-resolve the DOI — flipping status to verified/stale/broken **with zero model calls**, and rendering a green/amber/red table in the progress view. The researcher's trust cost collapses from "reread the transcript" to "scan the red rows." The agent isn't forced to annotate; unbacked claims simply _show_ as unbacked, and a criticize agent (or the researcher) attacks those first. Honesty is made cheap and visible, not compelled.

**Why now:** weak models couldn't keep an honest notebook, so harnesses compensated with ever-cleverer compaction and validation. Strong models keep accurate notebooks when the template demands evidence — so the harness shrinks: dumber compaction, smaller live context, verification moved out of the model loop into deterministic re-execution. Trust scales with run length instead of decaying.

## Track 4 — Ground truth as a resource: VerifierReport (C17 — runner-up)

The final judges called it "elegant and un-gameable." A single Zod `VerifierReportSchema` in a new host-agnostic `src/agent/verification/` module — per-check entries `{kind: lean_build | lean_sorry_audit | numeric_spotcheck | latex_compile | symbolic_identity, status, evidence}` — wrapping what already exists:

- **Lean:** existing LSP services + a source audit for `sorry` / `admit` / `native_decide` / new axioms — a proof passes only with clean diagnostics _and_ a clean axiom audit.
- **Numeric spot-checks:** the attempt emits a `checks.wls` artifact; the harness evaluates the claimed identities at **randomized parameter values drawn by the harness, not the model**, so test points can't be cherry-picked.
- **LaTeX compile:** the existing `src/latex/` pipeline.

Freedom framing: this is _armament, not audit_. Exposure is a `verify_attempt` tool any agent may invoke on any artifact, plus a report **stapled to every delegated attempt's result** (`formatSubagentDelivery` in `src/tools/delegation/subagentResults.ts:150`) so a parent judging N attempts always sees code-trusted evidence next to each — information the orchestrator weighs, not a filter the harness applies. The one hard rule lives in prompts, not code: verifier evidence outranks self-report.

**Lean Lemma Escrow (C12) as a pattern on top:** the prover delegates a load-bearing lemma to the existing `lean` agent — `lean_loogle` Mathlib first (don't re-prove known results), else autoformalize and iterate against `lean_diagnostics` in a worktree — while it keeps attacking the main problem. Promotion to verified is mechanical (clean diagnostics + clean audit), so a hallucinated "I proved it" cannot promote; a refutation is gold — it kills a wrong branch early, in parallel.

## Track 5 — Tournaments, judging, adversaria: prompts, not flows

Per principle 2, these ship as agent/prompt patterns plus zero new machinery beyond Tracks 2–4:

- **Best-of-N with independence:** the orchestrator delegates N attempts and is responsible for making them _genuinely independent_ — how (different framings, different starting points, different models) is its call per problem, not a taxonomy we author. Diversity, not sampling noise, is where the marginal value of an attempt comes from, and per principle 3 the axes of diversity are the agent's to choose. Failed attempts return "what I learned"; that feeds the next generation. Cross-model diversity (ten providers behind one registry) is a free axis the harness merely makes available.
- **Blind judging:** a judge agent gets the problem statement plus each surviving attempt's artifact with model names, costs, and reasoning traces stripped, plus each VerifierReport. Prompt rule: verifier-passing attempts strictly outrank failing ones; the judge only breaks ties among survivors.
- **Prover–Skeptic:** a skeptic that never sees the prover's chain-of-thought — only the artifact and the problem statement — and must either report a concrete gap (exact line, candidate counterexample) or sign off. When to stop soliciting skeptics is the orchestrator's judgment, not flow logic.
- **Fresh-context referee (C11, revised to opt-in):** before declaring a goal complete, the _goal template_ tells the agent to hand its deliverable + notebook — and nothing else; fresh context is the point — to a referee with `wolfram` + `bash` + `lean_loogle`. Self-verification is the known strong-model failure mode (persuasive to oneself), and the same strength makes a clean-context referee genuinely effective. But it's the agent's discipline (and the researcher's per-goal choice), not a harness interception of `plan(complete)`. The agent decides when it's done; the budget is the only hard boundary.

These live in agent YAMLs (`orchestrator`, a hardened `skeptic`, a `referee`) and tool descriptions. Iterating a selection strategy means editing a prompt.

## Suggested sequencing

1. **Track 1 as decided** — delete the depth gate and strip prompt heuristics (approved, hours each); move the replacement engine to the output boundary and add budget telemetry to the goal continuation (revised); reflection retirement deferred and summarizer deletion rejected.
2. **C3 budgets** — days of work; the envelope that makes full freedom (and overnight runs) something researchers will actually grant.
3. **C7 notebook** — the `{{notebook}}` continuation variable + the pointer convention + `texra claims verify`.
4. **C17 VerifierReport** — the evidence layer; staple to subagent delivery from day one.
5. **C9 daemon + C8 handoff** — multi-week campaigns become survivable.
6. **Track 5 prompt patterns** — cheap, iterated freely once 1–5 exist.

---

## Appendix: tournament record

**Final:** C7 Research Ledger def. C17 VerifierReport, **3–0**. Judges verified grounding claims against source before voting; the deciding argument: C7 addresses all three goals (longer runs via notebook-seeded continuations, open problems via typed evidence, lighter harness via dumber compaction), while C17 addresses one — and C17's mechanism survives as C7's evidence layer.

**Semifinals:** C7 def. C3 (budgets govern whether a run continues, not what it accomplishes; retrofittable in days at any time). C17 def. C9 (verification is the binding constraint; auto-resume automates a path that already exists manually).

**Quarterfinals:** C3 def. C12 · C9 def. C6 · C17 def. C8 · C7 def. C4.

**Seeding (3-judge mean, criteria: research impact / bitter-lesson fit / engineering leverage):**

| #   | ID  | Score | Candidate                                                                                             |
| --- | --- | ----- | ----------------------------------------------------------------------------------------------------- |
| 1   | C3  | 8.7   | Goal budgets with pause-not-kill semantics                                                            |
| 2   | C6  | 8.0   | Recursive delegation under one budget                                                                 |
| 3   | C17 | 8.0   | VerifierReport ground-truth harness                                                                   |
| 4   | C4  | 7.7   | Delete client-side compaction summarizer                                                              |
| 5   | C7  | 7.7   | Research Ledger with typed claims                                                                     |
| 6   | C8  | 7.7   | Context Rebirth (`plan(handoff)`)                                                                     |
| 7   | C9  | 7.7   | Goal Daemon auto-resume                                                                               |
| 8   | C12 | 7.7   | Lean Lemma Escrow                                                                                     |
| 9   | C1  | 7.3   | One Loop (retire reflection flow)                                                                     |
| 10  | C2  | 7.3   | Delete the silent replacement engine                                                                  |
| 11  | C11 | 7.3   | Completion Gate + rut detector (as originally proposed; survives as the opt-in referee — see v2 note) |
| 12  | C10 | 7.0   | Detached deep-think legs (provider background mode)                                                   |
| 13  | C23 | 6.7   | Night Auditor scheduled adversarial sweep                                                             |
| 14  | C13 | 6.3   | Falsification Engine (counterexample search)                                                          |
| 15  | C20 | 6.3   | Morning Brief research log                                                                            |
| 16  | C21 | 6.3   | Ballot checkpoints via inquiry                                                                        |
| 17  | C5  | 6.0   | Task cards, not agent zoo                                                                             |
| 18  | C16 | 6.0   | Prover–Skeptic adversarial flow                                                                       |
| 19  | C14 | 5.7   | Ladder Plans (special-case laddering)                                                                 |
| 20  | C22 | 5.7   | Problem Campaigns attack tree                                                                         |
| 21  | C15 | 5.3   | TournamentFlow (hardcoded best-of-N flow)                                                             |
| 22  | C19 | 4.3   | Approach-commitment diversity forcing                                                                 |
| 23  | C18 | 3.7   | Evolutionary refinement w/ successive halving                                                         |

**v2 revision note.** After the bracket, the winners were re-filtered through governing principle 1 (provision, don't supervise). Concretely demoted from harness code to conventions/opt-in tools: the champion's Zod-enforced ledger schema (→ agent-owned notebook + one-line pointer convention), the `plan(complete)` GAP-gate (→ goal-template discipline + opt-in referee), and the rut detector (→ dropped; the notebook's Attempts table serves the purpose without harness intervention). Low-seeded candidates were not all discarded either: C16 (skeptic), C11 (its harness-enforced completion gate reframed as the opt-in fresh-context referee of Track 5, its rut detector dropped — the seeding table keeps the original candidate name), and C15 (its TournamentFlow node machinery is rejected, but two selection rules from its mechanism — judges see attempts blinded, and verifier evidence strictly outranks judge opinion — survive as the blind-judging prompt pattern in Track 5); their proposed harness machinery does not.
