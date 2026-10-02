---
created: 2026-09-26
status: proposed
---

# PRD: an always-on orchestrator over all projects

Baseline: `main` at `3590913` (revised 2026-10-01). Not scheduled for implementation. This PRD records the agreed shape so the build can start from it later.

## Problem

A researcher using TeXRA has several projects at once: a paper under review, a Lean blueprint, a talk. Each project's agents only work while someone is looking at that project.

- Nobody watches across projects. A run that has waited on an approval since Sunday stays invisible until the researcher happens to open that project.
- Nothing checks back on its own. Every follow-up starts with the researcher remembering to ask.
- When the window closes, everything stops. On Windows and Linux the desktop app quits when its last window closes (`packages/desktop/src/main/index.ts`, `window-all-closed`). On macOS the process stays up, but there is no tray icon and nothing is scheduled to happen.

## Who it is for

A single researcher on their own machine, using the desktop app or the `texra` CLI. It is not a team feature and not a cloud service.

## Goals

1. One agent that sees every project and can send work into any of them.
2. It checks back on its own schedule, including after a restart.
3. It keeps going with no window open.
4. It needs no new judgement machinery from the harness. Cadence, what to report and what to dispatch are left to the model.

## Non-goals

- Recurring schedules, event triggers, inbox folders or email.
- A spend cap. Spend is reported, not limited, until running it shows a cap is needed.
- Special model handling for the orchestrator.
- A brief format, cards or a dashboard.
- VS Code and SDK support. Neither has a process that outlives its window.
- Taking over the `setup` agent. That is a separate proposal.

## How it looks to the researcher

The orchestrator is a **default project**. TeXRA creates the folder `~/.texra/orchestrator/` and pins it first in the project list. The researcher chats with it like any agent in any project.

A typical week:

1. **Monday evening.** The researcher says the referee report for the channels paper is due Friday. The orchestrator calls `projects list`. It notices the Lean blueprint has been waiting on a `lake build` approval since Sunday and says so. It calls `wake` for Tuesday 08:00 with a note to itself.
2. The researcher closes the window. TeXRA stays in the tray.
3. **Tuesday 08:00.** The wake arrives on the orchestrator's chat as an ordinary message. The orchestrator looks inside the paper project with `executions` and finds no response draft.
4. It proposes a run in that project: draft `response/referee1.tex` from `reviews/report1.pdf`. The proposal card names the destination project, and the OS notification fires.
5. It replies with the two things that need the researcher, then calls `wake` for Wednesday.
6. The researcher approves over coffee. The run executes inside the paper project. When it ends, its report comes back to the orchestrator: seven points answered, two needing the author's call.

The model decided everything in that sequence: when to wake, what to check, what to propose, what to say. The harness delivered the wake, reached into the project and kept the process alive.

## Requirements

### R1. A `project` field on the dispatch and inspection tools

Tools: `delegate_agent`, `delegate_workflow`, `delegate_multi_agents`, `executions`, `accept_run_files`.

- **Only from the orchestrator's folder.** The field is accepted only when the calling session's root is the orchestrator folder. Anywhere else it is a `ToolError`, so project agents cannot reach each other.
- **Prepared against the target.** The call resolves `sessionFor(project)` up front and prepares everything against that project's roots: agent, model, files, working directory. Today these read `call.roots` (`src/tools/delegation/DelegationTools.ts`).
- **The destination is visible.** The proposal schemas carry `project`, and the approval card shows it.
- **A dispatched run is an ordinary top-level run in the target project.**
  - It carries `origin {sessionRoot, runId}` on its `run.start`.
  - Child lineage is session-local (`registerRun`, `RunRegistry`, `isOwnedBy`), so no parent link crosses two stores.
  - Its ledger, approvals and resume all live in that project.
- **Its report comes back.** When the run ends, its report is admitted onto the orchestrator's run as `from: {kind:'run', runId, relation:'dispatched'}`, the same way a subagent report arrives today (`src/agent/runtime/childRunLoop.ts`).
- **`executions` with `project`** reads and acts on the target session: view, query, send, kill. It keeps the caller's own session for `wait`.

### R2. A `projects` tool

