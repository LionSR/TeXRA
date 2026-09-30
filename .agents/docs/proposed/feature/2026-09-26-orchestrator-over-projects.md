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
- **It uses the dispatch and execution tools that already exist,** each given one new field, `project`. That field works only from the orchestrator's session (§Cross-project scope). It gets two new tools: `projects` for the registry and `wake` for scheduled and event wakes. It also takes over the `setup` agent's job.
- **Nothing fires that nobody asked for.** Every wake is a row the orchestrator or the researcher committed. Every dispatch is a tool call the orchestrator made.

## Prior art (September 2026)

Three products shipped always-on agents this month. What we take and what we avoid:

- **OpenAI Dots** (2026-09-29). Proactive research while the user is away is strictly read-only. Consequential work is proposed for approval. There are per-action rules (allow / ask / block) and an activity view. We take **roam read-only, act on proposal** (§Unattended turns). Criticism: its memory cannot be edited per entry. Ours is plain files, per entry.
- **ChatGPT Pulse** (2025-09). One overnight pass yields a finite set of cards, not a feed. We take **the finite brief** (§Brief).
- **Manus 2.0 / Cue** (2026-09-28). Automations are triggered by events. Wide Research gives each item a fresh-context sub-agent. We take **event wakes** and **one fresh child per project**. Its top complaint is credit burn with no estimate and no cap. We make **a daily budget** part of v1 (§Budget).
- **Meta Muse** (2026-09-08). It keeps working after the app closes and comes back "when something changes or when it needs approval". A separate Sentinel approves anything that leaves the machine. We take the same shape: the approval gate is the existing core policy, not the orchestrator's own judgement.

## Its folder

- **Workspace:** `~/.texra/orchestrator/` is its working directory. The agent organizes it however it likes, and the researcher can open it like any project.
- **Creation:**
  - Both entry points create the folder before opening its session. The folder does not exist on a fresh install.
  - `resolveCliCwd` rejects a missing `--cwd`, and `DesktopProjectRegistry.open` does not create folders.
  - One `ensureOrchestratorFolder` in `src/controllers/orchestrator/` does `mkdir -p` and is called by both.
- **Memory:** the `memory` tool writes to `<storage>/memories` for this folder's workspace storage, `~/.texra/v1/workspace-storage/orchestrator-<hash8>/` (`src/tools/memory/memoryFileSystem.ts`, `src/platform/defaults/workspaceStorage.ts`). So the orchestrator has its own memory with no new code. The memories are plain files, editable and deletable one at a time.
- **Confinement:** the orchestrator's file tools stay inside the folder through `resolveToolPath` (`src/tools/pathResolution.ts`).
- **Not a secret store.** Keys live in `Secrets`, never in this folder.
  - Project agents are not pointed at the folder: no project prompt or tool mentions it.
  - It is not access-controlled from them either. `bash` in a project run runs raw shell commands (`src/tools/bash.ts`), and a project rooted at `~` would contain it.
  - The registry refuses a project root that contains `~/.texra`, so no file tool in a project reaches it. The folder holds notes and briefs, not credentials.

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
- **Two hosts at once is already safe for runs.**
  - Desktop and CLI share `~/.texra` and each workspace's `texra.db`. SQLite WAL with `BEGIN IMMEDIATE` guards every write, and per-aggregate owner claims check liveness by pid and start time (`src/agent/storage/leaseOwnerLiveness.ts`).
  - `resumeRun` refuses a run owned by another live process (`owned_elsewhere`, `src/agent/runtime/resumeRun.ts`).
  - Each open store sees the other process's commits through its `data_version` poll (`Database.ts`).
  - Wakes need one more rule, because both hosts run the wake fiber (§`wake`, Delivery).
- **Notifications** reuse `followDesktopAttention` (`packages/desktop/src/main/desktopAttention.ts`). It already posts an OS notification and badge when a request opens or a top-level run finishes in a project the user is not looking at. It follows the orchestrator's session like any other, so a brief that lands or a proposal that waits notifies with the window closed. Email and mobile are out of scope.
- **Pause wakes** is one global `app-state` flag. The wake fiber holds deliveries while it is set and delivers them late when it clears.

## Cross-project scope

A `project` field is a capability of **the orchestrator's session**, not of an agent name and not of every caller.

