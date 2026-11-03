# Harness real-model acceptance: status

The real-model half of the 1.0 acceptance in
[the harness 1.0 PRD](../../proposed/architecture/2026-10-28-harness-1-release-prd.md):
"真实模型验收至少覆盖两条受支持的模型路线". The routes, by the owner's ruling of
2026-11-03, are Anthropic and DeepSeek. No budget is set, so only small manual
runs are allowed and nothing runs in CI.

**No route has passed yet.** As of 2026-11-03, no run has reached a model:

- DeepSeek: the account behind `DEEPSEEK_API_KEY` has no credit
  (`/user/balance` reports `is_available: false`), so every request is refused
  with HTTP 402.
- Anthropic: no `ANTHROPIC_API_KEY` is set; the run waits for the owner.

Neither attempt is kept as evidence. The first run that reaches a model on a
route writes its directory here.

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

1. **Every run, each `self()` child included, sends an unrequested label
   request, outside the run's usage.** `generateSessionDescription`
   (`packages/harness/src/agent/runtime/sessionDescription.ts`) sends a helper
   request on the run's model for every run with an instruction, with no way to
   turn it off, and its spend is not in the run's `usage` or `runs.cost`.
   Since #14607 only a root run of a composition that asks
   (`processLayer({ labelRuns: true })`) is labelled, and the label's priced
   request now rides its `run.description` row, so the run's `usage` and
   `runs.cost` both count it and agree.
2. **The harness writes its log lines to the embedder's stdout**
   (`[agentRegistry] Loaded 1 agents`, `[executeAgent] Starting run`, the
   route's effort substitution note), so a program printing its own output
   gets them mixed in.
3. **A plugin tool that waits needs `slow: true` to be seen waiting.** Without
   it the call's card opens only when the call ends; `slow` is documented in
   one line on `ToolDefinition` only.

DeepSeek's out-of-credit 402 was read as an unexpected error; that is fixed
(#14606).