- **One command, `list`.** For each project it returns the root, live and paused runs, pending requests, and today's spend (shown, not limited). Everything is read from `SessionView`, with no model call.
- **The registry.** The desktop's remembered projects move from the `desktop-projects` record to a host-neutral `projects` record in `GlobalDatabase`. Desktop and the CLI both read it.
- **Hosts.** `projects` declares `unavailableHosts: ['vscode', 'sdk']`.

### R3. A `wake` tool

- **Input.** `wake {at | delay_minutes, message}`. Also `cancel: <id>` and `list: true`.
- **One-shot only.**
  - To check in again, the model schedules its next wake when it wakes.
  - Runs it dispatched report back without one.
  - For anything else, it reads `projects list` when it wakes.
- **Stored on the orchestrator's run.**
  - The rows are `wake.scheduled {wakeId, at, message}` and `wake.cancelled {wakeId}`, published through `SessionHandle.publish` and folded with the run.
  - Deleting the run deletes its wakes.
- **Delivery.**
  - A fiber in the session's scope (`src/controllers/session/sessionLayer.ts`) sleeps until the earliest `at`.
  - It then calls `submitFollowUp(runId, {text, from: {kind:'wake', wakeId}, deliveryId: wakeId}, {session})`. `deliveryId` makes a replay a no-op.
  - The no-loop branch of `submitFollowUp` (`src/agent/followUp/ToolUseFollowUp.ts`) lets a `wake` follow-up resume a resumable run, as a `user` message can.
- **Missed wakes.** A wake missed while TeXRA was off arrives when the session next opens, marked late.
- **Accepted imperfection.** With the desktop and the CLI both running, a wake cancelled on one may still arrive once from the other. The model sees that it was cancelled and ignores it.
- **Hosts.** `wake` declares `unavailableHosts: ['vscode', 'sdk']`.

### R4. Staying on

- **Desktop.**
  - A `background` setting, on by default, keeps the process up after the last window closes on every platform.
  - A tray item offers Open and Quit.
  - `startAtLogin` is off by default.
  - The desktop opens the orchestrator folder at every launch and creates it if missing.
- **CLI.** `texra orchestrator --stay` opens the same folder and keeps its session open until killed. It is for machines without the desktop.
- **Notifications.** The existing desktop notifier (`packages/desktop/src/main/desktopAttention.ts`) already posts an OS notification when a request opens or a top-level run finishes. It covers the orchestrator's session with no change.

## What stays as it is

- **It is an ordinary project.** Chats, history, agents and settings work there as in any folder.
- **Models.**
  - The researcher picks the orchestrator's model when starting a chat.
  - The CLI's `/model` switches a live run to a model with the same conversation format (`src/agent/runtime/loop/modelSwitch.ts`).
  - To use any other model, the researcher starts a new chat in the orchestrator project. The new chat picks up from the notes and `memory` in the folder.
  - Wakes set by the old chat still go to the old chat.
  - A dispatched run takes its own `model`. When none is given, it uses the target project's default.
- **Approval.**
  - The orchestrator's dispatches follow its run's existing proposal policy: they are proposals unless the researcher turned bypass on. A dispatched run follows its own project's policy.
  - With nobody attached, requests wait durably and the desktop notifies.
  - A request on a run another process owns is shown read-only, because `SessionRequests.decide` answers `NotOwner`.
- **Memory.** The `memory` tool writes per workspace storage, so the orchestrator folder has its own. The model keeps any other notes as files in the folder.
- **Other tools.** `todo_write`, `plan`, `inquiry`, `ask_user_question`, file tools and `bash`, as today.

## The prompt

`packages/extension/resources/tool_use_agents/orchestrator.yaml` is rewritten to roughly this and nothing more:

> You look after all of this researcher's projects. Use `projects list` to see them and `executions` to look inside one. Dispatch work with `project` where it helps; ask before anything costly or irreversible. Check back on your own schedule with `wake`. Keep your notes in your folder. When you wake, tell the researcher only what needs them.

The current file is a single-project LaTeX steward prompt. The new one has no routines and no brief format. The orchestrator's reply when it wakes is the brief.

## Comparison: Claude Code's scheduling tools

| Claude Code          | What it does                                                                                                                  | Survives the session ending?   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `ScheduleWakeup`     | Re-runs the current prompt after 60–3600 seconds. Only inside a self-paced `/loop`.                                           | No                             |
| `CronCreate`         | Queues a prompt by 5-field cron, once or recurring. Recurring jobs expire after 7 days. It fires only while the REPL is idle. | No. Jobs are in memory only.   |
| `/schedule` routines | Cloud agents on a cron schedule or a webhook trigger. Each fire starts a remote session.                                      | Yes, but they run in the cloud |

