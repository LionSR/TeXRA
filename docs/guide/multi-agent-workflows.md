# Multi-agent workflows

<script setup>
import CliMultiAgentHero from '../.vitepress/components/CliMultiAgentHero.vue';
</script>

Some problems are too big for one agent: checking every derivation in a long calculation, attacking a conjecture from several directions at once, or fixing, verifying, and merging a set of files. A multi-agent workflow is how a team lead attacks that kind of problem. Instead of delegating one task at a time and waiting, the lead writes a short script that says which specialists to run, which of them can run in parallel, and how their results feed the next step. TeXRA then runs that script for it: fan-out, joins, and the final synthesis happen in plain code, with no model round-trip between steps, and the run can pick up where it left off if it is interrupted.

The tool behind this is called `delegate_multi_agents`. You never write the script yourself. The orchestrator writes it, you review the plan, and the run shows up like any other delegation, one row per agent.

## When the lead reaches for it

Team leads such as `orchestrator` and `engineer` have three ways to hand work off. `delegate_workflow` and `delegate_agent` run one agent at a time, which is right when the next decision depends on reading the previous result. `delegate_multi_agents` is for the other case: the complete shape of the work is known before anything runs.

Typical shapes:

- **Fan out, then merge.** Fix or audit several files in parallel, then pass the corrected files to one merge step.
- **Pipeline.** Draft, then review, then apply the review, where each stage waits for the previous one.
- **Survey and decide.** Run several specialist analyses that each return a small structured answer, then let the script pick the best one or hand the set to a synthesis agent.

The lead still plans in conversation with you first. It reads the project, proposes an interpretation, and only then writes the script.

## What a run looks like

1. **A proposal you approve.** Before anything runs, the lead's script is shown as a proposal labelled **Multi-agent workflow** with the script's name, its phases, any declared items, the default agent and model, and the files available to the script. Declared items are plan labels from the script, not resolved calls: a script whose calls depend on runtime data declares none, and the card says so instead of counting zero. The defaults are just that — each call may name its own agent and model. The card also carries a cost warning, because calls run concurrently. You can approve, or reject with feedback so the lead adjusts its plan. The script itself is saved under `.texra/workflow-scripts/` in your workspace, so you can open it.
2. **Phases and per-call progress.** The run opens as its own stream. Calls are grouped under the phases the script declared. A declared item appears as a quiet **Declared** row once its phase opens, until the script issues it; from then on the row is a real call and shows what it is — **Document** (a workflow agent editing files) or **Structured** (a tool-use agent returning validated data), the agent and model it runs, and the files it was handed — along with its status: Planned (issued but not yet queued), Queued (waiting for a concurrency slot), Running, Finished, Saved result (replayed from an earlier attempt), Skipped, Cancelled, or Failed. Rows running at the same time are the run's real concurrency; sharing a phase does not by itself mean calls run together or depend on each other. When a call finishes, its row adds the elapsed time and what it cost.
3. **Skip or retry a running call.** In the CLI, focus a running task in the subagent panel and press `s` to skip it or `r` to retry it; `k` kills it. A skipped call is excluded from the synthesis step by the script.
4. **A summary when it finishes.** The lead receives the script's return value, the run log, and a one-line summary: phases run, tasks succeeded out of total, total cost, duration, and every file the run produced with its diff counts. Workflow-agent outputs land in run storage like any other delegated run; the lead reviews them and uses `accept_run_files` to bring them into the workspace.

<CliMultiAgentHero />

<p class="hero-caption">A team session in the CLI. A multi-agent workflow's calls appear in this same subagent panel, grouped by phase, each as a focusable stream with its own transcript.</p>

The run is detached: the lead gets an execution id back immediately and keeps working while the workflow runs. It can check on progress with the `executions` tool, and the result is delivered to it as a follow-up message when the run completes.

## A minimal script

This is the shape of script the lead writes. It fixes two drafts in parallel, then merges the corrected files in a second phase.

```js
export const meta = {
  name: 'fix-drafts',
  description: 'Fix typos in two drafts',
  phases: ['Fix', 'Merge'],
  tasks: [
    { id: 'first', label: 'Fix first draft', phase: 'Fix' },
    { id: 'second', label: 'Fix second draft', phase: 'Fix' },
    { id: 'merge', label: 'Merge corrected drafts', phase: 'Merge' },
  ],
};
phase('Fix');
const results = await parallel(
  files.inputFiles.slice(0, 2).map(
    (file, index) => () =>
      agent('Fix spelling errors only.', {
        id: index === 0 ? 'first' : 'second',
        inputFiles: [file],
      }),
  ),
);
const correctedFiles = results
  .filter((result) => result != null && result !== '__WORKFLOW_SKIPPED__')
  .flatMap((result) => result.outputs.map((output) => output.absolutePath));
phase('Merge');
return await agent('Merge the corrected drafts.', {
  id: 'merge',
  inputFiles: correctedFiles,
});
```

A few things to notice. The `meta` block is the plan: because `tasks` is declared, the proposal and the progress view can show all three tasks before any of them run. `parallel()` runs the two fixes concurrently and waits for both. A failed call resolves to `null` and a call you skipped resolves to `'__WORKFLOW_SKIPPED__'`, so the script filters both out before the merge. Each workflow-agent call resolves to a result that lists the files it produced, and those files can be handed straight to the next call.

## The script API

Scripts run in a sandbox with no imports and no access to the filesystem, network, or clock. Only these primitives exist:

