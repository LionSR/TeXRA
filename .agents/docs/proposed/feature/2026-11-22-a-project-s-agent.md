---
created: 2026-11-22
status: proposed
---

# A project's agent is the one entry agent, kept alive

Baseline: `main` at `8fbc949` (2026-11-22). Paths are relative to the repo
root. The owner's direction of 2026-11-22: carry out what Theia Vogel's two
essays on model harnesses (January and November 2026, vgel.me) describe, give
every project one long-running agent, and find the design that deletes
instead of adding. This note continues
[programs, not agents](../architecture/2026-11-06-programs-not-agents.md) and
[the script is how an agent runs itself](../architecture/2026-11-19-the-script-is-how-an-agent-runs-itself.md).

## The design

The essays ask for a long-lived, individual agent for a body of work. The
programs note already ruled that there is one entry agent and nobody edits
it: the kernel's loop, the app's base text and the plugins that are on. These
are one thing. **A project's agent is that entry agent's one root run, never
ended.** Nothing is added to make it: no persona, no orchestrator, no second
kind of run.

So the work is the programs note's phase 5, which is a deletion, and one
fact beside it:

- **Deleted with phase 5**: the 19 files in
  `packages/extension/resources/agents/` (1,370 lines, `orchestrator.yaml`
  among them), the agent index and the per-project agent choice
  (`packages/harness/src/agent/index/`,
  `packages/harness/src/agent/workspaceAgents/`, 1,858 lines), the agent
  settings page, `texra agents`, the launch form's agent list, the persona on
  a stored chat and the "Available agents" section of the system text.
- **The one fact**: which root run is the project's, a value in the project's
  state. A project's window opens on it; it is created at the first open and
  calls no model before the person's first message. Other conversations stay
  possible; they are forks of it or runs it starts.

An earlier draft of this note proposed rewriting `orchestrator.yaml` into the
agent's persona. That added a file phase 5 deletes.

## What the essays ask for, against `main`

| Point                                                         | TeXRA today                                                                                                                                                                                  | Left                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| The model shapes a group of agents, not the harness           | No flow engine; `agent()`, `program()` and `self()` are a script's functions; an agent writes its own programs (`packages/harness/src/agent/memory/ownPrograms.ts`)                          | fixed roles: phase 5 |
| Agents work through files                                     | Memory is files; the run history is readable as data (`packages/harness/src/tools/ExecutionsTool.ts`)                                                                                        | none                 |
| Forking is the default, at any earlier point                  | `self()` forks, on a model the call names (`packages/harness/src/tools/codemode/SelfTool.ts`); a host forks any run at a finished position (`packages/harness/src/agent/runtime/forkRun.ts`) | step 3               |
| A new agent asks its parent first                             | A child's end is a report, and its parent's reply resumes it; nothing tells a child so                                                                                                       | with phase 5's text  |
| Compaction keeps the newest part and never rewrites a summary | This change, below                                                                                                                                                                           | done                 |
| An agent edits its own context                                | `packages/harness/src/tools/codemode/ContextTool.ts`                                                                                                                                         | step 2               |
| Children live as long as their parents, under a limit         | A child is a run with its own input; its spend cap is on its `run.start` (`packages/harness/src/agent/runtime/spendCap.ts`)                                                                  | none                 |
| An agent arranges its own time                                | `packages/harness/src/tools/WakeTool.ts`                                                                                                                                                     | step 1               |
| A group mixes models                                          | Within one conversation format: another protocol's reasoning evidence is refused (`replayableHistory`, `packages/llm/src/message.ts`)                                                        | step 3               |
| Key-value cache compression, continual learning               | A provider's and a model's                                                                                                                                                                   | not ours             |

## Done with this note: a threshold summary replaces the middle alone

`packages/harness/src/agent/runtime/run/compaction.ts`, `rangeOf`. A summary
at the threshold replaced the view from message 0 to the newest exchange, so
each one summarized the last one's summary and a run that lives for months
would hold a summary many times removed. It now leaves the earlier summaries
in place until together they outgrow the tail, and leaves the newest messages
up to a third of the threshold. A `/compact` and an overflow summarize
everything, as before. No row and no run state changed: a `context.edit`
already names any range, and a slice is measured as its share of the size the
provider last counted, so text far from four characters a token is cut right.

## After phase 5

1. **A wake not yet due holds its project.** The background service releases
   an idle project (`packages/texra/src/controllers/server/serve.ts`) and
   reads no pending wake, so a wake is read late, at the next open.
2. **Tell the run before it is summarized.** The summary call sends neither
   the run's system text nor its tools, so it likely reads the whole view
   uncached, where the run's own `context` edit rides a request that reads it
   cached. Measure one summary call's cached input first; if it reads none, a
   notice below the threshold lets the run write its own, and the summary
   stays for an overflow.
3. **A fork or a switch crosses providers.** Lower another protocol's
   assistant messages to plain content, as `replayableHistory` does inside a
   protocol; a script forks any run it started, of which `self()` is the case
   of the caller.

## Owner questions

- Whether long-lived forks of a project's agent keep notes of their own, or
  the project's one memory tree is right for all of them.
- Whether a long-prompt price step (`longContextPricing`, read only by
  `packages/harness/src/tools/ResourcesTool.ts`) also triggers a summary:
  wording traded for money.

## Verified

- Read at the baseline: the files named above; the programs note's phases
  and its deletion list.
- Ran: `npm run gate`, `npm test`.
- Not checked: whether a summary call reads the prompt cache; whether the
  desktop runs a project in the background service by default.
