# Multi-agent workflows

<script setup>
import CliTeamHero from '../.vitepress/components/CliTeamHero.vue';
</script>

Certain research challenges exceed what a single agent can do in one pass: systematically verifying every derivation in an extensive calculation, probing a conjecture from multiple complementary angles, or auditing, correcting, and reconciling a multi-file manuscript. A team lead such as `orchestrator` handles these by calling specialist agents, reading what they return, and deciding what runs next. When the whole shape of the work is known up front, the lead can instead write a short script that calls the specialists in code, runs independent ones concurrently, and combines their results. TeXRA records every call the script makes, so an interrupted script resumes without running finished work again.

Two tools do this. `agent` runs one named agent as a child of the lead's run. `script` runs a short JavaScript program that can call `agent` many times. You never write either yourself: the lead writes the calls, you approve them, and the children show up in the progress view like any other delegation.

## When the lead reaches for a script

Most coordination is the lead calling `agent` directly. It launches the independent calls in one turn, keeps working while they run, reads each result when it arrives as a follow-up, and routes the next step itself. The children do not talk to each other; everything passes through the lead. This is right whenever the next decision depends on reading the previous result.

A script is for the other case: the complete fan-out and join are known before anything runs. Typical shapes:

- **Fan out, then merge.** Fix or audit several files in parallel, then pass the corrected files to one merge step.
- **Pipeline per item.** For each section: find its claims, then verify each claim, where each section moves through its steps on its own.
- **Survey and decide.** Run several specialist analyses that each return a small structured answer, then let the script pick the best one or hand the set to a synthesis agent.

The lead still plans in conversation with you first. It reads the project, proposes an interpretation, and only then writes the script. For larger work it runs several scripts in sequence, reading each result before writing the next, and keeps any decision that is yours out of the scripts.

## The `agent` tool

`agent` takes a `prompt` and an `agentName`; the named agent decides what kind of call it is. A workflow agent rewrites the files passed as `inputFiles` (with optional `contextFiles`, `mediaFiles`, and `outputFiles`), one revised document each. A tool-use agent works with its own tools and returns its final reply, or a validated value when the call passes a `schema`. Every call may set `model` (with an `@effort` suffix such as `@high`), `memories`, a `label` for its card, and `timeoutMs`.

Called directly, the child runs in the background and its result reaches the lead as a follow-up message; each direct call asks for your approval on its own. In a one-shot run, such as `texra run`, the call waits for the child instead.

## The `script` tool

A script is the body of an async JavaScript function. It calls tools with `await`, runs calls together with `Promise.all`, and recovers from failures with `try`/`catch`:

```js
phase('Fix');
const fixed = await Promise.allSettled(
  ['drafts/a.tex', 'drafts/b.tex'].map((file) =>
    agent('Fix spelling errors only.', {
      agentName: 'correct',
      inputFiles: [file],
      label: `Fix: ${file}`,
    }),
  ),
);
const correctedFiles = fixed
  .filter((result) => result.status === 'fulfilled')
  .flatMap((result) =>
    result.value.outputs.map((output) => output.absolutePath),
  );
phase('Merge');
return agent('Merge the corrected drafts.', {
  agentName: 'merge',
  inputFiles: correctedFiles,
});
```

This fixes two drafts in parallel, then merges the corrected files. `Promise.allSettled` keeps the fixes that succeeded, so a failed or skipped fix is left out of the merge rather than stopping the script. Each workflow-agent call resolves to a result that lists the files it produced, and each output's `absolutePath` can be handed straight to the next call.

What a script can use:

