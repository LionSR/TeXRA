# Multi-agent workflows

<script setup>
import CliSubagentsHero from '../.vitepress/components/CliSubagentsHero.vue';
</script>

When a task is too large for one pass (checking every derivation in a long
calculation, testing a conjecture from several angles, auditing a multi-file
paper), the assistant splits it. It hands each piece to a helper agent that it
sets up for that piece, with instructions written for the job and only the
tools the job needs, or it starts one of the [programs](./programs.md). It
reads what comes back before relying on it.

You do not write any of this yourself: ask for the work, approve what the
assistant proposes, and follow the helpers in the Tasks view, where each one
is a child run with its own transcript.

## One at a time, or a script

Most of the time the assistant starts helpers or programs one turn at a time:
it launches the independent ones together, keeps working while they run,
reads each result as it arrives, and decides the next step. The helpers do not
talk to each other; everything passes through the assistant. This is right
whenever the next decision depends on the previous result.

When the whole fan-out and join are known before anything runs, the
assistant writes a short JavaScript script instead, which runs the pieces in
parallel and combines the results. Typical shapes:

- **Fan out, then merge.** Fix or audit several files in parallel, then pass
  the corrected files to one joining step.
- **Pipeline per item.** For each section, find its claims, then verify each
  claim.
- **Survey and decide.** Run several independent analyses that each return a
  small answer, then pick the best or hand the set to a synthesis step.

For larger work it runs several scripts in sequence, reading each result
before writing the next, and keeps any decision that is yours out of the
scripts.

A script looks like this:

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

This fixes two drafts in parallel, then reviews the corrected files together.
`Promise.allSettled` keeps the fixes that succeeded, so a failed fix is left
out of the review instead of stopping the script. Besides `program(...)`, a
script can call `agent(...)` (a helper agent), `self(...)` (the assistant
again, for example with a second model as an independent check), and any
other tool the assistant has. TeXRA records every call, so an interrupted
script resumes without repeating finished work.

A [goal](./configuration.md#goal-mode) is itself such a script: a loop of
rounds, each checked by a judge, until no requirement fails, a round needs
you, or the spend cap is reached.

## What a run looks like

1. **One approval for the script.** Before anything runs, the script is shown
   as a request with its title and full source. Approving it covers every
   helper and program the script starts. **Approve** (`y`) runs it; the ▾ next
   to it offers **Approve all agent work in this task** (`a`), which also
   stops asking about later agent work, file edits, and shell commands in the
   task. **Reject** (`n`) declines, and **Add a note…** tells the assistant
   what to change. A helper or program started outside a script asks for its
   own approval.
2. **Calls grouped by section.** The script's card holds one card per call,
   grouped by the section that was current when the call was made. Each shows
   the helper or program and its model, the files it was handed, and its
   status: running, finished, reused (an identical call already finished, so
   nothing ran again), skipped, or failed. A finished call adds its elapsed
   time and cost. When a child is waiting on you, such as a file edit to
   approve, **Review** takes you to it.
3. **Open a child run.** A call's card opens the child run it launched, with
   its own transcript.
4. **Skip a call.** Stopping a child run skips its call; the script then
   carries on or stops, depending on how it handles failures. A skipped call
   is not retried for you; ask the assistant if you want it redone.
5. **A result when it finishes.** The assistant receives the script's return
   value and its last log lines. A program's outputs land in run storage; the
   assistant reviews them and brings them into the workspace with your
   approval.

<CliSubagentsHero />

<p class="hero-caption">A chat in the CLI. The helpers a script starts appear in this same subagent panel, each as a focusable stream with its own transcript.</p>

## Background scripts

A script normally runs as one of the assistant's tool calls, and the
assistant waits for it. It can also run a script in the background: the
assistant keeps working, and the result arrives as one follow-up with a
summary line (calls that succeeded out of the total, cost, duration, and the
files produced). Stopping that background run stops the script and its
children. In a one-shot `texra run` the script always runs in the
foreground.

## Resume

Every call a script makes is recorded as it finishes. If the app restarts or
the run is interrupted, the script runs again from the top against those
records: calls that finished are handed back and are not run or billed again,
and only unfinished calls run.

A finished call is also reused by a later identical call in the same run,
matched on its prompt, options, and the contents of its files. So when a
script fails partway, the assistant fixes the code and sends it again:
everything that already finished comes back as **Reused** at no cost. Editing
one of a call's files makes that call run again.

In the CLI, `texra resume <id>` continues a stopped run, a background script
run included. Read [Execution history](./texra-cli.md#execution-history).

## Limits

- A script starts at most 1000 agents. Reused calls do not count.
- **Agents at once** (**Settings → Agents → Advanced**, or `/config` in the
  terminal chat) sets how many agents one task runs at once; by default it
  follows the machine's CPU count.
- The script's own code gets 30 seconds of CPU and 64 MB of memory. Time spent
  waiting on agents does not count, so this only stops a loop that never
  waits.
- The wall clock defaults to 60 minutes and can be raised to 24 hours.
- Each call may carry a spend cap in USD; past it, the child is stopped.

## Turning it off

The **Multi-Agent Workflow** switch on **Settings → Plugins** (or its row in
`/plugins` in the terminal chat) lets the assistant start helper agents and
programs. It is on by default. When it is off, the assistant does all the
work itself, and you can still start a program with `texra run`.

In a headless `texra run`, no approval prompt can be shown, so the approval
policy you pass decides the script request and what its helpers may edit or
execute.

## Troubleshooting

**The assistant never delegates.** Check the **Multi-Agent Workflow** switch.
If it is on, ask for it: "split this across helpers, one per section".

**The script stopped with a wall-clock timeout.** A large fan-out on a slow
model can exceed 60 minutes. Ask the assistant to send the script again with a
longer timeout, or in the background; the calls that finished are reused.

**"The script used its 30000ms CPU budget".** The script's own code ran for 30
seconds, which almost always means a loop that never waits on a call. Ask the
assistant to fix the loop and send the script again.

**"Another agent call of this script has the same prompt, options and
files".** Two calls would do exactly the same work, usually a retry loop or a
panel of identical voters. Ask the assistant to give each call its own angle.

**A call shows Failed and the script went on.** The script caught the failure.
Open the failed call's child run to read why, and ask the assistant to retry
it; a failed call is not reused, so sending the script again retries it.

## Next steps

- [The assistant and programs](./programs.md): the programs a script can start
- [Programs: how they work](./agent-architecture.md): what one document program does
- [Agent integrations](./agent-integrations.md): Codex, Claude Code and MCP servers
