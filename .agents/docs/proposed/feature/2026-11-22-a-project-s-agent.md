---
created: 2026-11-22
status: proposed
---

# PRD: a project's agent

Baseline: `main` at `8fbc949` (2026-11-22). Paths are relative to the repo
root. The owner's direction of 2026-11-22: every project has one long-running
agent, built the way that deletes instead of adding. The reasons for
long-lived agents are Theia Vogel's two essays on model harnesses (January
and November 2026, vgel.me); the last section maps their points to the code.

## Problem

A researcher works on a project for months. TeXRA's unit is a conversation
that lasts an afternoon.

- **Every conversation starts over.** Opening a project opens an empty
  conversation (bare `texra`, `packages/cli/src/commands/chat.ts`, starts a
  new one; continuing one is `texra resume <id>`). What the last one learned
  reaches the next only through notes it chose to write.
- **Nothing comes back by itself for long.** A run can arrange its next turn
  with `wake` (`packages/harness/src/tools/WakeTool.ts`), but the background
  service holds a project only while a run is at work
  (`runsAtWork`, `packages/texra/src/controllers/server/service.ts`). A run
  waiting for its wake is not at work, so the project is released, the
  service exits when idle, and the wake is read late, at the next open.
- **The person chooses among agents before saying anything.** That choice is
  the programs note's subject; this PRD adds nothing to choose.

## Who it is for

One researcher on their own machine, in the desktop app, the extension or the
`texra` CLI. Not a team feature and not a cloud service.

## Goals

1. Opening a project continues the one conversation that knows it.
2. That conversation returns at times it chose, with no window open.
3. It stays useful after months: its view is compacted without losing the
   recent wording, and its whole history stays readable.
4. The harness learns no new word. A project's agent is a root run.

## Non-goals

- A persona, a prompt or a tool list for it. It is whatever the entry is.
- An agent over several projects. That is the
  [orchestrator PRD](./2026-09-26-orchestrator-over-projects.md), which
  waits; see "Other notes".
- Starting at login, a tray icon, recurring schedules, a schedule editor.
- A memory format. Its notes are the project's memory files, as today.
- Windows for the background service, which does not run there today.

## How it looks to the researcher

1. **Monday.** They open the paper's folder for the first time and ask for a
   response plan to the referee report. This conversation is now the
   project's agent; nothing announced it.
2. They close the window. Tuesday they run `texra` in the folder and are in
   the same conversation, at its last message.
3. They ask it to check Thursday morning whether the new numerics finished.
   It arranges a wake and says when.
4. **Thursday 08:00.** No window is open. The service still holds the
   project, the turn runs, and its answer is the last message of the
   conversation. A desktop that is open shows its usual notification.
5. **Three months on** the conversation has been compacted many times. The
   start of its view is a short series of summaries, each written when it
   happened; the last several exchanges are word for word.
6. They want a side question answered without disturbing it: they fork it.
   The fork is an ordinary conversation of the project.
7. The project changes direction. They choose **Start over**. The old
   conversation stays in the history and can be resumed; the next message
   begins the new agent, which reads the same memory files.

## Requirements

### R1. One fact: which run is the project's agent

- A run id in the project's own state (`workspaceState`,
  `packages/harness/src/platform/workspaceRoots.ts`), declared as a row of
  TeXRA's settings catalog. The app owns it; the harness does not read it.
- **It is set by the first message, not by opening.** A project with none
  shows an empty conversation, as today; the run that message starts is
  recorded. So no empty run exists, no start without input is added, and no
  model is called before the person speaks.
- **It is cleared, never repaired.** A recorded run that was deleted, or
  whose records cannot be read, reads as none, with a `warn` naming the run.
  **Start over** clears it on purpose. Clearing deletes nothing.

### R2. Every host opens a project on its agent

- The desktop window, the extension's view and bare `texra` in a project
  folder open the recorded run when there is one. A new conversation is one
  action in each host, and `texra chat --new` in the CLI.
- The run list shows the agent first, marked. No second control starts or
  stops being "the agent": **Start over** is the one action.
- A window with no folder has no project and no agent.

### R3. A wake not yet due holds its project

- The service holds a project while a run of it is at work or holds a wake
  not yet due: one more condition where it reads `runsAtWork`
  (`packages/texra/src/controllers/server/serve.ts`). The pending notes are
  already in the session view (`queuedFollowUps`), so nothing is stored.
- A wake missed while the machine was off is read late at the next open, as
  today.
- With no service reached, a project's tasks run in its window
  (`packages/texra/src/controllers/session/openProjectSession.ts`), and a
  wake fires only while that window is open. The window's existing notice
  about tasks running locally covers it.

### R4. A turn nobody asked for is visible and bounded

