---
created: 2026-09-26
status: proposed
---

# TeXRA as the AI theorist: a Principal over projects, one theorist per project, a board and a tournament you can steer

**Recommendation.** Stop growing an agent zoo and build around three things:

1. **One Theorist agent.** It has a small set of roles, all defined in prompts. Domain knowledge comes from skills, not from separate agents or teams.
2. **One Research Board.** This is a durable, host-rendered record of a campaign: ideas, claims, evidence, open questions, budget. The agent and the researcher edit the same object. It is the steering surface.
3. **One idea tournament.** It ships as a workflow-script library over the existing `delegate_multi_agents` interpreter, not as a harness flow. It keeps Elo ratings on the Board, and the researcher's own ideas and votes are first-class entries and matches in it.

These sit on top of the long-horizon, ground-truth and verification work that the July roadmap already ranked, plus two new first-class checks: **novelty** (prior work) and **digestion** (human-readable exposition).

**Above all projects sits a **Principal**: one agent rooted at the computer, not at a project. It lists, creates and opens projects, grants folders to them, and starts, watches and steers runs in each project's own session. That makes the hierarchy exactly three levels: Principal (computer) → theorist `lead` (project) → roles (branch). See §3.8.

Order of work: evaluation first, then consolidation, then the Board, then steering, then verification, then tournaments, then scale.** Without a theorist benchmark that reports cost, nothing after it can be judged, including the tournament's own design.

Baseline: `main` at `a65f817`. Builds on, and argues against in two places (§6), the archived [open-problem research roadmap](../../archived/feature/2026-07-05-open-problem-research-roadmap.md). That roadmap's principles still hold unless this note says otherwise.

## 1. What the frontier teaches (as of 2026-09)

Sources are in §9. Most 2026 claims were read only through secondary reporting and are still disputed. Treat the numbers as indicative, not established.

- **Long horizons matter more than fan-out.** In OpenAI's Navier–Stokes campaign (about 10k agents, 88 h, reported cost over \$10M), Noam Brown gives multi-agent "not even 10%" of the credit: "we have a very powerful model… we can get it to operate over very long horizons," and "we don't actually have good measurements" of coordination. Brown also treats parallel agents as a **latency** tool: more agents give a faster answer at worse efficiency, and they help most on decomposable work such as math. *Lesson:* make one agent survive for days before making many agents run for hours.
- **Test-time compute is the control variable.** Brown argues results should be reported against tokens, dollars and wall-clock time. *Lesson:* budget is a first-class input and every evaluation reports cost.
- **Hedge both directions.** The Navier–Stokes run gave separate agent groups the "prove regularity" and "prove blowup" variants. A consolidator (Codex) periodically merged intermediate results and cross-seeded the groups. *Lesson:* the default campaign shape is prove and disprove in parallel, with a periodic consolidation step.
- **Rank pairwise, not with absolute scores.** Google's AI co-scientist uses Elo (new entries start at 1200), pairs similar ideas using a proximity graph, runs multi-turn debates only for top-ranked pairs, and evolves ideas **as new entries** rather than editing old ones. A meta-review turns recurring critiques into prompt feedback. Scientists steer by **adding their own hypotheses and reviews to the same tournament**. Elo tracked accuracy, and quality kept rising with compute without saturating.
- **Discovery and verification are separate stages.** Lean formalization of the Navier–Stokes result took a further 17 h after discovery. AlphaProof adds test-time RL on generated problem variants. DeepMind's Aletheia (generator → verifier → reviser) is valued because it **admits failure**. The IMO-gold model declined Problem 6 rather than bluffing.
- **Novelty is where claims go wrong most often.** OpenAI's "10 Erdős problems" (October 2025) were literature finds. DeepMind's Erdős sweep found many "open" problems were open "through obscurity rather than difficulty" and warned of "subconscious plagiarism." *Lesson:* a prior-work check is part of verification.
- **Proof digestion.** The Navier–Stokes proof is machine-checked, but mathematicians called it "not written for humans." Tao's ICM essay: if the authors can't give an expert-level talk on a result, it shouldn't be published. Effort should move toward exposition, refereeing and canonicalization. *Lesson:* producing an exposition is a verification stage, and TeXRA's LaTeX pipeline is a real advantage here.
- **Taste stays with the human, for now.** Brown names "research taste" (is this direction significant and original?) as the missing piece. Tao's blue-team/red-team framing and pAI/MSc's "humans on the loop" point the same way. *Lesson:* the UI should put **direction, significance and pruning** decisions in front of the researcher and leave breadth, checking and literature work to agents.
- **Disclosure.** Aletheia's human–AI interaction cards and autonomy levels, and Tao's disclosure norm. *Lesson:* every result carries a provenance card saying who proposed what, which checker passed it, and which sources it drew on.

