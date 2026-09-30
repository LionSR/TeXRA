---
created: 2026-09-26
status: proposed
---

# One always-on orchestrator over all projects

Baseline: `main` at `d38e473` (revised 2026-09-29; first written against `a65f817`).

## What it is

- **One agent,** `orchestrator`, whose workspace is its own folder, `~/.texra/orchestrator/`. It works with the researcher on strategy, sees every project, and dispatches agents into them.
- **It is always on.** A host process stays up without a window and starts at login. The orchestrator wakes on time and on project events, and not only when the researcher types.
- **Its session is an ordinary session over that folder.** Memory, file tools, path guards, approvals and resume work as they do today.
- **It uses the dispatch and execution tools that already exist,** each given one new field, `project`. It gets two new tools: `projects` for the registry and `wake` for scheduled and event wakes. It also takes over the `setup` agent's job.
- **Nothing fires that nobody asked for.** Every wake is a row the orchestrator or the researcher committed. Every dispatch is a tool call the orchestrator made.

## Prior art (September 2026)

Three products shipped always-on agents this month. What we take and what we avoid:

- **OpenAI Dots** (2026-09-29). Proactive research while the user is away is strictly read-only. Consequential work is proposed for approval. There are per-action rules (allow / ask / block) and an activity view. We take **roam read-only, act on proposal** (§Unattended turns). Criticism: its memory cannot be edited per entry. Ours is plain files, per entry.
- **ChatGPT Pulse** (2025-09). One overnight pass yields a finite set of cards, not a feed. We take **the finite brief** (§Brief).
- **Manus 2.0 / Cue** (2026-09-28). Automations are triggered by events. Wide Research gives each item a fresh-context sub-agent. We take **event wakes** and **one fresh child per project**. Its top complaint is credit burn with no estimate and no cap. We make **a hard daily budget** part of v1 (§Budget).
- **Meta Muse** (2026-09-08). It keeps working after the app closes and comes back "when something changes or when it needs approval". A separate Sentinel approves anything that leaves the machine. We take the same shape: the approval gate is the existing core policy, not the orchestrator's own judgement.

## Its folder

- **Workspace:** `~/.texra/orchestrator/` is its working directory. The agent organizes it however it likes, and the researcher can open it like any project.
- **Memory:** the `memory` tool writes to `<storage>/memories` for this folder's workspace storage, `~/.texra/v1/workspace-storage/orchestrator-<hash8>/` (`src/tools/memory/memoryFileSystem.ts`, `src/platform/defaults/workspaceStorage.ts`). So the orchestrator has its own memory with no new code. The memories are plain files, editable and deletable one at a time.
- **Confinement:** file tools stay inside the folder through `resolveToolPath` (`src/tools/pathResolution.ts`).
- **Isolation:** project agents never see the folder. It is outside every project root, and no project prompt mentions it.

## Always on

Today:

- **Desktop, macOS:** the app survives its last window. Project sessions are owned by per-project scopes under the process scope, not by the window (`packages/desktop/src/main/desktopProjects.ts`, `desktopProjectBindings.ts`). They close only at quit (`desktopWindowLifecycle.ts`).
- **Desktop, Windows and Linux:** it quits when the last window closes (`packages/desktop/src/main/index.ts` `window-all-closed`).
- **Missing everywhere:** there is no tray, no login item, and no durable timer. The CLI exits when its run ends.

Changes:

- **Desktop keeps running.**
  - A `background` setting, on by default. With it on, closing the last window leaves the process up on every platform, with a tray / menu-bar item: Open TeXRA, the brief, Pause wakes, Quit.
  - `app.setLoginItemSettings({ openAtLogin })` follows a `startAtLogin` setting, off by default and offered during setup.
  - At launch the desktop already reopens every folder open at the last quit (`index.ts`). It also opens the orchestrator's folder, always.
- **CLI: `texra orchestrator --stay`.**
  - A foreground process that opens the orchestrator session and keeps it open until killed, for a server or a machine without the desktop.
  - It is not a daemon manager. Users run it under launchd or systemd if they want.
  - Without `--stay`, `texra orchestrator` is an interactive chat in that folder.