- **Who can use it.** A tool call may set `project` only when its session root is the orchestrator folder. Anywhere else the field is rejected with a `ToolError`.
  - So `assistant` or `engineer` in a project, which also list `delegate_agent` and `executions`, cannot reach another project.
  - The orchestrator folder is only ever opened by desktop and the CLI.
- **Where the registry is served.**
  - `ProjectRegistry` is served by the desktop and CLI composition roots, not by `installProcessRuntime`, so VS Code and the SDK are unchanged.
  - The tools read it with `Effect.serviceOption`. Absence is a worded `ToolError` ("projects are available in the TeXRA desktop app and CLI"), never a silent empty list.
  - `projects` and `wake`'s `on` trigger also declare `unavailableHosts: ['vscode', 'sdk']` (`src/tools/core/definition.ts`), so they never reach the model there.
- **Each call resolves the target once, up front.**
  - `sessionFor(project)` is resolved before the proposal is built, and that session's roots are used for everything the call prepares:
    - agent and model resolution, and the visible roster;
    - `working_directory` checks;
    - `assertWorkflowFilesExist` and the bibliography checks;
    - project configuration.
  - Today these read `call.roots` (`DelegationTools.ts` `executeDelegateAgentTool`, `executeWorkflowAgentTool`), so a file that exists only in the target project would fail before launch.
- **The destination is part of what is approved.**
  - `WorkflowAgentProposalSchema` and `ToolUseAgentProposalSchema` gain `project` (`src/shared/schemas/proposalInput.ts`, `prompts.ts`), so it survives parsing, `request.opened`, editing and replay.
  - The approval card shows the destination, and its file links resolve against the target root.

## Tools

**Existing tools, each gaining a `project` field:**