`wake` is closest to `ScheduleWakeup`: the model picks the next time itself, with no recurrence. It differs in one way, and that difference is the point: it is durable and local. It is a row in the project's SQLite store, so it survives restarts, and a missed wake arrives late. Cloud routines are out of scope: TeXRA is local-first and is removing sign-in.

## Prior art (September 2026)

All four products below are weeks old. The details come from vendor posts and same-day press, and none has been reviewed independently. openai.com returned 403 when we fetched it, so the Dots details come from press that quotes the announcement.

- **OpenAI Dots** (2026-09-29).
  - What it is: always-on agents on GPT-6 Astra, each with its own cloud computer and browser and about 4,000 app connectors, reached from ChatGPT, Slack or Teams.
  - What wakes it: schedules, events, and its own proactive research while the user is away.
  - Limits: proactive research is strictly read-only. Custom Rules set each action class to allow, ask or block, and a separate auto-review checks each proposed action.
  - Reporting: an Activity View.
  - Criticism: memories cannot be deleted without deleting the whole Dot.
  - We take: read freely, act by proposal. That is already TeXRA's default.
  - We leave: rules and the separate reviewer.
- **ChatGPT Pulse** (preview 2025-09-25).
  - What it does: researches overnight, once a day, from chats, memory, Gmail and Calendar, and shows 5–10 cards in the morning. It is finite by design.
  - Steering: "Curate" and thumbs up or down.
  - We take: a short report that ends.
  - We leave: cards, ratings and a fixed daily time.
- **Manus 2.0 and Cue** (2026-09-28).
  - Features: Automations fire on email, calendar, Slack, Notion or metric changes. Mail Manus starts a task from a forwarded email. Wide Research gives each item its own sub-agent with a fresh context and VM. Projects carry a master instruction and a knowledge base. Cue gives each agent an email address, phone number, wallet and computer.
  - Ownership: Meta's acquisition was blocked by China's NDRC on 2026-04-27, and Manus operates independently.
  - Criticism: credit burn with no estimate beforehand, tasks that stop dead when credits run out, and a prompt-injection-to-code-execution disclosure on Sep 24.
  - We take: one fresh run per project, where only the report comes back.
  - We leave: event triggers, inboxes and wallets.
- **Meta Muse** (US launch 2026-09-08).
  - What it is: built on Muse Spark. It runs on a dedicated cloud VM.
  - Behavior: it "keeps working after people close the app, and comes back when something changes or when it needs approval." It shows evidence of completion and keeps an audit trail.
  - Limits: a separate Sentinel agent approves anything that reaches the internet.
  - Criticism: privacy trust, and prompt injection as an open problem.
  - We take: keep working after the window closes, and come back when something needs the researcher.
  - We leave: a second supervising agent. The approval gate is TeXRA's existing policy, in code.

The shape they share: work continues in the background, and the agent comes back to the person. TeXRA takes that shape and runs it on the researcher's own machine.

## Acceptance

Each check is an E2E through the real desktop app or `texra` CLI, ending in a diffable artifact.

- `delegate_workflow` with `project` runs in that project, naming a file only that project has, and its report comes back to the orchestrator.
- A project agent that sets `project` gets a `ToolError`.
- A `wake` arrives even though TeXRA was restarted before it was due.
- With the desktop's window closed, a woken orchestrator dispatches a proposal and the OS notification appears.

## Later, separate proposals

- The orchestrator takes over the `setup` agent's job, and `setup.yaml` goes.
- Recurring or event wakes, if models forget to reschedule.
- A spend cap on unattended work, if running it shows one is needed. `src/agent/runtime/run/pricing.ts` records plan-route turns at $0, so a cap would have to price those turns at API rates.
- A reviewer for unattended proposals.
- One `theorist` agent per project, replacing `prover`, `research`, `numerics`, `review`, `search` and `leanOrchestrator`.

## Open questions

1. Should other agents get `wake`, or only the orchestrator? The recommendation is orchestrator-only at first.
2. Should `wake` enforce a minimum interval, for example 15 minutes, so a cheap model cannot wake every minute? The recommendation is to watch first and add it only if needed.