## 2. Where TeXRA stands

**Strengths:**
- A crash-safe run ledger with resume.
- Goal mode for autonomous continuation (`src/agent/goal/maybeBuildGoalContinuation.ts`).
- Asynchronous human questions that survive restarts (`src/tools/inquiry/ExternalInquiryTool.ts`).
- Thorough approvals.
- Memory (`src/tools/memory/`).
- Tools for Lean 4, Wolfram, arXiv, Crossref, Zotero and web search.
- A deterministic, journaled fan-out engine (`src/agent/workflowScript/`).

**The mess:**

- **Agents in four places.** There are 19 tool-use agents, 5 Lean-plugin agents, 7 workflow agents and 11 remote workflow agents (`prompts/agents/remote/workflow/`).
- **Four coordinators:** `orchestrator`, `engineer`, `leanOrchestrator`, and `assistant`, which also delegates. Their prompts repeat each other.
- **Theorist work split across overlapping agents:** `prover`, `research`, `numerics`, `review` and `search`, plus the remote `devise`, `enhance`, `elevate` and `verifyFix`.
- **Skills that mirror agents:** `manuscript-review`, `mathematical-enhancer`, and others.
- **"Teams" are fixed rosters under three names.** "Mode preset", "team" and "multi-agent preset" all mean the same thing (`src/shared/schemas/agentPresets.ts`, `src/common/teams/`). The physicist, mathematician and cs-ml teams are lists of agents, not ways of working together.
- **No selection machinery at all.** No tournament, judge or best-of-N. The orchestrator prompt only says to "propose the same work to different agents and synthesize."
- **The July roadmap is mostly unbuilt.** Budgets, notebook, `VerifierReport`, handoff and skeptic/referee do not exist. `prover.yaml` still carries the strategy heuristics that roadmap wanted removed.
- **Steering only at turn boundaries.** Queued messages are consumed at turn boundaries (`src/agent/runtime/FollowUps.ts`, `toolUse.ts` "The turn boundary"). The researcher can stop a run or queue a message, but cannot redirect a long run in progress, prune a branch, or promote an idea.

## 3. The target design

### 3.1 One Theorist, a few roles, domains as skills

Replace the theorist-facing roster with **one `theorist` agent**. It takes a small set of roles, each a prompt plus a toolset, never a separate product surface:

| Role       | Job                                                                                                                                  | Sees                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `lead`     | Owns the campaign and the Board: decomposes, allocates budget, runs consolidation                                                    | Everything                                              |
| `worker`   | Attacks one branch: derivation, computation, construction, literature                                                                | Its branch, the Board summary                           |
| `skeptic`  | Finds a concrete gap (exact line, candidate counterexample) or signs off                                                             | The artifact and problem statement only — no reasoning trace |
| `referee`  | Fresh-context check before any claim is promoted: verification ladder plus novelty                                                   | The deliverable and its evidence pointers only          |
| `expositor`| Produces the digest: key ideas, an expert-talk outline, the LaTeX write-up, the provenance card                                      | The verified claims                                     |

- **Domains** (mathematician, theoretical physicist, theoretical CS, ML theory, Lean) become **skills and tool bundles** the theorist loads, not teams. "Mode presets" collapse to "theorist + these skills + this default budget."
- **Delete the duplicate coordinators.** `orchestrator` becomes the `lead` role. `leanOrchestrator` becomes a Lean skill. `engineer` stays only as a software team, outside the theorist product.
- **Agents that survive** are single-purpose writing tools (`correct`, `polish`, `paper2slide`, …) and the software team. Everything research-shaped is the theorist.
- **Prompts** keep principle 3 of the July roadmap: no problem-specific heuristics. Roles describe *what evidence to produce*, not *how to attack*.

*Why this is maintainable.* Adding a capability becomes a skill or a tool; changing a strategy becomes a prompt or workflow-script edit. The number of places that need changing drops from about 40 agent files to 5 role prompts plus skills.

