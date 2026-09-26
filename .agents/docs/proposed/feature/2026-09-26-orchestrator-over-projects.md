---
created: 2026-09-26
status: proposed
---

# One orchestrator over all projects

Baseline: `main` at `a65f817`.

## What it is

- **One agent,** `orchestrator`, whose workspace is its own folder, `~/.texra/orchestrator/`. It works with the researcher on strategy, sees every project, and dispatches agents into them.
- **Its session is an ordinary session over that folder.** Memory, file tools, path guards, approvals and resume work as they do today.
- **It uses the dispatch and execution tools that already exist,** each given one new field, `project`. It gets two small new tools: `projects` for the registry and `schedule`.
- **The harness never fires anything on its behalf.** Every dispatch, wake-up and message is a tool call it chose to make.

## Its folder

- **Workspace:** `~/.texra/orchestrator/` is its working directory. The agent organizes it however it likes, and the researcher can open it like any project.
- **Memory:** the `memory` tool writes under this folder's workspace storage (`src/tools/memory/memoryFileSystem.ts`), so the orchestrator has its own memory automatically.
- **Confinement:** file tools stay inside the folder through `resolveToolPath` (`src/tools/pathResolution.ts`).
- **Isolation:** project agents never see the folder. It is outside every project root, and no project prompt mentions it.

## Tools

**Existing tools, each gaining a `project` field:**

| Tool | Today (one project) | With `project: <root>` |
| --- | --- | --- |
| `delegate_agent` (`src/tools/delegation/DelegationTools.ts`) | `agent` starts a subagent; `execution_id` sends a running one a follow-up; results come back as follow-ups; approval through proposal-or-bypass (`proposalFlow.ts:213`) | The child run is opened in **that project's session**, so its ledger, approvals and resume live there. Its result still comes back to the orchestrator as a follow-up. |
| `delegate_workflow` | Same, for workflow agents | Same |
| `delegate_multi_agents` (`src/agent/workflowScript/`) | Fans a script's `agent` operations out in the caller's session | Each `agent` operation may name a `project` |
| `executions` (`src/tools/ExecutionsTool.ts`) | List runs, read a run's report, conversation and output, `wait`, `kill` | The same, read from that project's session fold |

This gives dispatch (`delegate_*`), steering (`execution_id`), stopping (`kill`), inspection (`executions`) and result delivery with no new commands.

**New:**

- **`projects`** (`src/tools/projects/`): commands `list`, `create <path> [from]` and `open <path>`, over the project registry.
  - `list` returns each project's root, live runs, pending requests and spend.
  - Anything deeper goes through `executions` with `project`.
- **`schedule`** (`src/tools/schedule/`): commands `at <time> <note>`, `in <duration> <note>`, `list` and `cancel <id>`.
  - It is a timer source on the path `github_subscription` uses (`src/tools/github/RunSubscriptionRegistry.ts` → `submitFollowUp`). The note arrives as a follow-up.
  - It lives as long as its run and process.
  - This is how the orchestrator checks back on anything it didn't dispatch itself.

**Also on:**
- `memory`, `ask_user_question`, `inquiry`.
- File tools and `bash`.
- `todo_write`, `plan`, `github_subscription`.

**Autonomy** is the run's existing proposal-bypass policy. With bypass off, every cross-project `delegate_*` is a proposal the researcher approves, rejects or edits. `create` and `bash` always ask.

## Changes

1. **Registry port.** Add a `ProjectRegistry` port on the process runtime, exposing `list`, `open(root)` and `sessionFor(root)`.
   - Desktop serves it from `DesktopProjectRegistry` (`packages/desktop/src/main/desktopProjects.ts`).
   - The CLI serves it from the same global-DB records (`desktopProjectRecords.ts`, `GlobalDatabase` in `src/shared/session/database.ts`).
2. **Cross-session children.** When `project` is set, the child run is registered on `sessionFor(project)` instead of the parent's session (`src/tools/delegation/childRun.ts`, `subagentRun.ts`).
   - The parent link records the orchestrator's run and session.
   - Delivery back uses `submitFollowUp`, which already takes the owning session explicitly as `options.session` (`src/agent/followUp/ToolUseFollowUp.ts`).
   - `execution_id` follow-ups and the ownership check (`handle.isOwnedBy`) resolve the child in its own session.
3. **`executions` with `project`.** Read `sessionFor(project)`'s fold instead of the caller's.
4. **`projects` and `schedule` tools.** Register them in `src/tools/registry.ts` and `src/tools/pluginManifest.ts`.
5. **`orchestrator.yaml`.** Rewrite `packages/extension/resources/tool_use_agents/orchestrator.yaml`: the job and the limits only, no routines.
6. **Entry points.**
   - Desktop: the orchestrator folder pinned first in the project rail.
   - CLI: `texra orchestrator`, which is `--cwd ~/.texra/orchestrator` with the agent preselected.
7. **Retire `setup`.** Fold `setup.yaml` and `apply_team` into the orchestrator.

Done when:
- `delegate_agent` with `project` starts a run that appears, is approved and resumes in that project, and its result comes back to the orchestrator.
- `executions` with `project` lists and kills that project's runs.
- A `schedule` note arrives as a follow-up.
- No project run can read `~/.texra/orchestrator/`.

## Later, separate proposals

- One `theorist` agent per project, replacing `prover`, `research`, `numerics`, `review`, `search` and `leanOrchestrator`.
- Follow-ups taken between tool calls, not only at the turn boundary (`src/agent/runtime/loop/toolUse.ts`).
- A `verify` tool: Lean `sorry`/axiom audit, CAS checks at random points, and a novelty search.
- A `tournament` script for `delegate_multi_agents`.
- A cost-reporting benchmark.

## Open questions

1. Should `schedule` survive a process restart, persisted the way `inquiry` persists threads in the global DB?
2. Should a child dispatched into a project stay linked to the orchestrator if that project's window is closed and reopened, or detach, as `detachSubagentsOnStop.ts` does for a stopped parent?
