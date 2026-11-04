# Harness real-model acceptance: status

The real-model half of the 1.0 acceptance in
[the harness 1.0 PRD](../../proposed/architecture/2026-10-28-harness-1-release-prd.md):
"真实模型验收至少覆盖两条受支持的模型路线". The routes, by the owner's ruling of
2026-11-03, are Anthropic and DeepSeek. No budget is set, so only small manual
runs are allowed and nothing runs in CI.

**DeepSeek has passed; Anthropic has not run.** As of 2026-11-03:

- DeepSeek (`deepseek/deepseek-flash`): every scenario passed, three times, on the
  build of #14623. The first run that reached the model, on `171aa36b38`,
  failed two of three; the fixes are in findings 4 and 5 below.
- Anthropic: no `ANTHROPIC_API_KEY` is set; the run waits for the owner.

## Runs

The raw records are kept in the history of #14623 at
[`95980f4a90`](https://github.com/LionSR/TeXRA/tree/95980f4a90fa6cb5377eaa22be5b6820e79b4c5a/.agents/docs/evidence/2026-11-03-harness-real-model),
not in the current tree. Each linked `summary.md` names `171aa36b38`, the commit
the worktree was on; the runs after the first packed that commit with #14623's
changes on top, uncommitted. Runs on intermediate versions of the fix are not
kept.

| Run                            | Harness                | codemode | plugin | crash-resume  | Spend (USD) |
| ------------------------------ | ---------------------- | -------- | ------ | ------------- | ----------- |
| `deepseek-deepseek-flash-1931` | `171aa36b38`           | fail     | pass   | fail          | 0.0144      |
| `deepseek-deepseek-flash-2016` | #14623, earlier runner | pass     | pass   | pass          | 0.0124      |
| `deepseek-deepseek-flash-2018` | #14623, earlier runner | pass     | pass   | fail (runner) | 0.0134      |
| `deepseek-deepseek-flash-2021` | #14623, earlier runner | pass     | pass   | pass          | 0.0129      |
| `deepseek-deepseek-flash-2137` | #14623                 | pass     | pass   | pass          | 0.0123      |

Run `2018`'s crash-resume failed on the runner's checks, not the harness's
behavior: the model first tried `self()` out in a separate script, and the
runner counted that probe's child as a round and judged the first script as
the interrupted one. The resumed run completed, the committed children did not
run again, and the interrupted script finished. The runner now follows the
script of the run itself that was open at the kill (finding 6).

## What the runner covers

[`packages/harness/example/acceptance.ts`](../../../../packages/harness/example/acceptance.ts),
with the evidence writer
[`_evidence.ts`](../../../../packages/harness/example/_evidence.ts), installs
the packed packages like the packed-example ladder and uses the public entries
only. Each scenario states a task in plain words and the model writes the
programs itself; the checks read outcomes, calls, child runs, facts and
artifacts, never exact text or request counts.

- `codemode`: from an agent file, outline a draft through a plugin's script
  module, run two `self()` review rounds (the second chosen from the first's
  structured verdict), and count the finished children with `executions` SQL
  over `runs`.
- `plugin`: the `acme-notes` package's agent, its `note_add` tool and its
  `builtIn:notes` module.
- `crash-resume`: a second process is killed with SIGKILL once a `self()`
  child's result is committed and the script waits on a sign-off; this process
  resumes the run, the committed child does not run again, and the run
  completes.

## How to run it

```bash
TEXRA_EXAMPLE_MODEL=deepseek/deepseek-flash \
  corepack pnpm --filter @texra-ai/harness run example:acceptance
TEXRA_EXAMPLE_MODEL=anthropic/claude-haiku-5-5 \
  corepack pnpm --filter @texra-ai/harness run example:acceptance
```

Each run writes `<provider>-<model>-<HHMM>/` here: `summary.md`, `run.json`,
and per scenario the config, the scripts the model wrote, the conversations,
the tool calls, the outputs and the failed checks; the session database goes
to a git-ignored `store/`. The format is in the
[example README](../../../../packages/harness/example/README.md#real-model-acceptance).

## Findings

From the attempts and from checking the runner on the in-memory model:

1. **Every run, each `self()` child included, sent an unrequested label
   request, outside the run's usage.** Only a root run is labelled now, and
   only when the composition asks for it (#14607); the label's spend is counted
   in the run's usage (#14621).
2. **The harness wrote its log lines to the embedder's stdout.** Fixed: an
   embedder's logger decides where the harness logs (#14608).
3. **A plugin tool that waits needs `slow: true` to be seen waiting.** Without
   it the call's card opens only when the call ends; `slow` is documented in
   one line on `ToolDefinition` only. Open.
4. **A `self()` child could not tell its part from its parent's task.** Forked,
   the child's first message was the parent's request with the `self()` prompt
   appended as one more paragraph; fresh, it was the prompt alone, with the
   parent's tools. On `171aa36b38` the crash-resume children each ran the whole
   task again, `self()` rounds included, four levels deep, and one called the
   parent's `await_signoff` itself. Fixed in #14623: the child reads its
   prompt inside `<task>` under a note that a script of its own started it for
   one part of the work (`selfTask`, `packages/harness/src/tools/codemode/SelfTool.ts`).
5. **A plugin's script module was named nowhere the model reads.** The `script`
   description said a module is imported by "the specifier a description
   names", and nothing named `builtIn:notes`; a run passed only when the model
   probed `import()` and read the error, which lists what is offered. Fixed in
   #14623: the description lists the modules the step's scripts may import.
6. **The runner's checks assumed the model writes one script.** DeepSeek tries
   the functions out first, and sometimes runs a last script that only checks
   a count. Codemode now judges the last script that returned the asked-for
   object, and crash-resume the script open at the kill.

DeepSeek's out-of-credit 402 was read as an unexpected error; that is fixed
(#14606). DeepSeek also tends to call `self()` with one object
(`self({ prompt, schema })`) before the positional form; the call fails with a
validation error naming `prompt` and the model recovers.
