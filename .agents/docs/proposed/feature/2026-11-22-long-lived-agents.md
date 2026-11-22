---
created: 2026-11-22
status: proposed
---

# Long-lived agents: what the two harness essays ask for, and where TeXRA stands

Baseline: `main` at `cc1d863` (2026-11-22). Paths are relative to the repo
root. The owner's direction of 2026-11-22: every point of Theia Vogel's two
essays on model harnesses (January and November 2026, vgel.me) is to be
carried out in TeXRA, and the app has one long-running agent for each
project. This note maps each point to the code, says what the first change
did, and orders the rest. It continues
[the script is how an agent runs itself](../architecture/2026-11-19-the-script-is-how-an-agent-runs-itself.md)
and reopens part of the parked
[orchestrator over projects](./2026-09-26-orchestrator-over-projects.md).

## The essays' points

| Point                                                                | TeXRA                                                                                                                                                                                                    | Work           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| The structure of a group of agents is the model's, not the harness's | No flow engine; `agent()`, `program()` and `self()` are functions of a script; an agent writes its own programs (`packages/harness/src/agent/memory/ownPrograms.ts`)                                     | none           |
| Agents coordinate through files                                      | Memory is files under `/memories`; the conversation is readable as data (`executions`, `packages/harness/src/tools/ExecutionsTool.ts`)                                                                   | none           |
| Forking is the default way to delegate                               | `self()` forks unless told otherwise (`packages/harness/src/tools/codemode/SelfTool.ts`); a host forks any run at any finished position (`packages/harness/src/agent/runtime/forkRun.ts`)                | step 4         |
| A new agent asks its parent before it starts                         | A child can message its parent (`packages/harness/src/tools/executions/send.ts`), and ending with a question is a report its parent's reply resumes; no prompt tells it to                               | step 5         |
| Onboard one agent, then fork it for each task                        | A script can fork only the run that runs it                                                                                                                                                              | step 4         |
| Todo lists and plan modes give way to files                          | The `plan` tool is an approval gate and the way into a goal, not a list (`packages/harness/src/tools/plan/PlanTool.ts`)                                                                                  | none           |
| Agents are long-lived and named                                      | A run that never ends already works: resume is the same function over its rows, and `wake` lets it arrange its own next turn (`packages/harness/src/tools/WakeTool.ts`). No run is a project's own agent | step 2         |
| Compaction keeps the newest part as written, and memory rolls        | Done for the threshold summary; see below                                                                                                                                                                | done           |
| The agent writes its own memory as it goes, before it is summarized  | It can (`packages/harness/src/tools/codemode/ContextTool.ts`), but nothing tells it the view is filling                                                                                                  | step 1         |
| An agent clears old tool results itself                              | `context replace`                                                                                                                                                                                        | none           |
| Children live as long as their parents, as peers                     | Every child is a run with its own input; a later message to it is a resume. A child nobody waits for can take no spend cap                                                                               | step 3         |
| A finished fork's memory flows back to its parent                    | Its report does, as a message on its parent's input. Memory files are shared by the project                                                                                                              | step 6, decide |
| Lineages differ from each other                                      | One memory tree for a project (`packages/harness/src/agent/memory/memoryLayout.ts`), so every long-lived run of it reads the same pinned notes                                                           | step 6, decide |
| A group mixes models                                                 | `agent()` and `program()` take a model; `self()` does not; another protocol's reasoning evidence is refused (`packages/llm/src/message.ts`, `replayableHistory`)                                         | step 4         |
| Compression of the key-value cache                                   | A provider's feature. A harness has no part in it                                                                                                                                                        | not ours       |
| Continual learning                                                   | A model's feature                                                                                                                                                                                        | not ours       |
| Instruction files are going away                                     | An observation about habit, not a mechanism. `AGENTS.md` stays the one instructions file (`packages/harness/src/agent/prompt/agentsMd.ts`) unless the owner says otherwise                               | decide         |

## Done: a threshold summary keeps earlier summaries and a tail

`packages/harness/src/agent/runtime/run/compaction.ts`. A summary at the
threshold replaced the view from message 0 up to the newest exchange, so each
one summarized the last one's summary. It now replaces the middle alone
(`rangeOf`): the summaries at the start stay until together they outgrow the
tail, and the newest messages stay up to a third of the threshold. A
`/compact` and an overflow still summarize everything. No stored row changed.

The cut is in tokens, so the estimate is corrected by the run's own counts
(`tokenRate`, `packages/harness/src/shared/runs/contextUtilization.ts`): the
last response's provider-counted input over the estimate of what that request
held. Text that is not English prose was several times off at four characters
a token, and after an edit the size left out the system text and the tool
declarations.

## The rest, in order

1. **Tell the run before it is summarized, and choose by the cache.** An
   edit costs what follows it at the cache-write price. A summary call does
   not send the run's system text or tools, so it likely reads the whole view
   uncached, while the agent's own `replace` rides a request that reads it
   cached. When the cache is warm, queue a notice at a mark below the
   threshold and let the run edit; when the last response is older than the
   route's cache lifetime (`packages/llm/src/api/configuration.ts` sets
   Anthropic's to five minutes), summarize at that mark. Measure one summary
   call's cached input first: the rule rests on it.
2. **A project's own agent.** One root run a project names as its agent, kept
   in the project's state and opened by default; created at the first open,
   with no model call before the person's first message. The persona is
   `packages/extension/resources/agents/orchestrator.yaml` rewritten short,
   with `wake`, `memory` and `context`. A wake not yet due holds the project
   in the background service (`packages/texra/src/controllers/server/serve.ts`
   releases an idle project today and knows nothing of a pending wake). The
   cross-project orchestrator then needs one thing that crosses stores: a
   message to a project's agent.
3. **A spend cap on the run.** Section 1 of
   [an agent running itself](../simplification/2026-11-20-self-operation-left-open.md).
   A run that wakes itself needs one before step 2 is on by default.
4. **Fork any run you started, on any model.** `self()` is the case where the
   run forked is the caller. Lowering another protocol's assistant messages to
   plain content, as `replayableHistory` does within a protocol, lets a fork
   or a switch cross providers at any point and not only after a summary.
5. **A child asks before it starts.** The subagent prompt says to end with
   its questions when the task is underspecified.
6. **Memory by lineage, and what a fork gives back.** Needs the owner's word:
   whether a long-lived fork keeps notes of its own, and whether a finished
   fork's notes are merged or its report is enough.
7. **A long-prompt price step as a second trigger.** `longContextPricing` is
   read only by `packages/harness/src/tools/ResourcesTool.ts`. Compacting at
   the step trades wording for money, so it is the owner's choice.

## Owner questions

- The tail is a third of the threshold and the notice mark of step 1 is
  proposed at 60% of the window. Both are first guesses.
- Step 2: rewrite `orchestrator` or add a persona, and whether a project's
  window opens on its agent or on a new conversation.
- Step 3: whether a cap survives a person resuming the run.
- Steps 6 and 7, and whether `AGENTS.md` loading changes at all.

## Verified

- Read: the files named above, at the baseline.
- Ran for the first change: `npm run gate`, `npm test` (262 files).
- Not checked: whether a summary call reads the prompt cache; whether the
  desktop runs a project in the background service by default; Google
  Interactions' cache lifetime.
