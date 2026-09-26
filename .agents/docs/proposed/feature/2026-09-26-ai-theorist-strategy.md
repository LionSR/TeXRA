---
created: 2026-09-26
status: proposed
---

# TeXRA as the AI theorist: a Principal over projects, one theorist per project

Baseline: `main` at `a65f817`. Builds on the archived [open-problem research roadmap](../../archived/feature/2026-07-05-open-problem-research-roadmap.md) and keeps its principles. **The harness provides tools, facts, memory, budget and limits. What to do with them is the model's call.** Nothing here is a scripted routine: no triggers the harness fires on the agent's behalf, and no strategy written into a prompt.

## 1. The shape

- **Principal**
  - One agent at the computer level, in a session with no workspace. It works with the researcher on strategy across projects, sees every project, and dispatches agents into them.
  - It has its own memory.
  - Proactivity and scheduling are **tools it calls**, never harness behavior.
  - It replaces the `setup` agent.
- **Theorist, one per project**
  - One agent with a few prompt-level roles. Domains are skills, not teams.
  - It replaces the overlapping research agents and the "team" presets.
- **Everything else is a tool** over machinery that already exists: delegation, workflow scripts, `inquiry`, `ask_user_question`, `memory`, the Lean, Wolfram and arXiv tools, and the subscription-to-follow-up path.

## 2. Why (the lessons that change the design)

Sources are in §8. Most of the 2026 material was read only through secondary reporting.