### 3.2 The Research Board: the shared object the human steers

A campaign has one Board, persisted with the session and rendered by all three hosts:

- **Goal and budget:** the objective, plus a tokens, dollars and wall-clock envelope with live spend (the July roadmap's C3).
- **Branches:** the decomposition, with prove and disprove variants paired by default. Each branch has a status (`active` / `paused` / `pruned` / `closed`) and a budget share.
- **Ideas:** tournament entries, each with an Elo rating, lineage (parents, if any), author (agent role or *researcher*), and match history.
- **Claims:** statements with one of the levels `conjecture` / `supported` / `verified` / `refuted`. Each carries **evidence pointers** (`[lean: …]`, `[cas: …]`, `[run: …]`, `[cite: …]`, the July C7 convention), and a `novelty` field recording the prior-work check result and its citations.
- **Open questions:** questions for the researcher, backed by `inquiry` requests, so they wake the run when answered.
- **Digest:** the expositor's latest summary. This is the "morning brief."

The agent writes the Board through one tool (`board`: append idea or claim, update status, record match) and reads it in every continuation, replacing the July `{{notebook}}` variable. The researcher edits the same records from the UI. **Every researcher edit is an ordinary queued input to the run.** There is no second writer (see §3.3).

### 3.3 Steering at three levels

| Level        | Researcher does                                                                                                  | Mechanism                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Nudge**    | Types "try the Fourier side" while a long turn runs                                                              | **New:** delivered at the next *tool-call* boundary, not the next turn boundary. The one real runtime change in this note.   |
| **Redirect** | On the Board: prunes a branch, promotes or kills an idea, adds own idea, changes budget split, marks a claim wrong | Board edits become follow-up rows; the lead sees them as structured events ("researcher pruned B3: *reason*")               |
| **Decide**   | Answers ballots: "pick 2 of these 5 directions", "is this lemma known?"                                         | Existing `inquiry` / `ask_user_question`; the tournament script can yield a **human match** as an operation                 |

Plus two passive surfaces:

- **Digest.** A scheduled or on-demand summary: what changed, which claims moved levels, what needs the researcher.
- **Provenance card** on every exported result.

**The researcher votes in the tournament.** A human pairwise judgment is a match with a higher K-factor than an agent's. A researcher's idea enters at 1200 like any other. This is how co-scientist makes steering native, and it gives the one piece of data an AI theorist most lacks: **the researcher's taste, recorded as preferences.** Later it can calibrate the judge prompts (the meta-review).

### 3.4 The idea tournament as a workflow-script library

The tournament ships as a **library of workflow scripts** run by `delegate_multi_agents`, not as a `TournamentFlow` in the harness. That respects the July roadmap's principle 2. It builds from the existing primitives:

```
generate(k, lenses)        → ideas on the Board at Elo 1200
dedupe + proximity          → cluster ids (embedding or judge)
round(pairs by proximity, favouring new and top-rated)
  top tier:   multi-turn debate (skeptic vs advocate) → judge
  lower tier: one-shot blind comparison → judge
  human match: yield a ballot when the researcher opted in
evolve(top m)              → NEW entries (combine, simplify, ground, diverge), never edits
meta-review                → recurring critique patterns → notes appended to role prompts
stop when budget spent or top-k stable for r rounds
```

Rules the scripts enforce, all taken from the literature:
- Judges are **blind**: no model names, costs or reasoning traces.
- **Verifier-passing entries strictly outrank failing ones.** Judges only break ties.
- A refuted claim ends its idea's run; its obstruction is kept as a Board note.

**The harness's only new job is to make the Board the tournament's store.** Elo, matches and lineage are then durable, rendered and editable by the researcher.

Uses beyond research problems:
- Choosing a proof strategy.
- Choosing among paper framings.
- Ranking referee-response options.
- **Ranking proposals for TeXRA itself.** The July roadmap was produced this way, by hand.

### 3.5 Verification ladder, with novelty and digestion as rungs

Each rung produces an evidence pointer, and the referee reports which ones passed (the July roadmap's C17 `VerifierReport`, extended):

1. **Self-check.** The worker's own adversarial pass.
2. **Skeptic.** Artifact-only.
3. **Computational.** CAS or numeric identities evaluated at **randomized points the harness draws**, plus small-case enumeration.
4. **Novelty.** Search arXiv, Crossref and web for prior work, then a judge decides between "known", "folklore" and "new". Needs **Semantic Scholar / OpenAlex** tools (missing today) with citation provenance.
5. **Formal.** Lean via the existing tools, run as a **separate stage after discovery**. It passes only with clean diagnostics and an axiom/`sorry` audit.
6. **Digestion.** The expositor must produce a key-ideas summary and a talk outline that a fresh referee judges faithful to the proof.
7. **Human.** The researcher marks the claim accepted.

`verified` requires rungs 1–4 plus rung 5 **or** rung 7. The level is shown, never hidden. "Not solved; here is a precisely recorded obstruction" is a successful outcome and is displayed as one.

### 3.6 Long horizons before wide fan-out

From the July roadmap, in its order:
- Goal budgets with pause-not-kill semantics.
- An auto-resume daemon.
- Context handoff: the lead ends its own context and continues from Board plus brief.
- Budget telemetry in every continuation.

These are what Brown's evidence says matters most. The prove/disprove split and periodic **consolidation** (the lead merges worker lemmas onto the Board and re-seeds branches) run on top without new machinery.

### 3.7 Scaling toward very large campaigns without re-architecting

The same shapes scale:
- The Board is a blackboard.
- Workflow scripts are the scheduler.
- Consolidation is the cross-pollination step.
- The budget is the only bound.

Going from 4 agents to 400 means a remote executor behind the workflow interpreter's `agent` operation and a Board store that tolerates concurrent writers through the session's single publisher. Neither is needed now, and neither should be built before evaluation shows fan-out paying for itself (§4).

### 3.8 The Principal: one agent at the computer root

The researcher works on several projects at once: papers, problems, a Lean formalization, a talk. Today every agent is bound to a single project. Every tool resolves paths against its own session's roots (`src/tools/pathResolution.ts`). The `executions` tool reads only its own session. Children launched with `working_directory` still record into the parent's session. Nothing an agent can call lists projects, opens a folder, or reaches a run in another project.

The runtime is already ready for more:
- The session owner holds many sessions per process (`src/agent/runtime/sessionGraph.ts`).
- The desktop keeps a persisted project registry in the global database (`packages/desktop/src/main/desktopProjects.ts`, `desktopProjectRecords.ts`).
- The SDK's `Sessions.open(roots)` → `Session.start(...)` → `Run` is a programmatic API across projects (`packages/agent/src/effect/sessions.ts`).

The Principal is the agent-facing surface over what already exists.

**Where it lives.** A **home session**: a session whose workspace is the user's home directory and whose storage is the global storage root. It is the desktop's existing no-workspace fallback session, promoted to a real one. Each host enters it this way:
- **Desktop:** a Home view above the project rail.
- **CLI:** `texra` with no project (or `texra home`).
- **VS Code:** stays single-project. Its one-folder rule in `extension.ts` stands. It can show "managed by Principal" status but does not host the Principal.

The Principal runs on the same tool-use loop as every other agent. It differs only in its root, its tools and its prompt. It absorbs the `setup` agent's job (environment, keys, teams), which removes one more coordinator.

**One tool, `projects`,** served through a new host-agnostic `ProjectRegistry` port in the process runtime. Desktop serves it from its existing registry; the CLI serves it from the same global-database records. Commands:

| Command                           | Effect                                                                                                                                                         | Approval                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `list` / `status <project>`       | Projects with running runs, pending requests, spend and Board digest, read from each project's session view                                                     | none                               |
| `create <path> [from]`            | New folder, initialized as a project: empty, template, git clone, Overleaf, arXiv source. Reuses the existing sample, Overleaf and arXiv flows, now reachable without VS Code commands | once per create                    |
| `open` / `close` / `archive`      | Registry operations; `close` stops only that project's runs                                                                                                     | `close` with live runs             |
| `grant <project> <folder> ro\|rw` | Attaches an outside folder (data, a shared bibliography, a sibling repo) to a project                                                                           | always; revocable; shown on the project |
| `start <project> <agent> <task>`  | `Sessions.open(roots).start(...)`: the run lives, is approved and is recorded **in the target project's session**, with a link back to the Principal's run     | the target project's own rules     |
| `steer` / `stop <run>`            | Queues a follow-up into that run, or interrupts it                                                                                                             | none                               |
| `read <project> board\|memory`    | Reads the project's Board and memory; writes go through the project's own agents                                                                                | none                               |

**Rules that keep it maintainable:**

- **Work runs where it belongs.** A run the Principal starts is an ordinary run in that project's session: its ledger, its Board, its approvals, its single publisher. The Principal holds references, never copies. This replaces the `working_directory` workaround for cross-project work, which records into the wrong session.
- **No new event channel.** The Principal reads other projects through the session view and SDK `Run.events`, as the desktop's cross-project attention badge already does (`packages/desktop/src/main/desktopAttention.ts`). Anything it authors is a `SessionEvent` in its own home session.
- **Three levels, fixed.** Principal → project lead → roles. The Principal never talks to a project's workers directly; it steers the lead.

**Safety at computer scope.** A computer-root agent is the most powerful thing TeXRA would ship, so its own reach is narrow:

- **Filesystem:** the Principal's file tools may *read* under the home directory, except a built-in deny list: `~/.ssh`, keychains and credential stores, `~/.texra`'s databases, browser profiles. It *writes* only inside its home workspace. All other writes happen through `create` or through project agents inside their own roots.
- **Granted folders:** these become a new external-root kind (`userFolder`, read-only or writable) alongside the host-registered kinds in `src/utils/files/externalRoots.ts`. They are persisted per project and checked by the existing `resolveToolPath` guard, so `restrictPathsToWorkingDirectory` keeps its meaning.
- **Bash:** the Principal's `bash` is always approval-gated, whatever the run's approval policy.

**What it adds for the researcher:**
- **One place to ask "what's happening?"** A cross-project digest: which claims moved, which runs wait on you, spend against each budget.
- **A portfolio budget.** The Principal splits one envelope across projects and is where the §3.6 auto-resume daemon lives.
- **Cross-pollination.** When a lemma on one project's Board looks relevant to another, the Principal proposes it to that project's lead. This is the consolidation step from §3.6, applied between projects.
- **Home memory.** Researcher-level memory: taste, notation preferences, recurring collaborators, and tournament votes aggregated across projects. It sits above per-project memory, which stays local.

## 4. Evaluation first: a theorist benchmark

Nothing above can be tuned without a benchmark. Keep a private, versioned set that is re-run on every model or prompt change and reports **success × tokens × dollars × wall-clock time**, per Brown:

- **Derivations** in physics and TCS with checkable closed forms (CAS-verified).
- **Lemma formalization** tasks with known Lean proofs.
- **Problems with known answers:** resolved Erdős-style problems, post-cutoff arXiv results, and "is this known?" novelty cases, including traps where the answer *is* in the literature.
- **Honesty cases:** problems believed unsolvable at the given budget. Score **calibrated failure**, and penalize a confident wrong claim more than a miss.
- **Steering cases:** scripted researcher interventions (prune, redirect, veto). Score whether the run follows them within one tool boundary.

The benchmark also decides whether the tournament, prove/disprove splits and fan-out width earn their cost. They should be kept only where they measurably pay.

## 5. Sequencing

| Phase | Work                                                                                                                 | Size   | Exit criterion                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| 0     | Theorist benchmark (§4) plus a cost-reporting harness                                                                 | days   | Baseline numbers for today's `prover` and `orchestrator`               |
| 1     | Consolidate agents into theorist + roles + skills; one name for presets; strip prover heuristics                      | ~1 wk  | Benchmark no worse; agent and prompt file count down about 5×          |
| 2     | Research Board (schema, `board` tool, three renderers, continuation injection)                                        | 1–2 wk | A campaign survives restart from Board + objective alone               |
| 3     | Steering: tool-boundary nudges; Board edits as structured follow-ups; digest                                           | ~1 wk  | Steering benchmark cases pass                                          |
| 3b    | Principal, read side: home session, `ProjectRegistry` port, `projects list/status/read`, cross-project digest; `setup` folds in | ~1 wk  | One digest shows every open project's runs, requests and spend         |
| 3c    | Principal, write side: `create`, `start`, `steer`/`stop`, `grant` with the `userFolder` external-root kind and deny list | 1–2 wk | A run started from Home is recorded, approved and resumable in its own project |
| 4     | Verification ladder: `VerifierReport`, novelty rung with Semantic Scholar/OpenAlex, digestion rung, provenance card    | 2 wk   | No `verified` claim without its evidence; novelty traps caught         |
| 5     | Tournament script library with human matches and meta-review                                                          | ~1 wk  | Tournament beats single-shot on the benchmark at equal cost, or is cut |
| 6     | Budgets, daemon, handoff (July Tracks 2–3)                                                                             | 2 wk   | 48 h unattended campaign with no human restart                         |
| 7     | Scale: remote executor for workflow `agent` operations                                                                 | later  | Only if phase 5 shows fan-out paying                                  |

## 6. Where this departs from the July roadmap

- **The Board is structured, the notebook was free text.** The July v2 revision demoted the typed ledger to an agent-owned Markdown notebook because the harness was going to *gate completion* on it. This note keeps that decision: the harness gates nothing on the Board. But a steering surface the researcher edits, and the three hosts render, needs records with ids, levels and ratings. That falls under the roadmap's own "transparency" duty (principle 1), not supervision. Free text stays available inside every record.
- **Human-in-the-loop moves up.** The July tournament's lenses were bitter-lesson and autonomy lenses. "Ballot checkpoints" (C21, 16th) and "Morning brief" (C20, 15th) seeded low, and "task cards, not agent zoo" (C5, 17th) lost in seeding. The owner has since set "terrific human in the loop" as a primary goal, and the 2026 evidence (research taste as the bottleneck; co-scientist's steering by tournament entry) supports it. Those three become phases 1 and 3 here.
- **Unchanged:** selection stays in scripts and prompts, no problem-specific heuristics, and ground truth is offered, not imposed.

## 7. What not to build

- A hardcoded `TournamentFlow`, a new "team" type, or another coordinator agent. The Principal and the project `lead` are the only two coordinators, and the Principal replaces `setup`.
- Cross-project runs recorded in the caller's session, or a global run log. Each run lives in its project.
- Per-domain agents. Domains are skills.
- Large fan-out before phase 5's evaluation justifies it. Brown himself can't yet measure coordination.
- Anything that hides a claim's level or turns a failed check into a quiet default.

## 8. Open questions for the owner

1. The Board's store: rows in the session ledger (one publisher, replayable) versus current-value SQLite rows ([current-value state decision](../architecture/2026-09-22-current-value-state-decision.md)). The recommendation is ledger rows for Board changes and a folded view for rendering.
2. Remote workflow agents (`devise`, `enhance`, `elevate`, `verifyFix`, …): retire them into theorist roles, or keep them as hosted skills?
3. Tool-boundary nudges: default on, or opt-in per run?
4. Benchmark contents: whose problems, and how are they kept out of training data?
5. The Principal's read scope: the whole home directory with a deny list (proposed), or only folders the researcher has listed as "research roots"?
6. Does the Principal replace the desktop's project rail as the entry screen, or sit beside it as a Home tab?

## 9. Sources

The WebFetch proxy blocked most domains, so **only arXiv pages were read directly**. Everything else comes from search-result summaries and is marked as such.

- Read directly:
  - arXiv 2502.18864 (AI co-scientist).
  - 2511.16072 (Early science acceleration experiments with GPT-5).
  - 2511.02864 (AlphaEvolve at scale, with Tao).
  - 2602.10177 (Aletheia).
  - 2601.22401 (Erdős problems with Gemini).
  - 2602.03837 (Gemini case studies).
  - 2608.16753 (Tao, "Mathematics in the age of AI", ICM 2026).
  - 2604.20622 (pAI/MSc).
- From summaries:
  - OpenAI, "On the Navier–Stokes Millennium Prize Problem" (2026-09-08) and its press coverage.
  - OpenAI, "Advancing science and math with GPT-5.2" (2025-12).
  - OpenAI, Advisory Group on Mathematics and AI (2026-09-21).
  - Noam Brown on Dwarkesh (2026-09-17), Latent Space (2025-06), the essay "Implications of large-scale test-time compute" (2026-06), and the IMO-gold thread (2025-07-19).
  - AlphaProof (Nature, 2025-11).
  - Sakana AI Scientist-v2 (arXiv 2504.08066).
- The 2026 headline results (Navier–Stokes, "100+ problems") were unreviewed at the time of writing. Nothing in this design depends on them being correct; only the methodological lessons are used.