| Primitive                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                     |
| :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export const meta`       | Required first statement. `name` and `description` are required. `phases` lists phase titles, `tasks` is the optional declared plan (`{ id, label, phase? }`), and `timeoutMs` sets the whole-run wall clock (1 second to 60 minutes; default 10 minutes).                                                                                                                                                                       |
| `agent(prompt, options?)` | Runs one specialist and returns a promise. A workflow-agent call takes `inputFiles` (editable), `contextFiles`, and `mediaFiles` (read-only) and resolves to a result listing its output files, diffs, and cost. A call with `schema` (a JSON Schema object) runs a tool-use agent named by `agentName` and resolves to a result whose `.structured` field is the validated object. `model` picks a specific model for the call. |
| `parallel(thunks)`        | Runs an array of zero-argument functions concurrently and waits for all of them. Failed calls resolve to `null`; a thrown script error fails the whole run.                                                                                                                                                                                                                                                                      |
| `phase(title)`            | Marks the start of a phase for progress display. Titles must be declared in `meta.phases`.                                                                                                                                                                                                                                                                                                                                       |
| `log(message)`            | Writes a line to the run log that the lead receives with the result.                                                                                                                                                                                                                                                                                                                                                             |
| `args`                    | The JSON value the lead passed when launching the script, for data-dependent task sets.                                                                                                                                                                                                                                                                                                                                          |
| `files`                   | The files bound to the run, as `files.inputFiles`, `files.contextFiles`, and `files.mediaFiles`.                                                                                                                                                                                                                                                                                                                                 |

Ordinary JavaScript handles the rest: a `for` loop with awaited calls is a pipeline, and array methods such as `.filter()` and `.map()` are how results fan back in. Up to four agent calls run at once across the whole script, a single run makes at most 200 live calls, and `Date.now()` and `Math.random()` are unavailable so that a rerun replays the same call sequence.

## Checkpoints and resume

Every completed `agent()` call is written to a journal before its result is handed back to the script. The journal is keyed by the script's `meta.name` together with the default agent and the lead's session, so resume works within the same session rather than across sessions. Each entry records the call's prompt and options, plus the bytes of any files it read.

If the run times out, is interrupted, or fails partway through, nothing that finished is lost. The lead calls the tool again in the same session with the same `meta.name`, and calls whose prompt, options, and input files are unchanged replay from the journal at no cost, showing as **Saved result** in the progress view. Only the calls that did not finish, or that the lead changed in the script, run again. A new `meta.name` starts over from scratch.

This also means the lead can edit a script after a failure rather than rewriting it. Every result points at the saved script file, and the tool accepts a path to that file instead of new source.

In the CLI, a workflow run resumes headless: `texra resume <id>` continues a stored workflow execution under its original id and honors `--print`, `--output-format`, and `--no-input`. The lead's own session is a tool-use session, so resuming it reopens the interactive chat, where you can ask it to rerun the script. Read [Execution history in the CLI guide](./texra-cli.md#execution-history) for the commands.

## Where it is available

**Agents.** The tool is only offered to agents whose configuration names it. Today that is the `orchestrator` lead (the Physicist, Mathematician, and Computer Scientist teams), `leanOrchestrator` (the Lean Project team), and the `engineer` lead (the Software Engineer team). `orchestrator` and `leanOrchestrator` are [remote agents](./remote-agents.md), so they need a TeXRA sign-in; `engineer` is built in. A [custom agent](./custom-agents.md) can list `delegate_multi_agents` in its tools too.

**The global switch.** Naming the tool is only half of the opt-in. The **Multi-Agent Workflow** switch on the **Tools** tab of the Dashboard is a kill switch on top of it: when it is off, the tool is removed from every agent's tool list, whatever the agent's configuration says. New installs start with it off, so turn it on before asking a lead to use it. From the CLI, the same switch is `texra tools enable workflow-script`.

**Hosts.** The VS Code extension and the desktop app show the proposal, the phase and task progress, and the delivery summary in the ProgressBoard. The CLI shows the same run in the chat TUI's subagent panel, with the skip and retry keys above. In a headless `texra run`, no proposal prompt can be shown, so the workflow proceeds without one; the approval policy you pass still governs what its child agents may edit or execute.

## Troubleshooting

**The lead never offers a multi-agent workflow.** Check the **Multi-Agent Workflow** switch on the Dashboard's **Tools** tab (or `texra tools status workflow-script`). When it is off the tool is stripped from every agent, and the lead falls back to delegating one task at a time. Also confirm the lead is one of the agents listed above.

**"A workflow script run for meta.name ... is already in progress".** The lead tried to launch a script whose previous run is still running or finishing. Only one run per name is allowed at a time, so a second launch is refused rather than starting a competing run over the same journal. Wait for the first run to deliver, then resume with the same name if it did not complete.

**The run stopped with a wall-clock timeout.** The default limit for a whole run is 10 minutes, which a large fan-out on a slow model can exceed. Completed calls are journaled, so ask the lead to rerun the script with the same `meta.name`; it can raise `meta.timeoutMs` in the saved script (up to 60 minutes) for the second attempt.

**"Workflow agent ... edits files: pass options.inputFiles".** A workflow-agent call was made without input files. Workflow agents rewrite documents, so each call needs `inputFiles`, or a previous call's outputs, unless the agent declares default output files. Analysis that returns a value rather than a file belongs in a tool-use call with `schema`.

**A task shows Failed while the rest continue.** That is the intended behavior: a failed `agent()` call resolves to `null` and the script carries on with the calls that succeeded. Open the task's stream to read why it failed. Failed calls are not journaled, so a rerun retries them.

## Next steps

- [Built-in agents](./built-in-agents.md#built-in-teams): the teams whose leads can run workflows
- [TeXRA CLI](./texra-cli.md#multi-agent-teams): running a team from the terminal
- [Workflow agents](./agent-architecture.md): what a single workflow-agent call does
- [Agent integrations](./agent-integrations.md): the Tools tab and approval settings
- [Custom agents](./custom-agents.md): give your own lead agent the tool
