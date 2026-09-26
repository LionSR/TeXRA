---
created: 2026-09-26
status: proposed
---

# One orchestrator over all projects

Baseline: `main` at `a65f817`.

## What it is

- **One agent,** `orchestrator`, whose workspace is its own folder, `~/.texra/orchestrator/`. It works with the researcher on strategy, sees every project, and dispatches agents into them.
- **Its session is an ordinary session over that folder.** Memory, file tools, path guards, approvals and resume work as they do today.
- **It uses the dispatch and execution tools that already exist,** each given one new field, `project`. It gets two small new tools: `projects` for the registry and `send_later`. It also takes over the `setup` agent's job.
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
- **`send_later`** (`src/tools/sendLater/`). It is modelled on Claude Code's `send_later`: one message, delivered back into this run at a future time as an ordinary turn.
  - **Input:** `message`, and exactly one of `at` (ISO time) or `delay_minutes`. Optional `name`, a short label. `initiation`: `researcher_asked` when the researcher asked for the reminder, `own_followup` when the agent is checking back on its own work. Granularity is one minute.
  - **Result:** an `id`. The same tool with `cancel: <id>` cancels it, and with `list: true` lists what is pending.
  - **Durability:** it survives restarts. Scheduling commits a `followup.scheduled {followUpId, at, message, name, initiation}` SessionEvent, published through `SessionHandle.publish`, in the run's session. Cancelling commits `followup.unscheduled {followUpId}`. The fold's pending set is what `list` returns and what the desktop renders.
  - **Delivery:** one fiber per open session sleeps until the earliest pending `at`, then calls `submitFollowUp(runId, message, {session, followUpId})`. Because `followUpId` is the unique key of `followup.queued` (`src/shared/schemas/sessionEvent.ts`), a crash between delivery and the next sleep never delivers twice.
  - **Missed times:** if the session was closed or TeXRA was not running at `at`, the message is delivered when the session next opens. It is marked late ("was due 09:00").
  - **Why this route:** it replaces the in-memory `RunSubscriptionRegistry` route, which died with the process.
  - **Use:** this is how the orchestrator checks back on anything it didn't dispatch itself. The UI labels each delivery by `initiation` ("Check-in you asked for" or "Check-in the orchestrator set").

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
   - `send_later`'s two SessionEvents are defined in `src/shared/schemas/sessionEvent.ts` and folded in `src/shared/session/sessionFold.ts`. Its timer fiber is started by the session owner (`src/agent/runtime/sessionGraph.ts`) when a session opens.
   - Delivery back uses `submitFollowUp`, which already takes the owning session explicitly as `options.session` (`src/agent/followUp/ToolUseFollowUp.ts`).
   - `execution_id` follow-ups and the ownership check (`handle.isOwnedBy`) resolve the child in its own session.
3. **`executions` with `project`.** Read `sessionFor(project)`'s fold instead of the caller's.
4. **`projects` and `send_later` tools.** Register them in `src/tools/registry.ts` and `src/tools/pluginManifest.ts`.
5. **`orchestrator.yaml`.** Rewrite `packages/extension/resources/tool_use_agents/orchestrator.yaml`: the job and the limits only, no routines.
6. **Entry points.**
   - Desktop: the orchestrator folder pinned first in the project rail.
   - CLI: `texra orchestrator`, which is `--cwd ~/.texra/orchestrator` with the agent preselected.
7. **The orchestrator does setup** (§Setup below). Delete `packages/extension/resources/tool_use_agents/setup.yaml`.

Done when:
- `delegate_agent` with `project` starts a run that appears, is approved and resumes in that project, and its result comes back to the orchestrator.
- `executions` with `project` lists and kills that project's runs.
- A `send_later` message arrives as a follow-up, including after TeXRA is restarted before its time. A cancelled one never arrives.
- First-run setup on desktop and the CLI runs as an orchestrator run in `~/.texra/orchestrator/`.
- No project run can read `~/.texra/orchestrator/`.

## Setup

The `setup` agent's job is environment, keys, config, teams and the first task. That is portfolio-level work, so it moves into the orchestrator.

- **Tools.**
  - `orchestrator.yaml` gains `setup.yaml`'s tools: `probe_environment`, `verify_setup`, `list_api_keys`, `unset_api_key`, `read_config`, `update_config`, `invoke_command`, `install_vscode_extension`, `apply_team`, `send_to_terminal`.
  - `update_config` (workspace scope) and `apply_team` gain the same `project` field as the dispatch tools, so the orchestrator can configure any project.
- **Knowledge.**
  - `setup.yaml`'s long install guidance (package managers, one command per call, re-verify after installing) becomes a `setup` skill (`packages/extension/resources/skills/setup/`). The orchestrator loads it when it needs it.
  - The orchestrator's system prompt stays short: the job and the limits only.
- **Launch.** Every launch site keeps calling `src/controllers/onboarding/setupLaunch.ts` (`SETUP_INSTRUCTION`), which now names the orchestrator instead of `setup`. The launch sites are:
  - desktop onboarding "Run Setup", `kickoffSetup` in `packages/desktop/src/main/desktopOnboardingIpc.ts`;
  - CLI `texra setup` and first-run continuation (`packages/cli/src/commands/setup.ts`, `packages/cli/src/onboarding/setupContinuation.ts`);
  - VS Code `setupAssistantCommand.ts` and `ProgressViewProvider.ts`.
- **Where the run lives.**
  - On desktop and the CLI, the setup run lives in the orchestrator's folder session, so the first conversation a new user has is already with the orchestrator.
  - VS Code holds one session per window, so there the orchestrator runs in that window's session. `projects` and the `project` fields are unavailable there through the existing host-capability gating (`src/tools/pluginAvailability.ts`), the same way `invoke_command` needs `platform.commands`.
- **Onboarding funnel.**
  - `AgentRunLifecycle.ts` excludes runs of the agent named `SETUP_AGENT_NAME` from "first real run completed".
  - Since the orchestrator also does real work, the exclusion keys on the setup run instead: the run started by `setupLaunch.ts`. `SETUP_AGENT_NAME` goes away.
- **What does not change:** the proposal card's `'setup'` action (`src/shared/schemas/request.ts`). It means "open this delegation for editing" and is unrelated to the setup agent.

## Later, separate proposals

- One `theorist` agent per project, replacing `prover`, `research`, `numerics`, `review`, `search` and `leanOrchestrator`.
- Follow-ups taken between tool calls, not only at the turn boundary (`src/agent/runtime/loop/toolUse.ts`).
- A `verify` tool: Lean `sorry`/axiom audit, CAS checks at random points, and a novelty search.
- A `tournament` script for `delegate_multi_agents`.
- A cost-reporting benchmark.

## Open questions

1. Should agents other than the orchestrator get `send_later` by default, or opt in per agent YAML?
2. Should a child dispatched into a project stay linked to the orchestrator if that project's window is closed and reopened, or detach, as `detachSubagentsOnStop.ts` does for a stopped parent?