| Tool                                                                              | Today (one session)                                                                                                                                                                                                                                            | With `project: <root>`                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate_agent`, `delegate_workflow` (`src/tools/delegation/DelegationTools.ts`) | Start a child in the caller's session (`subagentRun.ts` `registerRun(parent.run.session, …)`). The child's report comes back as a `followup.queued` row from `{kind:'run'}` (`childRunLoop.ts`). Approval goes through proposal-or-bypass (`proposalFlow.ts`). | Starts a **top-level run in that project's session**, with a durable `origin` pointing at the orchestrator run (§Changes 2). Its ledger, approvals and resume live there. Its report is admitted onto the orchestrator's run. |
| `delegate_multi_agents` (`src/tools/delegation/WorkflowScriptTool.ts`)            | Fans a script's `agent()` operations out in the caller's session                                                                                                                                                                                               | Each `agent()` may name a `project`. One fresh-context run per project is the Wide Research shape.                                                                                                                            |
| `executions` (`src/tools/executions/`)                                            | `view`, `wait`, `kill`, `send {message}`, `query {sql}` over the caller's session (`send.ts`, `queryAction.ts`, `ExecutionsTool.ts`)                                                                                                                           | Holds **two sessions** (§Changes 3): the caller's, for identity and its own follow-up queue during `wait`, and the target's, for view, query, send, kill and the run's files.                                                 |
| `accept_run_files`                                                                | Looks the run up in the caller's storage and writes through the caller's `WorkspaceFs`                                                                                                                                                                         | Looks the run up in the target's storage and writes through the target's `WorkspaceFs`, with the target's edit approval.                                                                                                      |
| `read_config`, `update_config`, `apply_team` (`src/tools/setup/`)                 | Read and write the caller's workspace config and roster (`ToolCall.roots`)                                                                                                                                                                                     | Read and write the target project's `ConfigProvider` and roster (§Setup).                                                                                                                                                     |

This gives dispatch, steering (`executions send`), stopping (`kill`), inspection (`view`, `query`), acceptance and result delivery with no new commands.

**New:**

- **`projects`** (`src/tools/projects/`): commands `list` and `open <path>`.
  - `list` returns each project's root, whether it is open, live and paused runs, pending requests, and today's spend. Everything comes from `SessionView` (`attentionOf`, per-run `usage`) and the day-spend projection (§Budget), with no model call.
  - `open` registers an existing folder and opens its session. It has no file effects, so it needs no approval.
  - There is no `create`. There is no generic tool-call approval to hang one on, and creating a folder is already `bash mkdir` under the bash policy followed by `open`.
  - Anything deeper goes through `executions` with `project`.
- **`wake`** (`src/tools/wake/`). Modelled on Claude Code's `send_later`, extended with recurrence and events (Manus Automations, Dots recurring tasks).
  - **Input:** `message`, and exactly one trigger:
    - `at` (ISO time) or `delay_minutes`;
    - `every` (`daily HH:MM` or `weekdays HH:MM`, in local time);
    - `on` (`{project, event}`, where `event` is `run_finished`, `run_failed` or `request_opened`).
  - **Other input:**
    - optional `name`, a short label;
    - `initiation`, either `researcher_asked` or `own_followup`;
    - optional `budget_usd`, a cap on what the woken turn and its dispatches may spend (§Budget).
  - **Result:** an `id`. `cancel: <id>` cancels it and `list: true` lists what is pending.
  - **Storage.** Each wake is its own aggregate, kind `wake`, logical id `wakeId`, in the orchestrator's store (`event_sequence.kind`, `src/controllers/session/storeSchema.ts`). It is not a row under the run that scheduled it.
    - `wake.scheduled {wakeId, targetRunId, trigger, message, name, initiation, budgetUsd, grant, cursor}`.
    - `wake.fired {wakeId, deliveryId, cursor}`.
    - `wake.cancelled {wakeId}`, the aggregate's tombstone.
    - Deleting the conversation that scheduled it does not drop it.
    - Deleting the target run cancels its wakes, with the cancellation written as a `wake.cancelled` row and listed.
    - The fold of the `wake` aggregates is the pending set that `list` returns and the orchestrator home renders.
  - **Event cursor.**
    - An `on` wake records the target store's `commit` at scheduling as `cursor`. Each `wake.fired` advances it to the triggering row's commit.
    - On restart or reopen, the fiber scans the target's `run.end` and `request.opened` rows after the cursor. So a failure that happened while no host ran still wakes once, and nothing older than the schedule ever does.
    - It does not reuse `desktopAttention`'s first-view-is-history rule.
  - **Delivery.** One fiber per open session, forked beside the session's other scoped fibers in the `Sessions` layer (`src/controllers/session/sessionLayer.ts`).
    - It sleeps until the earliest due time, and follows each target store for `on` wakes.
    - Delivery is one `SessionEvents.exclusive` job. Inside the write transaction it re-reads the wake's rows, and appends nothing if a `wake.cancelled` is there. Otherwise it appends `wake.fired` and the follow-up together.
    - A cancel committed by the other host therefore always wins, and two hosts firing the same due time collide on `deliveryId`: `wakeId` plus the due time or triggering commit, skipped on replay by the queue manager and the fold (`ToolUseFollowUpQueueManager.ts`, `runRows.ts`).
    - The follow-up is `submitFollowUp(targetRunId, {text, from: {kind:'wake', wakeId, initiation}, deliveryId}, {session})`.
  - **Missed times:** if no host was running at `at`, the message is delivered when the session next opens, marked late ("was due 09:00"). A recurring wake missed several times delivers once.
  - **This replaces the in-memory `RunSubscriptionRegistry` route** for anything the orchestrator watches. GitHub subscriptions stay as they are for now (Later).
  - **The UI labels each delivery** by `initiation`: "Check-in you asked for" or "Check-in the orchestrator set".

**Also on:**

- `memory` and `ask_user_question`, which `orchestrator.yaml` does not list today.
- `inquiry`, `todo_write`, `plan`, `github_subscription`, file tools and `bash`, as today.

## Unattended turns

Borrowed from Dots: a turn nobody is watching roams read-only and acts only by proposal.

- **A wake-started turn cannot bypass approval.** A turn whose input is a `{kind:'wake'}` follow-up runs under the `ask` policy whatever the run's stored policy. It also runs with no scoped bash bypass. The rule lives in core approval state (`src/shared/approvalPolicy.ts`), next to the headless `yolo` refusal.
  - Reading is free: `projects list`, `executions view` / `query`, and file reads.
  - Every cross-project `delegate_*`, `executions send` / `kill`, `accept_run_files`, `update_config` / `apply_team`, and every `bash` call opens a request.
- **Attended turns follow the run's existing policy,** `bash` included. `yolo` or a scoped bash bypass lets `bash` run without asking there, as it does in any session today.
- **An unanswered request waits durably.** With no host attached, requests already open and wait in the fold (`HostInteractions.ts`). The desktop notifier announces them. The orchestrator home lists them as the researcher's inbox.
- **The researcher can pre-approve.** A wake with `initiation: researcher_asked` may carry a `grant`: a goal-grant scope, `commands` or `allAgentWork` (`src/tools/goal/goalAutoApproval.ts`), that the researcher approved when scheduling it.
  - The grant is stored on `wake.scheduled`.
  - It is re-armed for the delivered turn only. `SessionApprovals.restoreRun` still never restores goal grants in general.
  - So a restart between scheduling and delivery keeps the approval, and it does not leak into later turns.
  - Wakes the orchestrator set for itself never carry one.

## Requests from other sessions

A run dispatched into a project opens its later requests (bash, edits, retries) on **that** project's session. That is where they belong, since the project view shows them. Every host that can dispatch must also be able to answer them.

- **Desktop** already follows every open project's requests (`desktopAttention.ts`) and shows them in each project's view. The orchestrator home also lists them.
- **CLI.** `texra orchestrator` subscribes to the request stream of every session it opened through `ProjectRegistry`, not just its `runtimeSession`. The TUI renders a project's request with the project name and decides it on the session it came from. Without this, a dispatched run would stall on its first bash call.

## Budget

There is no spend limit anywhere today; the only limit is the child-run concurrency cap. Unattended work needs one before it ships.

- **Settings:** `orchestrator.dailyBudgetUsd` (default 5) in the Zod settings catalog (`src/shared/schemas/coreSettings.ts`) and the settings view.
- **What counts.**
  - Every priced turn of a run whose lineage reaches the orchestrator: its own, and runs it dispatched into projects through `origin`.
  - **At the model's API rates, including on a plan route.**
    - `pricing.ts` prices a plan-backed turn (ChatGPT/Codex, Grok, the GLM coding plan, Kimi Code) at zero, which would make the cap unreachable there.
    - The budget ignores the `plan` flag and uses the catalog rates.
    - A plan-route model with no catalog rate cannot be used for unattended dispatch. The proposal card says so.
- **Where it is read.**
  - `run_usage` holds one cumulative value per run, so it cannot answer "since midnight".
  - A `run_spend_day (aggregate, day, usd)` projection beside `run_usage` (`src/controllers/session/storeSchema.ts`) is updated from the same priced rows, with the local date as the bucket.
  - The daily total sums today's bucket over the orchestrator's store and the stores of the projects it dispatched into.
- **Enforcement is per model call, not per dispatch.**
  - `ModelInvoker`, the one service that calls a model, checks the day's total before each call of a run in the orchestrator's lineage, and the wake's `budget_usd` if it has one.
  - Over either cap, the run stops at a checkpoint before the call and opens a request: "Daily budget reached ($5.00). Continue with $N more?"
  - Nothing is discarded. A stopped run continues from its journal on approval.
  - The overshoot is bounded by the calls already in flight, one per concurrent run. We do not reserve allowance ahead of a call: a turn's cost is not known until it ends, and an estimate would be a guess.
- **Estimates:** the proposal card for a dispatch shows the run's model and what is left of the day's budget. We do not guess a dollar figure for the task.

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
   - A `ProjectRegistry` service with `list`, `open(root)` and `sessionFor(root)`, served by the desktop and CLI composition roots only (§Cross-project scope).
   - Desktop serves it from `DesktopProjectRegistry`. The CLI serves it from the same record and opens sessions through the `Sessions` layer.
   - `texra` adds the cwd to `recent` on open, as the desktop does.
   - `open` refuses a root that contains `~/.texra`.
   - VS Code stores live under `context.storageUri`, outside `~/.texra`, so they are not in the registry.
2. **Dispatched runs are top-level runs with an origin, not cross-session children.**
   - A child's lineage is session-local:
     - `registerRun` checks that the parent's records exist in the same session;
     - `RunRegistry` stop and ancestry, `isOwnedBy`, approval ancestry and `detachSubagentsOnStop` are all per session.
   - Rather than stretch every one of those across two stores, a run dispatched with `project` is registered in the target session **with no parent**. It carries `origin {sessionRoot, runId}` on its `run.start`.
   - **Its report** is admitted onto the origin run in the origin session, as `from: {kind:'run', runId, relation:'dispatched'}`. `runRelation` (`src/shared/session/runRelation.ts`) gains that relation, stamped from `origin` rather than from `parentOf`.
   - **Stopping** it from the orchestrator is `executions kill` with `project`. That checks `origin` against the caller, not `isOwnedBy`.
   - **Closing the orchestrator** or the project does not detach or stop it. It is top-level in its project and finishes there. Its report waits on the origin run's queue until that session is next open.
3. **`executions` with `project` holds two sessions.**
   - The caller's session, `Runs` and follow-up queue stay as today, for identity and for `wait` to see the caller's own follow-ups.
   - A target context is resolved from `sessionFor(project)`: its view, query, runs, `StorageFs` and `WorkspaceFs`. `view`, `query`, `send`, `kill` and file reads use it.
   - `send` records `from` as the caller's run, with relation `dispatched` when the target's `origin` is the caller.
4. **Wake sender kind.**
   - Add `{kind:'wake', wakeId, initiation}` to the sender union (`src/shared/schemas/followUp.ts`).
   - `submitFollowUp`'s no-loop branch lets a `wake` follow-up resume a resumable run, as it does for `user` (`src/agent/followUp/ToolUseFollowUp.ts`). It still never restarts a run the user stopped.
5. **`wake`.**
   - The `wake` aggregate kind and its three events go in `src/shared/schemas/sessionEvent.ts`, with their fold in `src/shared/session/sessionFold.ts`.
   - The fiber, its cursor scan and its `exclusive` delivery go in `sessionLayer.ts`.
6. **Unattended policy, budget and cross-session requests** (§Unattended turns, §Budget, §Requests from other sessions). The budget adds the `run_spend_day` projection and the per-call check in `ModelInvoker`.
7. **Tools.**
   - Register `projects` and `wake` in `src/tools/registry.ts` and `src/tools/pluginManifest.ts`.
   - Add `project` to `delegate_*`, `delegate_multi_agents`, `executions`, `accept_run_files`, `read_config`, `update_config` and `apply_team`, with the session-root gate and up-front resolution (§Cross-project scope).
   - Add `project` to the two proposal schemas and render it on the approval cards.
8. **`orchestrator.yaml`.** Rewrite `packages/extension/resources/tool_use_agents/orchestrator.yaml`. Its current prompt is a single-project LaTeX steward. The new one states the job and the limits only, with no routines.
9. **Desktop background.** Covers the `window-all-closed` change, the tray, the login item, `ensureOrchestratorFolder`, and the orchestrator folder pinned first in the project rail.
10. **CLI.** `texra orchestrator [--stay]` runs `ensureOrchestratorFolder`, then opens `~/.texra/orchestrator` with the agent preselected and multiplexes requests from dispatched sessions.
11. **The orchestrator does setup** (§Setup). Delete `packages/extension/resources/tool_use_agents/setup.yaml`, and remove `setup` from `STARTER_AGENT_MODE_PRESET.toolUse` (`src/shared/schemas/agentPresets.ts`).

Done when (each is an E2E through the real `texra` CLI or desktop, ending in a diffable artifact):

- `delegate_workflow` with `project` names a file that exists only in the target project. The dispatched run appears, is approved showing its destination, asks for a bash approval that the CLI answers, and resumes in that project. Its report comes back to the orchestrator, and `accept_run_files` with `project` writes the output there.
- `executions` with `project` lists, messages and kills that project's runs, and `wait` still sees the orchestrator's own follow-ups.
- `assistant` in a project calling `delegate_agent` with `project` gets a `ToolError`.
- A `wake` with `at` arrives after TeXRA is restarted before its time. A cancelled one never arrives, including when the other host cancels it.
- An `on: run_failed` wake arrives when a project run fails while no host is running, once, after the next launch. A failure from before the wake was scheduled never triggers it.
- With the desktop and `texra orchestrator --stay` both up, one wake is delivered once.
- Deleting the conversation that scheduled a recurring wake leaves the wake pending.
- A wake-started turn with `yolo` stored still opens a request for a cross-project dispatch and for `bash`.
- A `researcher_asked` wake with a `commands` grant, delivered after a restart, runs its commands without asking, and the next attended turn asks.
- With the daily budget set to $0.01, a woken run on a plan route stops before its next model call and asks, and continues on approval. A run spanning midnight counts only today's turns.
- First-run setup on desktop and the CLI runs as an orchestrator run in `~/.texra/orchestrator/`, created if absent. Resuming it after a restart and finishing it does not mark the first real run done.

## Setup

The `setup` agent's job is environment, keys, config, teams and the first task. That is portfolio-level work, so it moves into the orchestrator.

- **Tools.**
  - `orchestrator.yaml` gains all of `setup.yaml`'s own tools: `probe_environment`, `verify_setup`, `list_api_keys`, `unset_api_key`, `read_config`, `update_config`, `apply_team`, and the VS Code–only `invoke_command`, `install_vscode_extension`, `send_to_terminal`.
  - The last three declare `unavailableHosts: ['cli', 'desktop', 'sdk']`. They are withheld on desktop and the CLI with no change, as they are for `setup` today.
  - `read_config`, `update_config` (workspace scope) and `apply_team` take `project`. They resolve that project's `ConfigProvider` and call `AgentRosterController.applyTeam` on its roots, instead of `ToolCall.roots` (`src/tools/setup/ApplyTeamTool.ts`, the config tools). So the value the orchestrator reads before a change is the target project's, and the team lands in the project being onboarded. Without `project` they act on the orchestrator folder, as today.
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
  - VS Code holds one session per window, so there the orchestrator runs in that window's session, without `projects`, the `project` fields or `on` wakes.
- **Onboarding funnel.**
  - `AgentRunLifecycle.ts` excludes runs of the agent named `SETUP_AGENT_NAME` from "first real run completed".
  - Since the orchestrator also does real work, the exclusion keys on the run's purpose. `setupLaunch.ts` launches with `purpose: 'setup'`, which is recorded on the run's `run.start` and folded into `RunState`. So a setup run resumed after a restart is still a setup run.
  - `AgentRunLifecycle` reads the purpose from the fold. `SETUP_AGENT_NAME` goes away.
- **UI.** The funnel (`needs-credential` → `setup` → `done`, `src/controllers/onboarding/onboardingFunnel.ts`) is unchanged. It is a fact about the user, so on desktop it renders in one place, the orchestrator home.
  - **`needs-credential`:** `OnboardingWelcomeCard` moves unchanged into the orchestrator home. On first launch the desktop selects the Orchestrator row, which stands alone in the rail over "Open a project folder".
  - **`setup`:**
    - The hero (`ProgressApp.ts` `renderHero`, `host.onboarding === 'setup'`) moves to the orchestrator home. Its title changes from "Set up {project}" to "Set up TeXRA".
    - Its "Run setup assistant" button runs `setupLaunch.ts`. "Skip setup" stays.
    - `ONBOARDING_SETUP_HANDOFF` (`src/ui/copy/onboarding.ts`) now says: the orchestrator checks your environment, registers your projects and agents, sets up your morning brief, and starts your first task.
    - VS Code, which has no orchestrator row, keeps the hero in its window.
  - **`done`:** the orchestrator home is the "All projects" overview: the newest brief, pending requests across projects, and pending wakes.
  - **Desktop startup team panel** (`packages/desktop/src/renderer/desktopOnboarding.ts`, its IPC in `desktopOnboardingIpc.ts`, messages in `packages/desktop/src/shared/desktopOnboardingMessages.ts`): **deleted.** Its question, "What are you working on?", becomes an `ask_user_question` during setup, answered by `apply_team` with `project` per project.
  - **Starter roster:** `STARTER_AGENT_MODE_PRESET` drops `setup`. It keeps `orchestrator`, so a project that skipped the discipline choice has no permanently missing agent.
  - **CLI:** first-run continuation hands off to `texra orchestrator` instead of a `setup` run in the current directory.
- **What does not change:** the proposal card's `'setup'` action (`src/shared/schemas/request.ts`). It means "open this delegation for editing" and is unrelated to the setup agent.

## Later, separate proposals

- File, git and inbox-folder triggers for `wake` (a new PDF in `~/.texra/orchestrator/inbox/`, a co-author's push). They need a watcher outside the session. Today the only `fs.watch` is the agent-catalog follower.
- Durable GitHub subscriptions on `wake` aggregates, retiring the in-memory `RunSubscriptionRegistry`.
- A separate reviewer for unattended proposals (the Dots auto-review, the Muse Sentinel) that checks a proposal against the researcher's written rules before it reaches them.
- One `theorist` agent per project, replacing `prover`, `research`, `numerics`, `review`, `search` and `leanOrchestrator`.
- Follow-ups taken between tool calls, not only at the turn boundary (`src/agent/runtime/loop/toolUse.ts`).
- A `verify` tool: Lean `sorry`/axiom audit, CAS checks at random points, and a novelty search.
- A `tournament` script for `delegate_multi_agents`.

## Open questions

1. Should agents other than the orchestrator get `wake` by default, or opt in per agent YAML?
2. Should the daily budget default to a dollar figure, or be unset, so that unattended dispatch is off until the researcher picks one?
