# Multi-agent workflows

<script setup>
import CliSubagentsHero from '../.vitepress/components/CliSubagentsHero.vue';
</script>

When a task is too large for a single agent pass—checking every derivation in a long calculation, testing a conjecture from several angles, or auditing and reconciling a multi-file paper—a lead agent such as `orchestrator` delegates the pieces to specialist agents.

Normally the lead calls specialists one turn at a time, reads what comes back, and decides what to run next. When the full fan-out and join are known up front, the lead can instead write a short JavaScript script that runs independent specialists in parallel and combines their outputs. TeXRA records every call the script makes, so an interrupted script resumes without repeating finished work.

Three tools drive delegation:

- `agent` runs a named agent with a prompt as a child of the lead's run.
- `program` starts one of the [programs](./built-in-agents.md#programs) TeXRA ships (`edit`, `annotate`, `enhance`, `apply`, `merge`, `transcribe`, `slides`, `poster`) over files, as a child run.
- `script` runs a short JavaScript program that can call `agent` and `program` many times.

You do not write these calls yourself: the lead proposes them, you approve them, and the child runs appear in the progress view like any other delegation.

## When the lead reaches for a script

Most coordination is the lead calling `agent` or `program` directly. It launches the independent calls in one turn, keeps working while they run, reads each result when it arrives as a follow-up, and routes the next step itself. The children do not talk to each other; everything passes through the lead. This is right whenever the next decision depends on reading the previous result.

A script is for the other case: the complete fan-out and join are known before anything runs. Typical shapes:

- **Fan out, then merge.** Fix or audit several files in parallel, then pass the corrected files to one joining step.
- **Pipeline per item.** For each section: find its claims, then verify each claim, where each section moves through its steps on its own.
- **Survey and decide.** Run several specialist analyses that each return a small structured answer, then let the script pick the best one or hand the set to a synthesis agent.

The lead still plans in conversation with you first. It reads the project, proposes an interpretation, and only then writes the script. For larger work it runs several scripts in sequence, reading each result before writing the next, and keeps any decision that is yours out of the scripts.

## The `agent` and `program` tools

`agent` takes a `prompt` and an `agentName`. The agent works with its own tools and returns its final reply, or a validated value when the call passes a `schema`. `program` takes the program's `name` and the files passed as `inputFiles` (with optional `contextFiles`, `mediaFiles`, and `outputFiles`), and runs the program over them: one revised document each, in the revisions the program defines. Its optional `prompt` is the instruction: what to change, from which point of view, and what to keep. `args` holds the program's own switches, all booleans: `reflect` has a critic review each revision but the last, and `attachTeXCount`, `autoExtractFigure`, `autoExtractTikzFigure` and `autoCompileInputPdf` add context to the prompt. Every call of either tool may set `model` (with an `@effort` suffix such as `@high`), `memories`, a `label` for its card, and `timeoutMs`.

Called directly, the child runs in the background and its result reaches the lead as a follow-up message; each direct call asks for your approval on its own. In a one-shot run, such as `texra run`, the call waits for the child instead.

## The `script` tool

A script is the body of an async JavaScript function. It calls tools with `await`, runs calls together with `Promise.all`, and recovers from failures with `try`/`catch`:

```js
section('Fix');
const fixed = await Promise.allSettled(
  ['drafts/a.tex', 'drafts/b.tex'].map((file) =>
    program('edit', {
      prompt: 'Fix spelling errors only.',
      inputFiles: [file],
      label: `Fix: ${file}`,
    }),
  ),
);
// The last copy each fix wrote of each file.
const corrected = new Map();
for (const result of fixed) {
  if (result.status !== 'fulfilled') continue;
  for (const change of result.value.changes) {
    corrected.set(change.path, change.absolutePath);
  }
}
section('Review');
return program('annotate', {
  prompt:
    'Read the two drafts together and mark where they contradict each other.',
  inputFiles: [...corrected.values()],
});
```

This fixes two drafts in parallel, then reviews the corrected files together. `Promise.allSettled` keeps the fixes that succeeded, so a failed or skipped fix is left out of the review rather than stopping the script. Each `program` call resolves to a result whose `changes` list the files it wrote, one entry per revision, and the last `absolutePath` for a `path` can be handed straight to the next call.

What a script can use:

| Name                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| :---------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, options)`      | Runs one agent and waits for it. Resolves to `{ response, files, structured?, runId, outcome, cost, spent }` (`structured` with a `schema`): `cost` is what that agent and the agents under it spent, `spent` what the script's run has spent in all so far. Takes the same options as the `agent` tool. With `persona: { prompt, tools }` it runs an agent the script defines, named by `agentName`, with only the tools the lead has. With `background: true` it resolves to `{ runId }` at once. |
| `program(name, options)`      | Starts a program and waits for it; `program('edit', { prompt, inputFiles })` edits those files as the prompt asks. Resolves to `{ response, files, changes, runId, outcome, cost, spent }`: `changes` lists every revision's files in order, each with `path` (the workspace file) and `absolutePath` (the revised copy). Takes the same options as the `program` tool, with `args` for the program's own switches. With `background: true` it resolves to `{ runId }` at once.                     |
| `self(prompt, options)`       | Runs this agent again and waits for it: forked from the conversation as it stood when the script started, or from `prompt` alone with `fork: false`. Resolves as `agent()` does; `schema` and `label` work as for `agent()`.                                                                                                                                                                                                                                                                        |
| `tools.<name>(args)`          | Calls any other tool the lead has, with the same arguments as a direct call, and resolves to `{ output, summary }`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `section(title)`              | Groups the calls that follow under a title in the progress view.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `console.log(...)`            | Writes a line to the script's card; the last 80 lines return to the lead with the result.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `searchTools`, `describeTool` | Find a tool by keyword and read its full declaration. `describeTool('edit')` returns a program's source.                                                                                                                                                                                                                                                                                                                                                                                            |

The inputs are literals in the code: a script has no arguments, no bound files, and no saved script file. Its `return` value comes back to the lead as JSON.

A script can import the modules TeXRA lists in the `script` tool's description with `await import(…)`; a relative path is refused. `builtIn:revise` exports the building blocks the programs are written with. To chain programs, pass the last `absolutePath` of each `path` in one result's `changes` as the next call's `inputFiles`. A resumed script loads the modules it first ran with, even if TeXRA has been updated since.

A failed call rejects with an error named `AgentFailed`; a call you stopped rejects with `Skipped`, one past its `timeoutMs` with `TimedOut`, and one whose model is not available with `ModelUnavailable`. `try`/`catch` works as usual, and an uncaught error ends the script. `Promise.all` rejects at the first failure without stopping the calls beside it, so a script that should keep going past failures catches inside each branch or uses `Promise.allSettled`. Two calls in one script with the same prompt, options, and files must carry distinct `id`s.

A [goal](./configuration.md#goal-mode) is itself a script: a loop of `self()` calls, each with a `schema` for `{ status, report }`, that returns when a round reports `done` or `needs_user`, or when its rounds reach the spend cap. A script that needs another stopping rule writes the same loop with a check of its own.

The lead reads the bundled `multi-agent-orchestration` skill for how to shape the work: per-item branches instead of stage-by-stage barriers, adversarial verification, referee panels, and sweeps that run until nothing new turns up.

## What a run looks like

1. **One approval for the script.** Before anything runs, the script is shown as a request with its title and full source. Approving it covers every `agent` and `program` call the script makes. **Approve** (`y`) runs it; the ▾ next to it offers **Approve all agent work in this task** (`a`), which also stops asking about later agent work, file edits, and shell commands in the task. **Reject** (`n`) declines in one click, and **Add a note…** lets you tell the lead what to change.
2. **Calls grouped by section.** The script's card holds one card per call, grouped by the `section()` that was current when the call was made. Each shows the agent and model, the files it was handed, and its status: running, finished, reused (an identical call already finished, so nothing ran again), skipped, or failed. A finished call adds its elapsed time and cost. When a child is waiting on you, such as a file edit to approve, **Review** takes you to it.
3. **Open a child run.** A call's card opens the child run it launched, with its own transcript.
4. **Skip a call.** Stopping a child run skips its call: the call rejects with `Skipped` in the script, which then carries on or stops depending on how it handles failures. A skipped call is not retried for you; ask the lead if you want it redone.
5. **A result when it finishes.** The lead receives the script's return value and its last log lines. A program's outputs land in run storage like any other delegated run; the lead reviews them and uses `accept_run_files` to bring them into the workspace.

<CliSubagentsHero />

<p class="hero-caption">A lead agent's chat in the CLI. The calls a script makes appear in this same subagent panel, each as a focusable stream with its own transcript.</p>

## Background scripts

A script normally runs as one of the lead's tool calls, and the lead waits for it. With `run_in_background: true` the script becomes its own background run: the lead gets the run's id back at once and keeps working, and the result arrives as one follow-up with a summary line: calls that succeeded out of the total, cost, duration, and the files produced with their diff counts. The lead can check on it with the `executions` tool, and stopping that run stops the script and its children. In a one-shot run the script always runs in the foreground.

## Resume

Every call a script makes is recorded in the run's history as it finishes. If the app restarts or the run is interrupted, the script runs again from the top against those records: calls that finished are handed back from the run history and are not run or billed again, and only unfinished calls run.

A completed `agent` or `program` call is also reused by a later identical call in the same run, matched on its prompt, options, and the contents of its files. So when a script fails partway through, on a bug or a timeout, the lead fixes the code and sends it again: everything that already finished comes back as **Reused** at no cost. Editing one of a call's files makes that call run again.

In the CLI, `texra resume <id>` continues a stopped run, a background script run included, and honors `--print`, `--output-format`, and `--no-input`. Read [Execution history in the CLI guide](./texra-cli.md#execution-history) for the commands.

## Limits

- A script launches at most 1000 agents, its `agent()` and `self()` calls together. Reused calls do not count.
- The session's child-run budget sets how many agents run at once.
- The script's own code gets 30 seconds of CPU and 64 MB of memory. Time spent waiting on agents does not count, so this only stops a loop that never waits.
- The wall clock defaults to 60 minutes and can be set from 1 second to 24 hours with `timeoutMs`.
- There are no timers, no `Date.now()`, no `Math.random()`, and no imports beyond the modules TeXRA provides (such as `builtIn:goal`), so a resumed script makes the same calls in the same order.

## Where it is available

**Agents.** A tool is only offered to agents whose configuration names it. The three [lead agents](./built-in-agents.md#lead-agents), `orchestrator`, `leanOrchestrator` and `engineer`, name `agent`, `program` and `script`; `assistant` names all three too, `setup` names `agent` and `program`, and `creator` names `agent`. A [custom agent](./custom-agents.md) can list them in its tools.

**The global switch.** The **Multi-Agent Workflow** switch on **Settings → Plugins** gates `agent` and `program` together: when it is off, both are removed from every agent's tool list, whatever the agent's configuration says. It is on by default; in the terminal client, the same switch is the **Multi-Agent Workflow** row in `/plugins`.

**Hosts.** The VS Code extension, the desktop app, and the CLI show the script request, the calls grouped by section, and the result. In a headless `texra run`, no approval prompt can be shown, so the approval policy you pass decides the script request and what its child agents may edit or execute.

## Troubleshooting

**The lead never delegates.** Check the **Multi-Agent Workflow** switch on **Settings → Plugins** (or its row in the terminal client's `/plugins`). When it is off, `agent` and `program` are stripped from every agent. Also confirm the lead is one of the agents listed above.

**The script stopped with a wall-clock timeout.** The default limit is 60 minutes, which a large fan-out on a slow model can exceed. Ask the lead to send the script again with a larger `timeoutMs` (up to 24 hours), or with `run_in_background: true`; the calls that finished are reused.

**"The script used its 30000ms CPU budget".** The script's own code, not an agent, ran for 30 seconds in total. That almost always means a loop that never waits on a call. Ask the lead to fix the loop and send the script again.

**"Another agent call of this script has the same prompt, options and files".** Two calls in one script would do exactly the same work, which usually means a retry loop or a panel of identical voters. The lead gives each call its own `id`, or better, each voter its own angle.

**A call shows Failed and the script went on.** The script caught the failure. Open the failed call's child run to read why it failed, and ask the lead to retry it if needed; a failed call is not reused, so sending the script again retries it.

## Next steps

- [Built-in agents](./built-in-agents.md#lead-agents): the lead agents that run scripts
- [TeXRA CLI](./texra-cli.md#lead-agents): running a lead agent from the terminal
- [Programs: how they work](./agent-architecture.md): what a single `program` call does
- [Agent integrations](./agent-integrations.md): the Plugins page and approval settings
- [Custom agents](./custom-agents.md): give your own lead agent these tools