- A turn a wake started shows the note that started it, as the message it
  answers.
- `wake` already bounds turns: one a minute for each wake, twenty pending.
  Money is not bounded: see the owner question.

### R5. The view lasts

Done with this PRD's first change: a summary at the compaction threshold
replaces the middle of the view alone
(`packages/harness/src/agent/runtime/run/compaction.ts`, `rangeOf`). Earlier
summaries stay as written until together they outgrow the tail; the newest
messages stay up to a third of the threshold. No row and no run state
changed.

## What stays as it is

- **The run.** Its history, approvals, resume, deletion and fork
  (`packages/harness/src/agent/runtime/forkRun.ts`) are any root run's.
- **Children.** What it starts are runs under it, each with the spend cap of
  its `run.start` (`packages/harness/src/agent/runtime/spendCap.ts`).
- **Model.** Switching within one conversation format works in place
  (`packages/harness/src/agent/runtime/loop/modelSwitch.ts`). Moving to
  another provider is **Start over** until "After" step 2.
- **Memory.** One tree for the project. A fork reads and writes the same
  files.

## Other notes

- **[Programs, not agents](../architecture/2026-11-06-programs-not-agents.md),
  phase 5.** Independent, in either order. Today the agent's run starts on
  the default persona; phase 5 deletes the 19 persona files, the agent index
  and the per-project agent choice, and the run is then the one entry with
  nothing chosen. This PRD adds no persona for phase 5 to delete.
- **[The script is how an agent runs itself](../architecture/2026-11-19-the-script-is-how-an-agent-runs-itself.md),
  section 4**, says an event starts one short run, not a resident loop. Both
  hold. A registered trigger starts a program for work that needs none of a
  conversation. A wake continues one run, and nothing runs between its
  turns: what stays up is the process that holds the timer.
- **The orchestrator PRD.** With a project's agent, its R1 shrinks to one
  thing that crosses stores, a message to a project's agent. Its R3 (`wake`)
  is built. It still waits.

## Order

1. R5 (done).
2. R1 and R2, in the app and the three hosts.
3. R3, in the service.
4. R4's display, where a host does not already show the note.

## After

1. **Tell the run before it is summarized.** A summary call sends neither the
   run's system text nor its tools, so it likely reads the whole view
   uncached, where the run's own `context` edit rides a request that reads
   it cached. Measure one summary call's cached input first.
2. **A fork or a switch crosses providers.** Lower another protocol's
   assistant messages to plain content, as `replayableHistory` does inside a
   protocol (`packages/llm/src/message.ts`).
3. **A child is told it may ask.** With phase 5's base text, checked against
   a live model.

## Owner questions

1. **Money for turns nobody asked for.** Recommended: no new limit at first.
   The turn is visible, the run can be stopped, and children are capped. A
   limit by day would be a new setting; decide it from a month of use.
2. **Does a project's window open on its agent, or on a new conversation?**
   Recommended: on its agent (R2). The other choice keeps today's opening
   and makes the agent one click away, which keeps the habit this PRD is
   meant to end.
3. **Do long-lived forks keep notes of their own?** Recommended: no. One
   tree, and a fork that needs its own writes under a folder it names.

## The essays' points

| Point                                                         | TeXRA today                                                                                                                 | Here     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| Agents are long-lived and individual                          | A run that never ends already works; none is a project's own                                                                | R1, R2   |
| An agent arranges its own time                                | `wake`, read late once the service lets go                                                                                  | R3       |
| Compaction keeps the newest part and never rewrites a summary | It summarized from message 0 each time                                                                                      | R5       |
| An agent edits its own context                                | `packages/harness/src/tools/codemode/ContextTool.ts`                                                                        | After 1  |
| Forking is the default, at any earlier point                  | `self()` forks (`packages/harness/src/tools/codemode/SelfTool.ts`); a host forks any run at a finished position             | none     |
| Children live as long as their parents, under a limit         | A child is a run with its own input and its own cap                                                                         | none     |
| The model shapes a group of agents, not the harness           | Scripts, and programs an agent writes (`packages/harness/src/agent/memory/ownPrograms.ts`); the fixed roles go with phase 5 | phase 5  |
| A new agent asks its parent first                             | A child's end is a report its parent's reply resumes; nothing tells it so                                                   | After 3  |
| A group mixes models                                          | Within one conversation format                                                                                              | After 2  |
| Key-value cache compression, continual learning               | A provider's and a model's                                                                                                  | not ours |

## Verified

- Read at the baseline: the files named above; the programs note's phases.
- Ran for R5: `npm run gate`, `npm test`.
- Not checked: how each host shows a note a run wrote to itself (R4);
  whether a summary call reads the prompt cache (After 1); the extension's
  opening path, which was read only through the shared window body.