| Name                          | What it does                                                                                                                                                                                                                                                                                                              |
| :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent(prompt, options)`      | Runs one agent and waits for it. Resolves to `{ category, response \| outputs, structured?, outcome, cost }`: `outputs` for a workflow agent, `response` (and `structured` with a `schema`) for a tool-use agent. Takes the same options as the `agent` tool. With `background: true` it resolves to `{ runId }` at once. |
| `tools.<name>(args)`          | Calls any other tool the lead has, with the same arguments as a direct call, and resolves to `{ output, summary }`.                                                                                                                                                                                                       |
| `phase(title)`                | Groups the calls that follow under a title in the progress view.                                                                                                                                                                                                                                                          |
| `console.log(...)`            | Writes a line to the script's card; the last 80 lines return to the lead with the result.                                                                                                                                                                                                                                 |
| `searchTools`, `describeTool` | Find a tool by keyword and read its full declaration.                                                                                                                                                                                                                                                                     |

The inputs are literals in the code: a script has no arguments, no bound files, and no saved script file. Its `return` value comes back to the lead as JSON.

A failed call rejects with an error named `AgentFailed`; a call you stopped rejects with `Skipped`, one past its `timeoutMs` with `TimedOut`, and one whose model is not available with `ModelUnavailable`. `try`/`catch` works as usual, and an uncaught error ends the script. `Promise.all` rejects at the first failure without stopping the calls beside it, so a script that should keep going past failures catches inside each branch or uses `Promise.allSettled`. Two calls in one script with the same prompt, options, and files must carry distinct `id`s.

The lead reads the bundled `multi-agent-orchestration` skill for how to shape the work: per-item branches instead of stage-by-stage barriers, adversarial verification, referee panels, and sweeps that run until nothing new turns up.

## What a run looks like

1. **One approval for the script.** Before anything runs, the script is shown as a request with its title and full source. Approving it covers every `agent` call the script makes. **Approve** (`y`) runs it; the ▾ next to it offers **Approve all agent work in this run** (`a`), which also stops asking about later tasks, file edits, and commands in the run. **Reject** (`n`) declines in one click, and **Add a note…** lets you tell the lead what to change.
2. **Calls grouped by phase.** The script's card holds one card per call, grouped by the `phase()` that was current when the call was made. Each shows the agent and model, the files it was handed, and its status: running, finished, reused (an identical call already finished, so nothing ran again), skipped, or failed. A finished call adds its elapsed time and cost. When a child is waiting on you, such as a file edit to approve, **Review** takes you to it.
3. **Open a child run.** A call's card opens the child run it launched, with its own transcript.
4. **Skip a call.** Stopping a child run skips its call: the call rejects with `Skipped` in the script, which then carries on or stops depending on how it handles failures. A skipped call is not retried for you; ask the lead if you want it redone.
5. **A result when it finishes.** The lead receives the script's return value and its last log lines. Workflow-agent outputs land in run storage like any other delegated run; the lead reviews them and uses `accept_run_files` to bring them into the workspace.

<CliTeamHero />

<p class="hero-caption">A team session in the CLI. The calls a script makes appear in this same subagent panel, each as a focusable stream with its own transcript.</p>

## Background scripts

A script normally runs as one of the lead's tool calls, and the lead waits for it. With `run_in_background: true` the script becomes its own background run: the lead gets the run's id back at once and keeps working, and the result arrives as one follow-up with a summary line: calls that succeeded out of the total, cost, duration, and the files produced with their diff counts. The lead can check on it with the `executions` tool, and stopping that run stops the script and its children. In a one-shot run the script always runs in the foreground.

## Resume

Every call a script makes is recorded in the run's ledger as it settles. If the app restarts or the run is interrupted, the script runs again from the top against those records: calls that finished are handed back from the ledger and are not run or billed again, and only unfinished calls run.

A completed `agent` call is also reused by a later identical call in the same run, matched on its prompt, options, and the contents of its files. So when a script fails partway through, on a bug or a timeout, the lead fixes the code and sends it again: everything that already finished comes back as **Reused** at no cost. Editing one of a call's files makes that call run again.

In the CLI, `texra resume <id>` continues a stopped run, a background script run included, and honors `--print`, `--output-format`, and `--no-input`. Read [Execution history in the CLI guide](./texra-cli.md#execution-history) for the commands.

## Limits

- A script launches at most 1000 agents. Reused calls do not count.
- The session's child-run budget sets how many agents run at once.
- The script's own code gets 30 seconds of CPU and 64 MB of memory. Time spent waiting on agents does not count, so this only stops a loop that never waits.
- The wall clock defaults to 60 minutes and can be set from 1 second to 24 hours with `timeoutMs`.
- There are no timers, no `Date.now()`, no `Math.random()`, and no imports, so a resumed script makes the same calls in the same order.

## Where it is available

**Agents.** A tool is only offered to agents whose configuration names it. The `orchestrator` lead (the Physicist, Mathematician, and Computer Scientist teams), `leanOrchestrator` (the Lean Project team), and the `engineer` lead (the Software Engineer team) name both `agent` and `script`; `assistant` names both too, and `creator` and `setup` name `agent`. A [custom agent](./custom-agents.md) can list them in its tools.

**The global switch.** The **Multi-Agent Workflow** switch on the **Tools** tab of Settings gates `agent`: when it is off, `agent` is removed from every agent's tool list, whatever the agent's configuration says, and a script cannot launch agents. It is on by default; from the CLI, the same switch is `texra tools enable multi-agent` or `texra tools disable multi-agent`.

**Hosts.** The VS Code extension, the desktop app, and the CLI show the script request, the calls grouped by phase, and the result. In a headless `texra run`, no approval prompt can be shown, so the approval policy you pass decides the script request and what its child agents may edit or execute.

## Troubleshooting

**The lead never delegates.** Check the **Multi-Agent Workflow** switch on the Settings **Tools** tab (or `texra tools status multi-agent`). When it is off, `agent` is stripped from every agent. Also confirm the lead is one of the agents listed above.

**The script stopped with a wall-clock timeout.** The default limit is 60 minutes, which a large fan-out on a slow model can exceed. Ask the lead to send the script again with a larger `timeoutMs` (up to 24 hours), or with `run_in_background: true`; the calls that finished are reused.

**"used its 30000ms guest CPU budget".** The script's own code, not an agent, ran for 30 seconds in total. That almost always means a loop that never waits on a call. Ask the lead to fix the loop and send the script again.

**"... is a workflow agent: pass the files it rewrites as `inputFiles`".** A workflow agent was called without input files. Workflow agents rewrite documents, so each call needs `inputFiles`. Analysis that returns a value rather than a file belongs in a tool-use call with `schema`.

**"Another agent call of this script has the same prompt, options and files".** Two calls in one script would do exactly the same work, which usually means a retry loop or a panel of identical voters. The lead gives each call its own `id`, or better, each voter its own angle.

**A call shows Failed and the script went on.** The script caught the failure. Open the failed call's child run to read why it failed, and ask the lead to retry it if needed; a failed call is not reused, so sending the script again retries it.

## Next steps

- [Built-in agents](./built-in-agents.md#built-in-teams): the teams whose leads run scripts
- [TeXRA CLI](./texra-cli.md#teams): running a team from the terminal
- [Workflow agents](./agent-architecture.md): what a single workflow-agent call does
- [Agent integrations](./agent-integrations.md): the Plugins page and approval settings
- [Custom agents](./custom-agents.md): give your own lead agent these tools