- **Two hosts at once is already safe.**
  - Desktop and CLI share `~/.texra` and each workspace's `texra.db`. SQLite WAL with `BEGIN IMMEDIATE` guards every write, and per-aggregate owner claims check liveness by pid and start time (`src/agent/storage/leaseOwnerLiveness.ts`).
  - `resumeRun` refuses a run owned by another live process (`owned_elsewhere`, `src/agent/runtime/resumeRun.ts`).
  - Each open store sees the other process's commits through its `data_version` poll (`Database.ts`).
  - Both hosts can run the wake fiber. A wake delivers with a deterministic id, and the fold skips a replayed one (below), so only one delivery counts.
- **Notifications** reuse `followDesktopAttention` (`packages/desktop/src/main/desktopAttention.ts`). It already posts an OS notification and badge when a request opens or a top-level run finishes in a project the user is not looking at. It follows the orchestrator's session like any other, so a brief that lands or a proposal that waits notifies with the window closed. Email and mobile are out of scope.
- **Pause wakes** is one global `app-state` flag. The wake fiber holds deliveries while it is set and delivers them late when it clears.

## Tools

**Existing tools, each gaining a `project` field:**

| Tool                                                                              | Today (one session)                                                                                                                                                                                                                                            | With `project: <root>`                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate_agent`, `delegate_workflow` (`src/tools/delegation/DelegationTools.ts`) | Start a child in the caller's session (`subagentRun.ts` `registerRun(parent.run.session, …)`). The child's report comes back as a `followup.queued` row from `{kind:'run'}` (`childRunLoop.ts`). Approval goes through proposal-or-bypass (`proposalFlow.ts`). | The child is registered in **that project's session**, so its ledger, approvals and resume live there. Its report is still admitted onto the orchestrator's run in the orchestrator's session. |
| `delegate_multi_agents` (`src/tools/delegation/WorkflowScriptTool.ts`)            | Fans a script's `agent()` operations out in the caller's session                                                                                                                                                                                               | Each `agent()` may name a `project`. One fresh-context child per project is the Wide Research shape.                                                                                           |
| `executions` (`src/tools/executions/`)                                            | `view`, `wait`, `kill`, `send {message}`, `query {sql}` over the caller's session (`send.ts`, `queryAction.ts`, `ExecutionsTool.ts`)                                                                                                                           | The same, against that project's session: view and query read its fold, `send` messages a run there, and `kill` resolves ownership there.                                                      |

This gives dispatch, steering (`executions send`), stopping (`kill`), inspection (`view`, `query`) and result delivery with no new commands.

**New:**

- **`projects`** (`src/tools/projects/`): commands `list`, `create <path> [from]` and `open <path>`.
  - `list` returns each project's root, whether it is open, live and paused runs, pending requests, and today's spend. Everything comes from `SessionView` (`attentionOf`, per-run `usage`), with no model call.
  - Anything deeper goes through `executions` with `project`.
- **`wake`** (`src/tools/wake/`). Modelled on Claude Code's `send_later`, extended with recurrence and events (Manus Automations, Dots recurring tasks).
  - **Input:** `message`, and exactly one trigger:
    - `at` (ISO time) or `delay_minutes`;
    - `every` (`daily HH:MM` or `weekdays HH:MM`, in local time);
    - `on` (`{project, event}`, where `event` is `run_finished`, `run_failed` or `request_opened`).
  - **Other input:** optional `name`, a short label. `initiation` is `researcher_asked` or `own_followup`. Optional `budget_usd` caps what the woken turn and its children may spend (§Budget).
  - **Result:** an `id`. `cancel: <id>` cancels it and `list: true` lists what is pending.
  - **Durability:**
    - Scheduling commits `wake.scheduled {wakeId, trigger, message, name, initiation, budgetUsd}` through `SessionHandle.publish`. Cancelling commits `wake.cancelled {wakeId}`.
    - A recurring or event wake stays pending until cancelled. A one-shot wake leaves the pending set when it is delivered.
    - The fold's pending set is what `list` returns and what the orchestrator home renders.
  - **Delivery:**
    - One fiber per open session, forked beside the session's other scoped fibers in the `Sessions` layer (`src/controllers/session/sessionLayer.ts`).
    - It sleeps until the earliest `at`. It follows each project's `SessionView` for `on` wakes: the same run-outcome and request transitions `desktopAttention.ts` already derives.
    - It then calls `submitFollowUp(runId, {text, from: {kind:'wake', wakeId, initiation}, deliveryId}, {session})`. `deliveryId` is `wakeId` plus the due time or triggering row, so a replay after a crash or from a second host is skipped by the queue manager and the fold (`ToolUseFollowUpQueueManager.ts`, `runRows.ts`).
  - **Missed times:** if no host was running at `at`, the message is delivered when the session next opens, marked late ("was due 09:00"). A recurring wake missed several times delivers once.
  - **This replaces the in-memory `RunSubscriptionRegistry` route** for anything the orchestrator watches. GitHub subscriptions stay as they are for now (Later).
  - **The UI labels each delivery** by `initiation`: "Check-in you asked for" or "Check-in the orchestrator set".

**Also on:**

- `memory` and `ask_user_question`, which `orchestrator.yaml` does not list today.
- `inquiry`, `todo_write`, `plan`, `github_subscription`, file tools and `bash`, as today.

## Unattended turns

Borrowed from Dots: a turn nobody is watching roams read-only and acts only by proposal.

- **A wake-started turn cannot bypass approval.** A turn whose input is a `{kind:'wake'}` follow-up runs under the `ask` policy whatever the run's stored policy. The rule lives in core approval state (`src/shared/approvalPolicy.ts`), next to the headless `yolo` refusal.
  - Reading is free: `projects list`, `executions view` / `query`, and file reads.
  - Every cross-project `delegate_*`, every `executions send` or `kill` into a project, and every `bash` call opens a request.
- **An unanswered request waits durably.** With no host attached, requests already open and wait in the fold (`HostInteractions.ts`). The desktop notifier announces them. The orchestrator home lists them as the researcher's inbox.
- **The researcher can pre-approve.** A wake with `initiation: researcher_asked` may carry a goal grant (`src/tools/goal/goalAutoApproval.ts`, scope `commands` or `allAgentWork`) that the researcher approved when scheduling it. Wakes the orchestrator set for itself never carry one.
- **`create` always asks.** So does `bash` in every turn, attended or not.

## Budget

There is no spend limit anywhere today; the only limit is the child-run concurrency cap. Unattended work needs one before it ships.

- **Settings:** `orchestrator.dailyBudgetUsd` (default 5) in the Zod settings catalog (`src/shared/schemas/coreSettings.ts`) and the settings view.
- **What counts:** the spend of every run whose lineage reaches the orchestrator since local midnight, read from `run_usage` in each store. That includes children in project sessions.
- **Enforcement:**
  - Before admitting a wake-started turn, and before each dispatch it makes, the orchestrator run checks spent against the cap, and against the wake's own `budget_usd` if it has one.
  - Over either cap, the turn stops at a checkpoint and opens a request: "Daily budget reached ($5.00). Continue with $N more?"
  - Nothing is discarded. A stopped child already pauses and continues from its journal (`childRun.ts`).
- **Estimates:** the proposal card for a dispatch shows the child's model and what is left of the day's budget. We do not guess a dollar figure for the task.

## Brief

Borrowed from Pulse: a finite brief, not a feed.

- **Scheduling:** during setup the orchestrator offers a recurring wake, `every: weekdays 08:00`, with `initiation: researcher_asked`.
- **The woken turn:**
  - reads `projects list` and each project's recent rows (`executions query`);
  - writes `briefs/YYYY-MM-DD.md` in its folder: at most ten items, each one of **needs you** (a pending request, a failed run), **finished** (with the files it produced) or **stuck**;
  - replies with the top three.
- **Where it shows:**
  - The orchestrator home renders the newest brief. Older ones are just files.
  - The reply notifies through `desktopAttention` like any finished run.
- **Steering:** the researcher steers the next brief by replying ("skip the talk project this week"). The orchestrator keeps that in memory. There is no rating widget.

## Changes

1. **Project registry.**
   - Move the curated list from the desktop-only `desktop-projects {remembered, recent}` value to a host-neutral `projects {remembered, recent}` record in `GlobalDatabase` (`src/shared/schemas/rowValues.ts`, `src/shared/session/database.ts`). 1.0 is a clean state, so no reader of the old value stays.
   - Add a `ProjectRegistry` port on the process runtime: `list`, `open(root)`, `sessionFor(root)`.
   - Desktop serves it from `DesktopProjectRegistry`. The CLI serves it from the same record and opens sessions through the `Sessions` layer.
   - `texra` adds the cwd to `recent` on open, as the desktop does.
   - VS Code stores live under `context.storageUri`, outside `~/.texra`, so they are not in the registry.
2. **Cross-session children and messages.** When `project` is set:
   - the child is registered on `sessionFor(project)`, not `parent.run.session` (`src/tools/delegation/subagentRun.ts`, `childRun.ts`);
   - the child's report goes through `followUps.submit` and `submitFollowUp` on the **parent's** session, which the child records at launch (`childRunLoop.ts`);
   - `executions` resolves `Runs`, `isOwnedBy` and `readView` against the target session;
   - `runRelation` reads lineage across the two views (`src/shared/session/runRelation.ts`). Today it reads one session's `parentOf` (`ToolUseFollowUpQueueManager.ts`).
3. **Wake sender kind.**
   - Add `{kind:'wake', wakeId, initiation}` to the sender union (`src/shared/schemas/followUp.ts`).
   - `submitFollowUp`'s no-loop branch lets a `wake` follow-up resume a resumable run, as it does for `user` (`src/agent/followUp/ToolUseFollowUp.ts`). It still never restarts a run the user stopped.
4. **`wake`.** Add `wake.scheduled` / `wake.cancelled` to `src/shared/schemas/sessionEvent.ts` and fold them in `src/shared/session/sessionFold.ts`. The fiber goes in `sessionLayer.ts`.
5. **Unattended policy and budget** (§Unattended turns, §Budget).
6. **`projects` and `wake` tools.** Register them in `src/tools/registry.ts` and `src/tools/pluginManifest.ts`. `projects` and the `project` fields declare `unavailableHosts: ['vscode']` (`src/tools/core/definition.ts`).
7. **`orchestrator.yaml`.** Rewrite `packages/extension/resources/tool_use_agents/orchestrator.yaml`. Its current prompt is a single-project LaTeX steward. The new one states the job and the limits only, with no routines.
8. **Desktop background.** Covers the `window-all-closed` change, the tray, the login item, and the orchestrator folder pinned first in the project rail.
9. **CLI.** `texra orchestrator [--stay]`, which runs in `~/.texra/orchestrator` with the agent preselected.
10. **The orchestrator does setup** (§Setup). Delete `packages/extension/resources/tool_use_agents/setup.yaml`.

Done when (each is an E2E through the real `texra` CLI or desktop, ending in a diffable artifact):

- `delegate_agent` with `project` starts a run that appears, is approved and resumes in that project, and its report comes back to the orchestrator.
- `executions` with `project` lists, messages and kills that project's runs.
- A `wake` with `at` arrives after TeXRA is restarted before its time. A cancelled one never arrives. An `on: run_failed` wake arrives when a project run fails with no window open.
- With the desktop and `texra orchestrator --stay` both up, one wake is delivered once.
- A wake-started turn with bypass stored on still opens a request for a cross-project dispatch.
- With the daily budget set to $0.01, a woken dispatch stops at a checkpoint and asks, and continues on approval.
- First-run setup on desktop and the CLI runs as an orchestrator run in `~/.texra/orchestrator/`.
- No project run can read `~/.texra/orchestrator/`.

## Setup

The `setup` agent's job is environment, keys, config, teams and the first task. That is portfolio-level work, so it moves into the orchestrator.

- **Tools.**
  - `orchestrator.yaml` gains `setup.yaml`'s tools: `probe_environment`, `verify_setup`, `list_api_keys`, `unset_api_key`, `read_config`, `update_config`, `apply_team`, and the VS Code–only `invoke_command`, `install_vscode_extension`, `send_to_terminal`.
  - The last three declare `unavailableHosts: ['cli', 'desktop', 'sdk']`. They are withheld on desktop and the CLI with no change, as they are for `setup` today.
  - `update_config` (workspace scope) and `apply_team` gain the same `project` field. `apply_team` resolves `project` to its root and calls `AgentRosterController.applyTeam`. That is the path the Settings team picker uses (`src/tools/setup/ApplyTeamTool.ts`).
- **Knowledge.**
  - `setup.yaml`'s long install guidance (package managers, one command per call, re-verify after installing) becomes a `setup` skill in `packages/extension/resources/skills/setup/`, in the Agent Skills `SKILL.md` layout. The orchestrator loads it when it needs it.
  - The system prompt stays short.
- **Launch.** Every launch site names the agent through one constant in `src/controllers/onboarding/setupLaunch.ts`. Today they diverge:
  - desktop uses `buildDesktopSetupRunRequest` (`packages/desktop/src/main/desktopAgentLaunch.ts`, from `kickoffSetup` in `desktopWindowAccount.ts` and `desktopOnboardingIpc.ts`);
  - VS Code imports `SETUP_INSTRUCTION` and `SETUP_AGENT_NAME` (`packages/extension/src/commands/setup/setupAssistantCommand.ts`);
  - the CLI passes `agentOverride: SETUP_AGENT_NAME` (`packages/cli/src/commands/setup.ts`, `packages/cli/src/onboarding/setupContinuation.ts`);
  - `ProgressViewProvider.ts` hardcodes `'setup'`.
- **Where the run lives.**
  - On desktop and the CLI, the setup run lives in the orchestrator's folder session, so a new user's first conversation is already with the orchestrator.
  - VS Code holds one session per window, so there the orchestrator runs in that window's session, without `projects`, the `project` fields or wakes across projects.
- **Onboarding funnel.**
  - `AgentRunLifecycle.ts` excludes runs of the agent named `SETUP_AGENT_NAME` from "first real run completed".
  - Since the orchestrator also does real work, the exclusion keys on the setup run instead: the run started through `setupLaunch.ts`. `SETUP_AGENT_NAME` goes away.
- **UI.** The funnel (`needs-credential` → `setup` → `done`, `src/controllers/onboarding/onboardingFunnel.ts`) is unchanged. It is a fact about the user, so on desktop it renders in one place, the orchestrator home.
  - **`needs-credential`:** `OnboardingWelcomeCard` moves unchanged into the orchestrator home. On first launch the desktop selects the Orchestrator row, which stands alone in the rail over "Open a project folder".
  - **`setup`:**
    - The hero (`ProgressApp.ts` `renderHero`, `host.onboarding === 'setup'`) moves to the orchestrator home. Its title changes from "Set up {project}" to "Set up TeXRA".
    - Its "Run setup assistant" button runs `setupLaunch.ts`. "Skip setup" stays.
    - `ONBOARDING_SETUP_HANDOFF` (`src/ui/copy/onboarding.ts`) now says: the orchestrator checks your environment, registers your projects and agents, sets up your morning brief, and starts your first task.
    - VS Code, which has no orchestrator row, keeps the hero in its window.
  - **`done`:** the orchestrator home is the "All projects" overview: the newest brief, pending requests across projects, and pending wakes.
  - **Desktop startup team panel** (`packages/desktop/src/renderer/desktopOnboarding.ts`, its IPC in `desktopOnboardingIpc.ts`, messages in `packages/desktop/src/shared/desktopOnboardingMessages.ts`): **deleted.** Its question, "What are you working on?", becomes an `ask_user_question` during setup, answered by `apply_team` per project.
  - **CLI:** first-run continuation hands off to `texra orchestrator` instead of a `setup` run in the current directory.
- **What does not change:** the proposal card's `'setup'` action (`src/shared/schemas/request.ts`). It means "open this delegation for editing" and is unrelated to the setup agent.

## Later, separate proposals

- File, git and inbox-folder triggers for `wake` (a new PDF in `~/.texra/orchestrator/inbox/`, a co-author's push). They need a watcher outside the session. Today the only `fs.watch` is the agent-catalog follower.
- Durable GitHub subscriptions on the `wake` rows, retiring the in-memory `RunSubscriptionRegistry`.
- A separate reviewer for unattended proposals (the Dots auto-review, the Muse Sentinel) that checks a proposal against the researcher's written rules before it reaches them.
- One `theorist` agent per project, replacing `prover`, `research`, `numerics`, `review`, `search` and `leanOrchestrator`.
- Follow-ups taken between tool calls, not only at the turn boundary (`src/agent/runtime/loop/toolUse.ts`).
- A `verify` tool: Lean `sorry`/axiom audit, CAS checks at random points, and a novelty search.
- A `tournament` script for `delegate_multi_agents`.

## Open questions

1. Should agents other than the orchestrator get `wake` by default, or opt in per agent YAML?
2. Should a child dispatched into a project stay linked to the orchestrator when that project's session closes and reopens, or detach, as `detachSubagentsOnStop.ts` does for a stopped parent?
3. Should the daily budget default to a dollar figure, or be unset, so that unattended dispatch is off until the researcher picks one?