- **Long horizons matter more than fan-out.** Noam Brown credits multi-agent with "not even 10%" of OpenAI's Navier–Stokes run, and says coordination wasn't measured. So make runs survive and resume before making them wide.
- **Humans steer by entering ideas and judgments into the same ranking** (Google's AI co-scientist Elo tournament). Research taste, which Brown calls the missing piece, stays with the researcher.
- **Verification includes novelty and readability.** The OpenAI Erdős episode turned out to be literature finds. The Navier–Stokes proof was called "not written for humans."
- **Cost is the control variable.** Brown argues results should be reported against tokens, dollars and time.

## 3. What exists, what's missing

| Need | Exists | Missing |
| --- | --- | --- |
| Many projects in one process | `src/agent/runtime/sessionGraph.ts` (session per root); desktop registry `packages/desktop/src/main/desktopProjects.ts`, persisted in `desktopProjectRecords.ts` (global DB); SDK `Sessions.open(roots)` → `Session.start(...)` in `packages/agent/src/effect/sessions.ts` | No agent-callable tool reaches any of it; every tool is bound to its own session's roots |
| A session with no workspace | Desktop fallback session (no workspace); CLI is one project per process (`packages/cli/src/runtime/cliContext.ts`) | Neither runs agents as a home |
| Wake a run from outside | `github_subscription` → `RunSubscriptionRegistry` → `submitFollowUp` (`src/agent/followUp/ToolUseFollowUp.ts`), delivered as a `live_notification` follow-up; `inquiry` answers wake a run even after restart | No timer source; no source watching another project |
| Memory | `memory` tool, per project, under the session's storage root (`src/tools/memory/memoryFileSystem.ts`) | Nothing at the home level |
| Delegation and fan-out | `delegate_agent` / `delegate_workflow` (`src/tools/delegation/`), `delegate_multi_agents` (`src/agent/workflowScript/`), proposal approval (`proposalFlow.ts`) | Children always record into the parent's session. `working_directory` changes only the cwd |
| Human in the loop | `ask_user_question`, `inquiry`, approvals (`src/agent/runtime/runApprovalQueue.ts`), queued follow-ups (`src/agent/runtime/FollowUps.ts`) | Follow-ups are taken only at the turn boundary (`toolUse.ts` "The turn boundary"), not between tool calls |
| Path safety | `resolveToolPath` (`src/tools/pathResolution.ts`), external roots (`src/utils/files/externalRoots.ts`) | No kind for a folder the user grants |
| Agents | 19 tool-use agents, 5 Lean-plugin agents, 7 workflow agents and 11 remote workflow agents; 4 coordinators (`orchestrator`, `engineer`, `leanOrchestrator`, `assistant`); "team", "mode preset" and "multi-agent preset" for one concept (`src/shared/schemas/agentPresets.ts`, `src/common/teams/`) | One theorist; one coordinator per level |
| Verification | Lean tools (`src/tools/lean/`), `wolfram`, compile check (`src/agent/output/compileCheck.ts`), arXiv, Crossref, web search | No verification report; no novelty check; no Semantic Scholar or OpenAlex |
| Selection | Only the prompt line in `orchestrator.yaml` | A tournament is a workflow script nobody has written yet |

## 4. The work

### 4.1 Principal: one agent, tools, own memory

**Home session.** Promote the desktop fallback session into a real session: workspace = user home, storage = global storage root. Give it a Home view on desktop and `texra home` on the CLI. VS Code keeps its one-folder rule (`packages/extension/src/extension.ts`).

**Own memory, no new mechanism.** The existing `memory` tool, run in the home session, writes under the global storage root. How the Principal organizes it is its own call. Project runs never see it: it sits outside every project root, and no project prompt mentions it. Knowledge reaches a project only when the Principal puts it in a `dispatch` or `steer`. The Settings Memory tab gets a Principal/project scope switch.

**Two new tools**, each with a single `command` field like `memory` and `github_subscription`:

- **`projects`**, over a host-agnostic `ProjectRegistry` port served by the process runtime. Desktop serves it from `DesktopProjectRegistry`; the CLI serves it from the same global-DB records.
  - `list`, `status <p>`: registry, plus each project's session view (runs, pending requests, spend). `status` also returns the Board.
  - `read <p> memory|board|file`: read-only.
  - `create`, `open`, `close`: registry operations. `create` reuses the sample, Overleaf and arXiv project flows without needing VS Code commands.
  - `grant <p> <folder> ro|rw`: a new external-root kind, `userFolder`, checked by `resolveToolPath`.
  - `dispatch <p> <agent> <task> [goal] [budget] [model]`: `Sessions.open(roots).start(...)`. The run lives, is approved and is recorded **in the target project's session**.
  - `steer <run> <text>` / `stop <run>`: `submitFollowUp` / interrupt, on the target session.
  - `watch <p|run>` / `unwatch`: a subscription whose source is the target session's view. Changes arrive as `live_notification` follow-ups, the same path `github_subscription` uses. What to watch is the Principal's call.
- **`schedule`**: `at <time> <note>`, `in <duration> <note>`, `list`, `cancel`. A timer source over the same `RunSubscriptionRegistry` → `submitFollowUp` path. When it fires, the note arrives as a follow-up. There is no daemon; when to check in is the Principal's call.
  - v1 has the subscriptions' lifetime: the run and the process.
  - Surviving a restart is open question 1.

**Proactive means it can speak first.** Messages the Principal posts from a `schedule` or `watch` wake-up show in Home. Raised to the OS through the desktop's existing attention path (`packages/desktop/src/main/desktopAttention.ts`), they become a notification. It reaches the researcher through `ask_user_question` and `inquiry`, which exist today. The researcher sets quiet hours and a rate cap; the host enforces them.

**Strategy with the researcher.**
- A Strategy note in the Principal's memory that the researcher can edit from the Memory tab.
- Choices go through `ask_user_question` or `inquiry`.
- For many candidate directions, the tournament script (§4.4), with the researcher's votes as matches.
- No new surface beyond the Home chat.

**Autonomy is one setting**, enforced where approvals already live (`runApprovalQueue.ts` policy):

| Level | Without asking | Asks the researcher |
| --- | --- | --- |
| `advise` | read, `watch`, `schedule`, message | every `dispatch`, `steer`, `stop` |
| `delegate` | the above, plus `steer`/`stop`/re-`dispatch` of approved goals | new goals, budget increases |
| `autonomous` | the above, plus new `dispatch` within the portfolio budget | exceeding the budget |

At every level, `create`, `grant` and the Principal's own `bash` always ask. The Principal's file tools read under home except a deny list (`~/.ssh`, credential stores, `~/.texra` databases, browser profiles).

### 4.2 One theorist per project

- **One `theorist.yaml`** with prompt-level roles:
  - `lead`: owns the campaign.
  - `worker`.
  - `skeptic`: sees the artifact only, not the reasoning trace.
  - `referee`: fresh context.
  - `expositor`: key ideas, a talk outline, the LaTeX write-up, and a provenance card.
- **Roles run through `delegate_agent`.** How the lead decomposes and spends is its call.
- **Remove:**
  - `orchestrator` becomes `lead`.
  - `prover`, `research`, `numerics`, `review` and `search` fold into the theorist plus skills.
  - `leanOrchestrator` becomes a Lean skill.
  - The remote `devise`, `enhance`, `elevate` and `verifyFix` workflows: see open question 2.
- **Keep:** the single-purpose writing agents (`correct`, `polish`, `paper2slide`, …) and the software team.
- **Presets:** `AGENT_MODE_PRESETS` becomes theorist + skills + default budget, under one name. `apply_team` goes with `setup` into the Principal.

**The Board.** The project's campaign state is a Markdown note in project memory, with the July roadmap's evidence pointers (`[lean: …]`, `[cas: …]`, `[cite: …]`) and a claim level on each claim (conjecture, supported, verified, refuted). It is written through the existing `memory` tool and needs no new schema. `projects status` and the desktop render it. It becomes typed rows only if rendering or the researcher's edits prove the Markdown insufficient.

### 4.3 Steering and verification

- **Nudges between tool calls.** Let a run take queued follow-ups at a tool-call boundary, not only at the turn boundary (`toolUse.ts`, `toolUseDispatch.ts`, `FollowUps.ts`). This is the one change to the loop in this note.
- **`verify` tool.** It returns a report per check:
  - Lean diagnostics plus a `sorry`/axiom audit.
  - CAS identities at random points the harness draws.
  - LaTeX compile.
  - Novelty: prior-work search, with **Semantic Scholar and OpenAlex** added next to the arXiv and Crossref tools.

  Delegated results carry the report (`formatSubagentDelivery` in `src/tools/delegation/subagentResults.ts`). Whether and when to call it is the agent's call.

### 4.4 Tournament as a workflow script

- **A shipped `tournament` script for `delegate_multi_agents`,** not a harness flow. It does blind pairwise judging, Elo from 1200, debate for the top pairs, and improvements as new entries. Researcher votes arrive through `ask_user_question` inside the script.
- **Iterating the method means editing the script.**
- **The same script serves** project-level ideas and the Principal's portfolio choices.

### 4.5 Benchmark

- **A private, versioned set,** re-run on model or prompt changes and reported as success × tokens × dollars × time:
  - CAS-checkable derivations.
  - Lean lemmas.
  - Problems with known answers, including "already in the literature" traps.
  - Honesty cases, where a confident wrong answer scores below a miss.
  - Steering cases.
- **The benchmark decides** whether the tournament and wide dispatch earn their cost.

## 5. Order

| # | Work | Main files | Done when |
| --- | --- | --- | --- |
| 0 | Benchmark (§4.5) | new `scripts/` harness | Baseline for today's `prover` / `orchestrator` |
| 1 | Theorist consolidation, one preset name | `packages/extension/resources/tool_use_agents/`, `agentPresets.ts`, `src/common/teams/` | Benchmark no worse; far fewer agent files |
| 2 | Home session, `projects` (`list`/`status`/`read`), Principal memory, `setup` folded in | `sessionGraph.ts`, `desktopProjects.ts`, new `src/tools/projects/`, `pluginManifest.ts`, `registry.ts` | Home shows every project; a project run cannot reach home storage |
| 3 | `projects dispatch`/`steer`/`stop`/`watch`, `schedule`, autonomy levels | `packages/agent/src/effect/sessions.ts`, `RunSubscriptionRegistry` pattern, `submitFollowUp`, `runApprovalQueue.ts` | A run dispatched from Home is recorded and resumable in its project; a `schedule` wake-up arrives as a follow-up |
| 4 | Tool-boundary nudges | `toolUse.ts`, `toolUseDispatch.ts`, `FollowUps.ts` | Steering benchmark cases pass |
| 5 | `verify` + Semantic Scholar/OpenAlex; `grant` | `src/tools/lean/`, `src/tools/wolfram/`, `subagentResults.ts`, `externalRoots.ts`, `pathResolution.ts` | No `verified` claim without its evidence; novelty traps caught |
| 6 | Tournament script | `src/agent/workflowScript/` | Beats single-shot at equal cost on the benchmark, or is dropped |

## 6. Not building

- **No new flow type,** tournament flow, team type or daemon.
- **No harness-fired routines.** Every wake-up is one the agent asked for through `watch` or `schedule`.
- **No global run log.** Each run lives in its project's session.
- **No second event channel.** Cross-project delivery is `submitFollowUp`.

## 7. Open questions

1. `schedule` across restarts: is the in-memory subscription lifetime enough, or should a pending schedule persist? The candidate is the global-DB, wake-after-restart path that `inquiry` already uses.
2. The remote workflow agents (`devise`, `enhance`, `elevate`, `verifyFix`, …): fold them into theorist roles, or keep them as hosted skills?
3. The Principal's read scope: home minus a deny list, or only registered projects?
4. The default autonomy level: `advise` or `delegate`?

## 8. Sources

The proxy blocked most sites, so only arXiv pages were read directly.

- **Read directly:**
  - arXiv 2502.18864 (AI co-scientist).
  - 2511.16072 (GPT-5 science).
  - 2511.02864 (AlphaEvolve with Tao).
  - 2602.10177 (Aletheia).
  - 2601.22401 (Erdős problems with Gemini).
  - 2608.16753 (Tao, ICM 2026).
  - 2604.20622 (pAI/MSc).
- **From search summaries:**
  - OpenAI, "On the Navier–Stokes Millennium Prize Problem" (2026-09-08).
  - OpenAI, "Advancing science and math with GPT-5.2" (2025-12).
  - Noam Brown on Dwarkesh (2026-09-17) and Latent Space (2025-06).
  - Brown's essay on test-time compute (2026-06).
- **Caveat:** the 2026 headline results were unreviewed when this was written. Only their methodological lessons are used here.
