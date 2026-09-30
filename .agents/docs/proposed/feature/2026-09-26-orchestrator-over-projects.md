---
created: 2026-09-26
status: proposed
---

# One always-on orchestrator over all projects

Baseline: `main` at `d38e473` (revised 2026-09-30).

## Idea

One agent, `orchestrator`, looks after all of a researcher's projects. It lives in a **default project**, the folder `~/.texra/orchestrator/`, which TeXRA creates and pins first. It stays on when no window is open, checks back on its own schedule, and dispatches agents into projects.

The design trusts the model. The harness adds only what a model cannot do for itself:

- reach into another project;
- be woken later;
- stay running.

Everything else is the model's judgement, stated once in its prompt: how often to check in, what to report, what to dispatch, and how to keep its notes.

## What the harness adds

1. **A `project` field** on `delegate_agent`, `delegate_workflow`, `delegate_multi_agents`, `executions` and `accept_run_files`.
   - It is accepted only when the calling session's root is the orchestrator folder. Anywhere else it is a `ToolError`, so project agents cannot reach each other.
   - The call resolves `sessionFor(project)` up front and prepares everything against that project's roots: agent, model, files, working directory.
   - The proposal card shows the destination.
   - A dispatched run is an **ordinary top-level run in that project**, with `origin {sessionRoot, runId}` on its `run.start`. A child's lineage is session-local (`registerRun`, `RunRegistry`, `isOwnedBy`), so no parent link crosses stores.
   - When the run ends, its report is admitted onto the orchestrator's run as `from: {kind:'run', runId, relation:'dispatched'}`, as a subagent report is today (`childRunLoop.ts`).
   - `executions` with `project` reads and acts on the target session, and keeps the caller's session for its own `wait`.
2. **A `projects` tool** with one command, `list`. For each registered project it returns its root, live and paused runs, pending requests and today's spend (reported, not limited), all read from `SessionView` with no model call.
   - The registry is the desktop's remembered-projects record, moved from `desktop-projects` to a host-neutral `projects` value in `GlobalDatabase`.
   - Desktop and the CLI serve it. VS Code and the SDK do not, and `projects` declares `unavailableHosts: ['vscode', 'sdk']`.
3. **A `wake` tool:** `wake {at | delay_minutes, message}`, plus `cancel: <id>` and `list: true`.
   - There is no recurrence and there are no event triggers.
     - To check in again, the model schedules its next wake when it wakes.
     - Runs it dispatched already report back to it.
     - For anything else, it looks at `projects list` when it wakes.
   - A wake is a row on the orchestrator's own run: `wake.scheduled {wakeId, at, message}` and `wake.cancelled {wakeId}`, published through `SessionHandle.publish` and folded with the run. Deleting the run deletes its wakes.
   - A fiber in the session's scope (`src/controllers/session/sessionLayer.ts`) sleeps until the earliest `at`. It then calls `submitFollowUp(runId, {text, from: {kind:'wake', wakeId}, deliveryId: wakeId}, {session})`.
     - `deliveryId` makes a replay a no-op.
     - A wake missed while TeXRA was down arrives when the session next opens, marked late.
     - With two hosts up, a wake cancelled on one may still arrive once from the other. The model sees that it was cancelled and ignores it. We accept that rather than build an ownership protocol.
   - `submitFollowUp`'s no-loop branch lets a `wake` follow-up resume a resumable run, as it does for `user` (`src/agent/followUp/ToolUseFollowUp.ts`).
4. **Staying on.**
   - On desktop, a `background` setting (on by default) keeps the process up when the last window closes on every platform. Today only macOS does (`packages/desktop/src/main/index.ts`).
   - A tray item offers Open and Quit.
   - `startAtLogin` is off by default.
   - The desktop always opens the orchestrator folder at launch. It creates the folder if missing.
   - For a machine without the desktop, `texra orchestrator --stay` opens the same folder and keeps its session open until killed.
   - Existing OS notifications (`desktopAttention.ts`) already cover the orchestrator's session.

## What stays as it is

- **It is an ordinary project.** Chats, history, agents and settings work there as in any folder.
- **Models work as they do today.**
  - You pick the orchestrator's model when you start a chat.
  - The CLI's `/model` switches a live run to a model with the same conversation format.
  - To use any other model, start a new chat in the orchestrator project. Its notes and `memory` are in the folder, so the new chat picks up from them.
  - Wakes set by the old chat are still delivered to the old chat.
  - A dispatched run takes its own `model`. When that is empty, it uses the target project's default.

- **Approval.** The orchestrator's dispatches follow its run's existing proposal policy: a proposal unless the researcher turned bypass on. A dispatched run follows its project's policy.
  - With nobody attached, requests wait durably, as they do today, and the desktop notifies.
  - A request on a run another process owns is shown read-only (`SessionRequests.decide` answers `NotOwner`).
- **Memory.** The `memory` tool already writes per workspace storage, so the orchestrator folder has its own. The model keeps whatever other notes it likes as files there.
- **Tools it already has:** `todo_write`, `plan`, `inquiry`, `ask_user_question`, file tools, `bash`.

## The prompt

`orchestrator.yaml` is rewritten to roughly this and no more:

> You look after all of this researcher's projects. Use `projects list` to see them and `executions` to look inside one. Dispatch work with `project` where it helps; ask before anything costly or irreversible. Check back on your own schedule with `wake`. Keep your notes in your folder. When you wake, tell the researcher only what needs them.

There are no routines and no brief format. The orchestrator's reply when it wakes is the brief.

## Done when

Each item is an E2E through the real desktop or `texra` CLI, ending in a diffable artifact.

- `delegate_workflow` with `project` runs in that project, naming a file only that project has, and its report comes back to the orchestrator.
- A project agent that sets `project` gets a `ToolError`.
- A `wake` arrives after TeXRA is restarted before its time.
- With the desktop's window closed, a woken orchestrator dispatches a proposal and the OS notification appears.

## Later, separate proposals

- The orchestrator takes over the `setup` agent's job (environment, keys, teams, first task), and `setup.yaml` goes.
- Recurring or event wakes, if models turn out to forget to reschedule.
- A spend cap on unattended work, if running it shows one is needed. Note that `pricing.ts` records plan-route turns at $0, so a cap would have to price them at API rates.
- A reviewer for unattended proposals (the OpenAI Dots auto-review, the Meta Muse Sentinel).
- One `theorist` agent per project, replacing `prover`, `research`, `numerics`, `review`, `search` and `leanOrchestrator`.

## Prior art

Always-on agents from September 2026:

- **OpenAI Dots:** read-only while away; acts by proposal.
- **ChatGPT Pulse:** a finite morning brief.
- **Manus 2.0:** fresh-context fan-out; users complain about uncapped credit burn.
- **Meta Muse:** keeps working after the app closes and comes back when something changes or needs approval.

We take the shape they share (it keeps working in the background, and comes back to the researcher) and leave their machinery.
